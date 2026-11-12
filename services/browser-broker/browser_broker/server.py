from __future__ import annotations

import asyncio
import grp
import json
import os
import re
from typing import Any, Dict, Tuple

from . import events
from .cdp import CdpError
from .manager import BrokerError, Manager
from .platform import CachedIdentity, PlatformError
from .validation import FILE_ID, SESSION_ID, bearer, selector_ok

MAX_BODY = 16 * 1024
ROUTE = re.compile(r"^/v1/sessions/([a-f0-9]{32})(?:/(upload|waiting|touch|close))?$")

PLATFORM_STATUS = {"unauthorized": (401, "unauthorized"), "not_found": (404, "not_found"),
                   "too_large": (413, "file_too_large"), "unavailable": (502, "platform_unavailable")}
CDP_STATUS = {"not_found": (400, "selector_not_found"), "not_file_input": (400, "not_a_file_input"),
              "cdp_failed": (502, "browser_error"), "unavailable": (502, "browser_unavailable")}


class Api:
    """Routes one request to the manager. Knows HTTP shapes; holds no policy of its own."""

    def __init__(self, manager: Manager, platform, identity: CachedIdentity):
        self.m = manager
        self.platform = platform
        self.identity = identity

    async def handle(self, method: str, path: str, headers: Dict[str, str], body: Any) -> Tuple[int, Dict[str, Any]]:
        try:
            return await self._route(method, path, headers, body)
        except BrokerError as error:
            return error.status, {"error": error.code}
        except PlatformError as error:
            status, code = PLATFORM_STATUS[error.kind]
            return status, {"error": code}
        except CdpError as error:
            status, code = CDP_STATUS.get(error.kind, (502, "browser_error"))
            return status, {"error": code}

    async def _route(self, method, path, headers, body):
        if path == "/v1/health" and method == "GET":
            return 200, dict(self.m.counts(), ok=True)
        if path == "/v1/sessions" and method == "POST":
            key, user = await self._who(headers)
            s = await self.m.create(user)
            return 201, self.m.view(s)
        match = ROUTE.match(path)
        if not match:
            return 404, {"error": "not_found"}
        sid, action = match.group(1), match.group(2)
        key, user = await self._who(headers)
        if action is None and method == "GET":
            return 200, self.m.view(self.m.owned(sid, user))
        if method != "POST" or action is None:
            return 405, {"error": "method_not_allowed"}
        data = body if isinstance(body, dict) else {}
        if action == "touch":
            return 200, self.m.view(self.m.touch(sid, user))
        if action == "waiting":
            if not isinstance(data.get("waiting"), bool):
                raise BrokerError("bad_request", 400)
            return 200, self.m.view(self.m.set_waiting(sid, user, data["waiting"]))
        if action == "close":
            await self.m.close(sid, user)
            return 200, {"closed": True}
        # upload
        file_id, selector = data.get("fileId"), data.get("selector")
        if not (isinstance(file_id, str) and FILE_ID.match(file_id)) or not selector_ok(selector):
            raise BrokerError("bad_request", 400)
        await self.m.upload(sid, user, key, file_id, selector, self.platform)
        return 200, {"uploaded": True}

    async def _who(self, headers: Dict[str, str]):
        key = bearer(headers.get("authorization", ""))
        if not key:
            raise BrokerError("unauthorized", 401)
        return key, await self.identity.user_for(key)


REASONS = {200: "OK", 201: "Created", 400: "Bad Request", 401: "Unauthorized", 404: "Not Found",
           405: "Method Not Allowed", 408: "Request Timeout", 409: "Conflict", 413: "Payload Too Large",
           429: "Too Many Requests", 431: "Request Header Fields Too Large", 500: "Internal Server Error",
           502: "Bad Gateway", 503: "Service Unavailable"}


async def _respond(writer, status: int, payload: Dict[str, Any]) -> None:
    body = json.dumps(payload).encode("utf-8")
    head = "HTTP/1.1 %d %s\r\nContent-Type: application/json\r\nContent-Length: %d\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n" % (
        status, REASONS.get(status, "Error"), len(body))
    writer.write(head.encode("ascii") + body)
    await writer.drain()


async def _read_request(reader):
    raw = await reader.readuntil(b"\r\n\r\n")
    lines = raw.decode("latin-1").split("\r\n")
    parts = lines[0].split(" ")
    if len(parts) != 3 or not parts[2].startswith("HTTP/1."):
        raise BrokerError("bad_request", 400)
    headers: Dict[str, str] = {}
    for line in lines[1:]:
        if not line:
            continue
        name, sep, value = line.partition(":")
        if not sep or len(headers) >= 50:
            raise BrokerError("bad_request", 400)
        headers[name.strip().lower()] = value.strip()
    if "transfer-encoding" in headers:
        raise BrokerError("bad_request", 400)
    length = headers.get("content-length", "0")
    if not length.isdigit() or int(length) > MAX_BODY:
        raise BrokerError("body_too_large", 413)
    body: Any = None
    if int(length):
        try:
            body = json.loads((await reader.readexactly(int(length))).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise BrokerError("bad_request", 400)
    return parts[0], parts[1].split("?")[0], headers, body


def make_handler(api: Api, timeout: float):
    async def handler(reader, writer):
        try:
            try:
                method, path, headers, body = await asyncio.wait_for(_read_request(reader), 15)
                status, payload = await asyncio.wait_for(api.handle(method, path, headers, body), timeout)
            except BrokerError as error:
                status, payload = error.status, {"error": error.code}
            except (asyncio.LimitOverrunError, asyncio.IncompleteReadError):
                status, payload = 400, {"error": "bad_request"}
            except asyncio.TimeoutError:
                status, payload = 408, {"error": "timeout"}
            except Exception as error:  # never leak details to the caller
                events.event("internal_error", error=type(error).__name__)
                status, payload = 500, {"error": "internal_error"}
            await _respond(writer, status, payload)
        except (ConnectionError, asyncio.CancelledError):
            pass
        finally:
            try:
                writer.close()
            except Exception:
                pass

    return handler


async def serve(api: Api, socket_path: str, group: str, timeout: float):
    os.makedirs(os.path.dirname(socket_path), exist_ok=True)
    try:
        gid = grp.getgrnam(group).gr_gid
    except KeyError:
        gid = -1
    try:
        os.unlink(socket_path)
    except FileNotFoundError:
        pass
    server = await asyncio.start_unix_server(make_handler(api, timeout), path=socket_path, limit=16 * 1024)
    if gid != -1:
        os.chown(socket_path, -1, gid)
    os.chmod(socket_path, 0o660)
    return server
