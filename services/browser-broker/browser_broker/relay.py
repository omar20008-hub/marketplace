from __future__ import annotations

import asyncio
import hmac
from typing import Callable, List, Optional, Set

MAX_HEAD = 8192
HEAD_TIMEOUT_S = 10
CONNECT_TIMEOUT_S = 5


class Relay:
    """
    A loopback door to one session's browser. It accepts exactly one thing: a WebSocket upgrade to
    the browser's own DevTools path (/devtools/browser/<uuid>, which Chrome makes up at random and only
    the session's owner is given). Everything else, including /json/* which would reveal that path, gets
    a 404. After the upgrade it moves bytes both ways without reading them and reports activity.

    Why it exists: the host firewall keeps every local user except root away from the containers, so the
    broker (root) carries the connection. The path is the secret that keeps one person's assistant out of
    another's session, because they all run as the same operating-system user.
    """

    def __init__(self, upstream_host: str, upstream_port: int, ws_path: str,
                 on_activity: Callable[[], None], host: str = "127.0.0.1"):
        self.upstream_host = upstream_host
        self.upstream_port = upstream_port
        self.ws_path = ws_path
        self.on_activity = on_activity
        self.host = host
        self.port = 0
        self._server: Optional[asyncio.AbstractServer] = None
        self._tasks: Set[asyncio.Task] = set()
        self._writers: List[asyncio.StreamWriter] = []

    async def start(self) -> int:
        self._server = await asyncio.start_server(self._handle, self.host, 0, limit=MAX_HEAD * 2)
        self.port = self._server.sockets[0].getsockname()[1]
        return self.port

    async def stop(self) -> None:
        server, self._server = self._server, None
        if server:
            server.close()                       # no new connections
        for writer in list(self._writers):
            self._close(writer)
        for task in list(self._tasks):
            task.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks.clear()
        if server:
            # Newer Python waits here for every open connection, so this comes after they are closed.
            try:
                await asyncio.wait_for(server.wait_closed(), 5)
            except asyncio.TimeoutError:
                pass

    # ------------------------------------------------------------------ one connection
    def _forward_head(self, head: bytes) -> Optional[bytes]:
        """The request to pass on, or None when this is not the one allowed upgrade."""
        lines = head.decode("latin-1").split("\r\n")
        parts = lines[0].split(" ")
        if len(parts) != 3 or parts[0] != "GET" or not parts[2].startswith("HTTP/1."):
            return None
        if not hmac.compare_digest(parts[1].encode("latin-1"), self.ws_path.encode("latin-1")):
            return None
        headers = {}
        kept = []
        for line in lines[1:]:
            if not line:
                continue
            name, sep, value = line.partition(":")
            if not sep:
                return None
            lower = name.strip().lower()
            headers[lower] = value.strip().lower()
            # Chrome answers only to an IP or localhost host name, and refuses a page origin; this is a
            # local client, so present it as one.
            if lower in ("host", "origin"):
                continue
            kept.append("%s: %s" % (name.strip(), value.strip()))
        if headers.get("upgrade") != "websocket" or "upgrade" not in headers.get("connection", ""):
            return None
        out = [lines[0], "Host: localhost"] + kept
        return ("\r\n".join(out) + "\r\n\r\n").encode("latin-1")

    @staticmethod
    def _close(writer: asyncio.StreamWriter) -> None:
        try:
            writer.close()
        except Exception:
            pass

    @staticmethod
    async def _refuse(writer: asyncio.StreamWriter, status: str = "404 Not Found") -> None:
        try:
            writer.write(("HTTP/1.1 %s\r\nContent-Length: 0\r\nConnection: close\r\n\r\n" % status).encode("ascii"))
            await writer.drain()
        except Exception:
            pass
        Relay._close(writer)

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        task = asyncio.current_task()
        if task:
            self._tasks.add(task)
        self._writers.append(writer)
        up_writer: Optional[asyncio.StreamWriter] = None
        try:
            try:
                head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), HEAD_TIMEOUT_S)
            except (asyncio.TimeoutError, asyncio.LimitOverrunError, asyncio.IncompleteReadError, ConnectionError):
                self._close(writer)
                return
            forwarded = self._forward_head(head)
            if forwarded is None:
                await self._refuse(writer)
                return
            try:
                up_reader, up_writer = await asyncio.wait_for(
                    asyncio.open_connection(self.upstream_host, self.upstream_port), CONNECT_TIMEOUT_S)
            except (OSError, asyncio.TimeoutError):
                await self._refuse(writer, "502 Bad Gateway")
                return
            self._writers.append(up_writer)
            up_writer.write(forwarded)
            await up_writer.drain()
            self.on_activity()
            pipes = [asyncio.ensure_future(self._pipe(reader, up_writer)),
                     asyncio.ensure_future(self._pipe(up_reader, writer))]
            try:
                await asyncio.wait(pipes, return_when=asyncio.FIRST_COMPLETED)
            finally:
                for pipe in pipes:
                    pipe.cancel()
                await asyncio.gather(*pipes, return_exceptions=True)
        except asyncio.CancelledError:
            pass
        finally:
            self._close(writer)
            if up_writer is not None:
                self._close(up_writer)
            for w in (writer, up_writer):
                if w in self._writers:
                    self._writers.remove(w)
            if task:
                self._tasks.discard(task)

    async def _pipe(self, src: asyncio.StreamReader, dst: asyncio.StreamWriter) -> None:
        try:
            while True:
                data = await src.read(65536)
                if not data:
                    return
                self.on_activity()
                dst.write(data)
                await dst.drain()
        except (ConnectionError, OSError):
            return
