from __future__ import annotations

import os
import tempfile

from browser_broker.cdp import CdpError
from browser_broker.config import Config
from browser_broker.docker_runner import DockerError
from browser_broker.platform import PlatformError

KEY_A = "key-user-a-0123456789abcdef"
KEY_B = "key-user-b-0123456789abcdef"


class Clock:
    def __init__(self, start: float = 1_000_000.0):
        self.t = start

    def __call__(self) -> float:
        return self.t

    async def sleep(self, seconds: float) -> None:
        self.t += seconds


def make_config(**over) -> Config:
    base = dict(
        image="sha256:" + "a" * 64,
        seccomp_sha256="b" * 64,
        platform_url="https://platform.example",
        state_dir=tempfile.mkdtemp(prefix="bb-test-"),
        queue_wait_s=1,
    )
    base.update(over)
    return Config(**base)


class FakeDocker:
    def __init__(self):
        self.started = []
        self.removed = []
        self.labeled = []
        self.fail_start = False
        self.fail_remove = False
        self.mem = 150.0

    async def start(self, sid, deadline, uploads_dir):
        if self.fail_start:
            raise DockerError("boom")
        self.started.append((sid, deadline, uploads_dir))
        return "cid-" + sid

    async def ip(self, sid):
        return "172.30.0.2"

    async def remove(self, sid):
        if self.fail_remove:
            raise DockerError("cannot remove")
        self.removed.append("bb-" + sid)

    async def remove_name(self, name):
        self.removed.append(name)

    async def list_labeled(self):
        return list(self.labeled)

    async def memory_mb(self, sid):
        return self.mem


class FakeCdp:
    def __init__(self):
        self.is_ready = True
        self.calls = []
        self.error = None

    async def ready(self, ip):
        return self.is_ready

    async def submit(self, ip, selector, text, timeout=45.0):
        if self.error:
            raise CdpError(self.error)
        self.submits = getattr(self, "submits", [])
        self.submits.append((ip, selector, text))
        return {"url": "https://example.test/done", "urlBefore": "https://example.test/form", "title": "Thank you",
                "text": "Thank you for applying", "truncated": False, "invalid": [], "changed": True, "clicked": "Submit order"}

    async def screenshot(self, ip, timeout=30.0):
        if getattr(self, "shot_error", False):
            raise CdpError("cdp_failed")
        return b"\xff\xd8\xff\xe0fake-jpeg"

    async def browser_ws_path(self, ip):
        return "/devtools/browser/aaaa-bbbb-cccc"

    async def set_file_input(self, ip, selector, paths, timeout=30.0):
        if self.error:
            raise CdpError(self.error)
        self.calls.append((ip, selector, list(paths)))


class FakePlatform:
    def __init__(self):
        self.users = {KEY_A: "user-a", KEY_B: "user-b"}
        self.files = {("user-a", "file-aaaa-1"): ("../../etc/passwd.pdf", b"%PDF-1 a"),
                      ("user-b", "file-bbbb-1"): ("b.docx", b"docx b")}
        self.whoami_calls = 0
        self.fetch_error = None

    async def upload_proof(self, key, jpeg, caption):
        if getattr(self, "proof_error", False):
            raise PlatformError("unavailable")
        self.proofs = getattr(self, "proofs", [])
        self.proofs.append((self.users.get(key), jpeg, caption))

    async def whoami(self, key):
        self.whoami_calls += 1
        if key not in self.users:
            raise PlatformError("unauthorized")
        return self.users[key]

    async def fetch_file(self, key, file_id, max_bytes):
        if self.fetch_error:
            raise PlatformError(self.fetch_error)
        user = self.users.get(key)
        item = self.files.get((user, file_id))
        if not item:
            raise PlatformError("not_found")
        if len(item[1]) > max_bytes:
            raise PlatformError("too_large")
        return item


class FakeRelay:
    instances = []

    def __init__(self, host, port, path, on_activity):
        self.host, self.port, self.path, self.on_activity = host, port, path, on_activity
        self.stopped = False
        self.fail = False
        FakeRelay.instances.append(self)

    async def start(self):
        if FakeRelay.fail_next:
            FakeRelay.fail_next = False
            raise OSError("no port")
        return 45678

    async def stop(self):
        self.stopped = True


FakeRelay.fail_next = False
