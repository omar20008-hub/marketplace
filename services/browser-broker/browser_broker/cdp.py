from __future__ import annotations

import asyncio
import http.client
import json
import re
import urllib.parse
from typing import List


class CdpError(Exception):
    """kind: not_found | not_file_input | cdp_failed | unavailable"""

    def __init__(self, kind: str, message: str = ""):
        super().__init__(message or kind)
        self.kind = kind


async def run_upload(transport, selector: str, paths: List[str]) -> None:
    """
    Puts files into an <input type=file> through DOM.setFileInputFiles. `transport.call(method,
    params)` returns the CDP result. The paths are ones inside the container (/uploads/...).
    """
    doc = await transport.call("DOM.getDocument", {"depth": 0})
    root = doc["root"]["nodeId"]
    found = await transport.call("DOM.querySelector", {"nodeId": root, "selector": selector})
    node_id = found.get("nodeId", 0)
    if not node_id:
        raise CdpError("not_found", "selector matched nothing")
    described = await transport.call("DOM.describeNode", {"nodeId": node_id})
    node = described.get("node", {})
    attrs = node.get("attributes", [])
    pairs = dict(zip(attrs[0::2], attrs[1::2]))
    if node.get("nodeName", "").upper() != "INPUT" or pairs.get("type", "").lower() != "file":
        raise CdpError("not_file_input", "the element is not an input of type file")
    await transport.call("DOM.setFileInputFiles", {"nodeId": node_id, "files": paths})


class WsTransport:
    def __init__(self, ws):
        self.ws = ws
        self._next = 0

    async def call(self, method: str, params=None):
        self._next += 1
        ident = self._next
        await self.ws.send(json.dumps({"id": ident, "method": method, "params": params or {}}))
        while True:
            message = json.loads(await self.ws.recv())
            if message.get("id") != ident:
                continue  # an event, not our answer
            if "error" in message:
                raise CdpError("cdp_failed", message["error"].get("message", "cdp error"))
            return message.get("result", {})


def _http_json(host: str, port: int, path: str, timeout: float):
    conn = http.client.HTTPConnection(host, port, timeout=timeout)
    try:
        # Chrome answers only to a host name it trusts (an IP or localhost).
        conn.request("GET", path, headers={"Host": "localhost", "Connection": "close"})
        response = conn.getresponse()
        if response.status != 200:
            raise CdpError("unavailable", "devtools answered %d" % response.status)
        return json.loads(response.read(1 << 20))
    except (OSError, http.client.HTTPException, ValueError):
        raise CdpError("unavailable", "devtools not reachable")
    finally:
        conn.close()


class CdpClient:
    """Reaches Chrome inside a session container, at its address on the browser network."""

    def __init__(self, port: int = 9222):
        self.port = port

    async def ready(self, ip: str) -> bool:
        try:
            await asyncio.to_thread(_http_json, ip, self.port, "/json/version", 3.0)
            return True
        except CdpError:
            return False

    async def browser_ws_path(self, ip: str) -> str:
        """The browser's own WebSocket path, /devtools/browser/<uuid>: the secret the relay guards."""
        data = await asyncio.to_thread(_http_json, ip, self.port, "/json/version", 5.0)
        path = urllib.parse.urlparse(str(data.get("webSocketDebuggerUrl", ""))).path
        if not re.match(r"^/devtools/browser/[A-Za-z0-9-]{8,64}$", path):
            raise CdpError("unavailable", "unexpected DevTools path")
        return path

    async def set_file_input(self, ip: str, selector: str, paths: List[str], timeout: float = 30.0) -> None:
        import websockets  # imported here: the rest of the broker, and its tests, do not need it

        targets = await asyncio.to_thread(_http_json, ip, self.port, "/json/list", 5.0)
        pages = [t for t in targets if t.get("type") == "page" and t.get("webSocketDebuggerUrl")]
        if not pages:
            raise CdpError("unavailable", "no page is open")
        path = urllib.parse.urlparse(pages[0]["webSocketDebuggerUrl"]).path
        url = "ws://%s:%d%s" % (ip, self.port, path)

        async def go():
            async with websockets.connect(url, max_size=1 << 20, open_timeout=10, ping_interval=None) as ws:
                await run_upload(WsTransport(ws), selector, paths)

        try:
            await asyncio.wait_for(go(), timeout)
        except asyncio.TimeoutError:
            raise CdpError("cdp_failed", "devtools timed out")
        except OSError:
            raise CdpError("unavailable", "devtools connection lost")
