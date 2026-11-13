from __future__ import annotations

import asyncio
import base64
import http.client
import json
import re
import time
import urllib.parse
from typing import Any, Callable, Dict, List, Optional


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


# A button or link found by its own selector, or by its visible words, and clicked. The arguments are JSON, so
# nothing the caller sends can leave the string they are placed in.
_CLICK_JS = """(function (sel, text) {
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
  const label = (e) => norm(e.innerText || e.value || e.getAttribute('aria-label') || e.title || '');
  let el = null;
  if (sel) { try { el = document.querySelector(sel); } catch (e) { el = null; } }
  if (!el && text) {
    const t = norm(text);
    const all = Array.from(document.querySelectorAll('button, input[type=submit], input[type=button], a, [role=button]'));
    el = all.find((e) => label(e) === t) || all.find((e) => label(e).includes(t)) || null;
  }
  if (!el) return { found: false };
  el.scrollIntoView({ block: 'center' });
  const shown = (el.innerText || el.value || el.getAttribute('aria-label') || el.tagName || '').trim().slice(0, 80);
  el.click();
  return { found: true, label: shown };
})(%s, %s)"""

_STATE_JS = """(function () {
  const raw = document.body ? document.body.innerText : '';
  const text = raw.replace(/\\n{3,}/g, '\\n\\n').trim();
  const invalid = Array.from(document.querySelectorAll('input:invalid, select:invalid, textarea:invalid')).slice(0, 10)
    .map((e) => e.name || e.id || e.type || e.tagName);
  return { url: location.href, title: document.title, text: text.slice(0, %d), truncated: text.length > %d,
           invalid: invalid, ready: document.readyState };
})()"""

MAX_PAGE_TEXT = 2500
MAX_SHOT_BYTES = 4 * 1024 * 1024


async def _evaluate(transport, expression: str) -> Any:
    result = await transport.call("Runtime.evaluate", {"expression": expression, "returnByValue": True})
    if result.get("exceptionDetails"):
        raise CdpError("cdp_failed", "the page script failed")
    return result.get("result", {}).get("value")


async def read_page(transport) -> Dict[str, Any]:
    """Where the page is and what it shows: address, title, visible words, and any field the browser calls invalid."""
    value = await _evaluate(transport, _STATE_JS % (MAX_PAGE_TEXT, MAX_PAGE_TEXT))
    if not isinstance(value, dict):
        raise CdpError("cdp_failed", "the page did not answer")
    return value


async def click_and_settle(
    transport, selector: Optional[str], text: Optional[str],
    settle_s: float = 15.0, sleep: Callable = asyncio.sleep, clock: Callable[[], float] = time.monotonic,
) -> Dict[str, Any]:
    """
    Clicks the button, waits for the page that follows, and says what it shows. A click that changes nothing
    (a form the browser refused to send) is reported as such: `changed` is false and `invalid` names the fields.
    """
    before = await read_page(transport)
    found = await _evaluate(transport, _CLICK_JS % (json.dumps(selector or ""), json.dumps(text or "")))
    if not isinstance(found, dict) or not found.get("found"):
        raise CdpError("not_found", "no button or link matches")
    started = clock()
    stable = 0
    while True:
        await sleep(0.3)
        try:
            now = await _evaluate(transport, "({href: location.href, ready: document.readyState})")
        except CdpError:
            now = None                              # the page is being replaced
        elapsed = clock() - started
        moved = bool(now) and now.get("href") != before.get("url")
        if now and now.get("ready") == "complete" and (moved or elapsed >= 2.0):
            stable += 1
        else:
            stable = 0
        if stable >= 2 or elapsed >= settle_s:
            break
    after = await read_page(transport)
    after["clicked"] = found.get("label", "")
    after["urlBefore"] = before.get("url", "")
    after["changed"] = after.get("url") != before.get("url") or after.get("text") != before.get("text")
    return after


async def take_screenshot(transport) -> bytes:
    """A JPEG of the page as a person would see it on a desktop (1280 x 900)."""
    await transport.call("Emulation.setDeviceMetricsOverride", {"width": 1280, "height": 900, "deviceScaleFactor": 1, "mobile": False})
    try:
        shot = await transport.call("Page.captureScreenshot", {"format": "jpeg", "quality": 70})
    finally:
        try:
            await transport.call("Emulation.clearDeviceMetricsOverride")
        except CdpError:
            pass
    data = base64.b64decode(shot.get("data", ""), validate=False)
    if len(data) < 4 or data[:3] != b"\xff\xd8\xff" or len(data) > MAX_SHOT_BYTES:
        raise CdpError("cdp_failed", "the browser gave no usable picture")
    return data


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

    async def _with_page(self, ip: str, work: Callable, timeout: float):
        import websockets  # imported here: the rest of the broker, and its tests, do not need it

        targets = await asyncio.to_thread(_http_json, ip, self.port, "/json/list", 5.0)
        pages = [t for t in targets if t.get("type") == "page" and t.get("webSocketDebuggerUrl")]
        if not pages:
            raise CdpError("unavailable", "no page is open")
        # The page the person is on: the last one opened that is not blank, else the first.
        real = [p for p in pages if not str(p.get("url", "")).startswith(("about:blank", "chrome://"))]
        path = urllib.parse.urlparse((real[-1] if real else pages[0])["webSocketDebuggerUrl"]).path
        url = "ws://%s:%d%s" % (ip, self.port, path)

        async def go():
            async with websockets.connect(url, max_size=1 << 23, open_timeout=10, ping_interval=None) as ws:
                return await work(WsTransport(ws))

        try:
            return await asyncio.wait_for(go(), timeout)
        except asyncio.TimeoutError:
            raise CdpError("cdp_failed", "devtools timed out")
        except OSError:
            raise CdpError("unavailable", "devtools connection lost")

    async def set_file_input(self, ip: str, selector: str, paths: List[str], timeout: float = 30.0) -> None:
        await self._with_page(ip, lambda t: run_upload(t, selector, paths), timeout)

    async def submit(self, ip: str, selector: Optional[str], text: Optional[str], timeout: float = 45.0) -> Dict[str, Any]:
        return await self._with_page(ip, lambda t: click_and_settle(t, selector, text), timeout)

    async def screenshot(self, ip: str, timeout: float = 30.0) -> bytes:
        return await self._with_page(ip, take_screenshot, timeout)
