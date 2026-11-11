from __future__ import annotations

import asyncio
import hashlib
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Callable, Dict, Tuple


class PlatformError(Exception):
    """kind: unauthorized | not_found | too_large | unavailable"""

    def __init__(self, kind: str):
        super().__init__(kind)
        self.kind = kind


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """A redirect would send the agent key to another address; refuse to follow any."""

    def redirect_request(self, *args, **kwargs):
        return None


class PlatformClient:
    """
    Asks the platform who a key belongs to and for that person's files. The platform
    decides what belongs to whom; the broker never sees a path or a user name from a caller.
    Requires on the platform side: GET /api/agent/whoami -> {"userId": "..."} and
    GET /api/agent/files/{id} -> the bytes, with the header X-File-Name (URL-encoded UTF-8).
    """

    def __init__(self, base_url: str, timeout: float = 20.0):
        self.base = base_url.rstrip("/")
        self.timeout = timeout
        self._opener = urllib.request.build_opener(_NoRedirect)

    def _get(self, path: str, key: str, max_bytes: int) -> Tuple[bytes, Dict[str, str]]:
        request = urllib.request.Request(
            self.base + path, headers={"Authorization": "Bearer " + key, "Accept": "*/*"}
        )
        try:
            with self._opener.open(request, timeout=self.timeout) as response:
                declared = response.headers.get("Content-Length")
                if declared and declared.isdigit() and int(declared) > max_bytes:
                    raise PlatformError("too_large")
                body = response.read(max_bytes + 1)
                if len(body) > max_bytes:
                    raise PlatformError("too_large")
                return body, {k.lower(): v for k, v in response.headers.items()}
        except urllib.error.HTTPError as error:
            if error.code in (401, 403):
                raise PlatformError("unauthorized")
            if error.code == 404:
                raise PlatformError("not_found")
            raise PlatformError("unavailable")
        except (urllib.error.URLError, OSError):
            raise PlatformError("unavailable")

    async def whoami(self, key: str) -> str:
        import json

        body, _ = await asyncio.to_thread(self._get, "/api/agent/whoami", key, 4096)
        try:
            user_id = json.loads(body.decode("utf-8")).get("userId")
        except (ValueError, AttributeError):
            raise PlatformError("unavailable")
        if not isinstance(user_id, str) or not user_id:
            raise PlatformError("unavailable")
        return user_id

    async def fetch_file(self, key: str, file_id: str, max_bytes: int) -> Tuple[str, bytes]:
        path = "/api/agent/files/" + urllib.parse.quote(file_id, safe="")
        body, headers = await asyncio.to_thread(self._get, path, key, max_bytes)
        name = urllib.parse.unquote(headers.get("x-file-name", "")) or "file"
        return name, body


class CachedIdentity:
    """key -> user id, for a short time, held under a hash so the key itself is never stored."""

    def __init__(self, platform, ttl: float = 60.0, clock: Callable[[], float] = time.time):
        self.platform = platform
        self.ttl = ttl
        self.clock = clock
        self._seen: Dict[str, Tuple[str, float]] = {}

    async def user_for(self, key: str) -> str:
        token = hashlib.sha256(key.encode("utf-8")).hexdigest()
        hit = self._seen.get(token)
        now = self.clock()
        if hit and hit[1] > now:
            return hit[0]
        user_id = await self.platform.whoami(key)
        if len(self._seen) > 1000:
            self._seen = {k: v for k, v in self._seen.items() if v[1] > now}
        self._seen[token] = (user_id, now + self.ttl)
        return user_id
