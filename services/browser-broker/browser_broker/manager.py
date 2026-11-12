from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import os
import secrets
import shutil
import time
from typing import Any, Callable, Dict, List, Optional

from . import events
from .cdp import CdpError
from .config import Config
from .docker_runner import DockerError, container_name
from .validation import sanitize_filename

ACTIVE = ("queued", "starting", "ready")
SAMPLE_EVERY_S = 15


class BrokerError(Exception):
    def __init__(self, code: str, status: int = 400):
        super().__init__(code)
        self.code = code
        self.status = status


class Session:
    def __init__(self, session_id: str, uid: str, now: float):
        self.id = session_id
        self.uid = uid                       # HMAC of the user id; the id itself is never kept
        self.state = "queued"
        self.created = now
        self.started = 0.0
        self.last_activity = now
        self.last_sample = 0.0
        self.waiting = False
        self.uploads = 0
        self.ip = ""
        self.reason = ""
        self.closed_at = 0.0
        self.mem_peak = 0.0
        self.holds_slot = False
        self.lock = asyncio.Lock()

    def record(self) -> Dict[str, Any]:
        return {
            "id": self.id, "uid": self.uid, "state": self.state, "created": self.created,
            "started": self.started, "closed_at": self.closed_at, "reason": self.reason,
            "mem_peak_mb": round(self.mem_peak, 1), "uploads": self.uploads,
        }


class Manager:
    def __init__(
        self,
        cfg: Config,
        docker,
        cdp,
        hmac_key: bytes,
        clock: Callable[[], float] = time.time,
        sleep: Callable[[float], Any] = asyncio.sleep,
    ):
        self.cfg = cfg
        self.docker = docker
        self.cdp = cdp
        self.key = hmac_key
        self.clock = clock
        self.sleep = sleep
        self.sessions: Dict[str, Session] = {}
        self.sessions_dir = os.path.join(cfg.state_dir, "sessions")
        self.state_path = os.path.join(cfg.state_dir, "sessions.json")
        self._slots = asyncio.Semaphore(cfg.max_concurrent)
        self._admit = asyncio.Lock()
        self._queued = 0

    # ------------------------------------------------------------------ identity
    def uid_hash(self, user_id: str) -> str:
        return hmac.new(self.key, user_id.encode("utf-8"), hashlib.sha256).hexdigest()[:16]

    # ------------------------------------------------------------------ state
    def _persist(self) -> None:
        try:
            os.makedirs(self.cfg.state_dir, exist_ok=True)
            tmp = self.state_path + ".tmp"
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump([s.record() for s in self.sessions.values() if s.state != "queued"], handle)
            os.replace(tmp, self.state_path)
        except OSError as error:
            events.event("persist_failed", error=type(error).__name__)

    def load(self) -> None:
        """Closed sessions come back (for the daily quota); anything that was live is closed: it is not resumed."""
        try:
            with open(self.state_path, "r", encoding="utf-8") as handle:
                rows = json.load(handle)
        except (OSError, ValueError):
            return
        now = self.clock()
        for row in rows:
            try:
                s = Session(row["id"], row["uid"], row["created"])
            except (KeyError, TypeError):
                continue
            s.started = row.get("started", 0.0)
            s.state = "closed"
            s.closed_at = row.get("closed_at") or (now if row.get("state") in ACTIVE else 0.0)
            s.reason = row.get("reason") or "broker_restart"
            s.mem_peak = row.get("mem_peak_mb", 0.0)
            s.uploads = row.get("uploads", 0)
            self.sessions[s.id] = s
        self._persist()

    def _started_since(self, uid: str, since: float) -> int:
        return sum(1 for s in self.sessions.values() if s.uid == uid and s.started and s.started >= since)

    def _dir(self, session_id: str) -> str:
        return os.path.join(self.sessions_dir, session_id)

    # ------------------------------------------------------------------ create
    async def create(self, user_id: str) -> Session:
        uid = self.uid_hash(user_id)
        async with self._admit:
            if any(s.uid == uid and s.state in ACTIVE for s in self.sessions.values()):
                raise BrokerError("user_busy", 429)
            if self._started_since(uid, self.clock() - 86400) >= self.cfg.per_user_daily:
                raise BrokerError("quota_exceeded", 429)
            if self._queued >= self.cfg.queue_max:
                events.event("busy", uid=uid, queued=self._queued)
                raise BrokerError("busy", 503)
            session = Session(secrets.token_hex(16), uid, self.clock())
            self.sessions[session.id] = session
            self._queued += 1
        try:
            await asyncio.wait_for(self._slots.acquire(), self.cfg.queue_wait_s)
        except BaseException as error:
            self.sessions.pop(session.id, None)
            if isinstance(error, asyncio.TimeoutError):
                events.event("busy", uid=uid, queued=self._queued)
                raise BrokerError("busy", 503)
            raise
        finally:
            self._queued -= 1
        session.holds_slot = True

        try:
            now = self.clock()
            session.state = "starting"
            session.started = now
            session.last_activity = now
            os.makedirs(self._dir(session.id), exist_ok=True)
            uploads = os.path.join(self._dir(session.id), "uploads")
            os.makedirs(uploads, exist_ok=True)
            os.chmod(self._dir(session.id), 0o755)
            os.chmod(uploads, 0o755)
            self._persist()
            await self.docker.start(session.id, now + self.cfg.cap_s, uploads)
            session.ip = await self.docker.ip(session.id)
            await self._wait_ready(session)
        except BaseException as error:
            await self._finish(session, "start_failed")
            if isinstance(error, asyncio.CancelledError):
                raise
            events.event("start_failed", session=session.id, error=type(error).__name__)
            raise BrokerError("start_failed", 502)
        session.state = "ready"
        session.last_activity = self.clock()
        self._persist()
        events.event("created", session=session.id, uid=uid)
        return session

    async def _wait_ready(self, session: Session) -> None:
        deadline = self.clock() + self.cfg.start_timeout_s
        while True:
            if await self.cdp.ready(session.ip):
                return
            if self.clock() >= deadline:
                raise asyncio.TimeoutError()
            await self.sleep(0.5)

    # ------------------------------------------------------------------ use
    def owned(self, session_id: str, user_id: str) -> Session:
        s = self.sessions.get(session_id)
        # Unknown, closed, or someone else's: the same answer, so ids reveal nothing.
        if not s or s.state == "closed" or s.uid != self.uid_hash(user_id):
            raise BrokerError("not_found", 404)
        return s

    def view(self, s: Session) -> Dict[str, Any]:
        now = self.clock()
        return {
            "id": s.id, "state": s.state, "waiting": s.waiting, "uploads": s.uploads,
            "secondsLeft": max(0, int(s.started + self.cfg.cap_s - now)) if s.started else None,
        }

    def touch(self, session_id: str, user_id: str) -> Session:
        s = self.owned(session_id, user_id)
        s.last_activity = self.clock()
        return s

    def set_waiting(self, session_id: str, user_id: str, waiting: bool) -> Session:
        s = self.touch(session_id, user_id)
        s.waiting = bool(waiting)
        return s

    async def upload(self, session_id: str, user_id: str, key: str, file_id: str, selector: str, platform) -> None:
        s = self.owned(session_id, user_id)
        if s.state != "ready":
            raise BrokerError("not_ready", 409)
        async with s.lock:
            if s.state != "ready":
                raise BrokerError("not_ready", 409)
            if s.uploads >= self.cfg.max_uploads_per_session:
                raise BrokerError("too_many_uploads", 429)
            name, data = await platform.fetch_file(key, file_id, self.cfg.max_upload_bytes)
            number = s.uploads + 1
            folder = os.path.join(self._dir(s.id), "uploads", str(number))
            os.makedirs(folder, exist_ok=True)
            os.chmod(folder, 0o755)
            target = os.path.join(folder, sanitize_filename(name))
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o444)
            with os.fdopen(fd, "wb") as handle:
                handle.write(data)
            inside = "/uploads/%d/%s" % (number, os.path.basename(target))
            try:
                await self.cdp.set_file_input(s.ip, selector, [inside])
            except BaseException:
                shutil.rmtree(folder, ignore_errors=True)
                raise
            s.uploads = number
            s.last_activity = self.clock()
            events.event("upload", session=s.id, uid=s.uid, file_id=file_id, size=len(data))

    # ------------------------------------------------------------------ close
    async def close(self, session_id: str, user_id: str) -> None:
        s = self.owned(session_id, user_id)
        await self._finish(s, "closed_by_user")

    async def _finish(self, s: Session, reason: str) -> None:
        if s.state in ("closing", "closed"):
            return
        s.state = "closing"
        try:
            await self.docker.remove(s.id)
        except DockerError as error:
            # The reconciler retries: the container carries our label.
            events.event("remove_failed", session=s.id, error=type(error).__name__)
        shutil.rmtree(self._dir(s.id), ignore_errors=True)
        if s.holds_slot:
            s.holds_slot = False
            self._slots.release()
        s.state = "closed"
        s.reason = reason
        s.closed_at = self.clock()
        self._persist()
        events.event(
            "closed", session=s.id, uid=s.uid, reason=reason, uploads=s.uploads,
            duration_s=int(s.closed_at - s.started) if s.started else 0,
            mem_peak_mb=round(s.mem_peak, 1),
        )

    async def close_all(self, reason: str = "shutdown") -> None:
        for s in list(self.sessions.values()):
            if s.state in ("starting", "ready"):
                await self._finish(s, reason)

    # ------------------------------------------------------------------ background work
    async def tick(self) -> None:
        """Deadlines and memory sampling. Called every few seconds."""
        now = self.clock()
        for s in list(self.sessions.values()):
            if s.state != "ready":
                continue
            if now - s.started > self.cfg.cap_s:
                await self._finish(s, "cap")
            elif s.waiting and now - s.last_activity > self.cfg.waiting_s:
                await self._finish(s, "waiting_timeout")
            elif not s.waiting and now - s.last_activity > self.cfg.idle_s:
                await self._finish(s, "idle_timeout")
            elif now - s.last_sample >= SAMPLE_EVERY_S:
                s.last_sample = now
                try:
                    mb = await self.docker.memory_mb(s.id)
                except DockerError:
                    mb = None
                if mb:
                    s.mem_peak = max(s.mem_peak, mb)

    async def reconcile(self) -> int:
        """Removes every container and folder of ours that no live session owns; prunes old records."""
        removed = 0
        live = {s.id for s in self.sessions.values() if s.state in ("starting", "ready", "closing")}
        for name, sid in await self.docker.list_labeled():
            if sid not in live:
                try:
                    await self.docker.remove_name(name)
                    removed += 1
                except DockerError as error:
                    events.event("remove_failed", container=name, error=type(error).__name__)
        try:
            for entry in os.listdir(self.sessions_dir):
                if entry not in live:
                    shutil.rmtree(os.path.join(self.sessions_dir, entry), ignore_errors=True)
        except FileNotFoundError:
            pass
        cutoff = self.clock() - self.cfg.closed_keep_s
        for sid in [i for i, s in self.sessions.items() if s.state == "closed" and s.closed_at and s.closed_at < cutoff]:
            del self.sessions[sid]
        if removed:
            events.event("reconciled", count=removed)
        self._persist()
        return removed

    def counts(self) -> Dict[str, int]:
        return {
            "active": sum(1 for s in self.sessions.values() if s.state in ("starting", "ready")),
            "queued": self._queued,
        }
