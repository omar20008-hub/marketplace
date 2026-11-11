"""
Manual check against a real Chrome (not part of the unit suite):
  python tests/live_cdp_check.py <chrome-binary> [extra chrome flags...]
Serves a page with a file input, opens it, then uploads a file through the broker's own CDP code
and reads the result back from the page.
"""
import asyncio
import http.server
import json
import os
import subprocess
import sys
import tempfile
import threading
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from browser_broker.cdp import CdpClient, CdpError, WsTransport, _http_json  # noqa: E402

PAGE = b"""<html><body><input id="f" type="file"><input id="t" type="text"><div id="x">no</div>
<script>f.onchange=()=>x.textContent='picked:'+f.files[0].name+':'+f.files[0].size</script></body></html>"""


class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Length", str(len(PAGE)))
        self.end_headers()
        self.wfile.write(PAGE)


async def main(chrome, flags):
    web = http.server.HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=web.serve_forever, daemon=True).start()
    folder = tempfile.mkdtemp()
    path = os.path.join(folder, "cv.pdf")
    with open(path, "wb") as handle:
        handle.write(b"%PDF-1.4 test cv")
    profile = tempfile.mkdtemp()
    proc = subprocess.Popen([chrome, "--headless=new", "--remote-debugging-port=9333", "--user-data-dir=" + profile,
                             "--no-first-run", "http://127.0.0.1:%d/" % web.server_port] + flags,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        client = CdpClient(9333)
        for _ in range(60):
            if await client.ready("127.0.0.1"):
                break
            time.sleep(0.5)
        else:
            raise SystemExit("FAIL chrome never answered")
        time.sleep(1)
        print("ready: OK")
        await client.set_file_input("127.0.0.1", "#f", [path])
        print("set_file_input on #f: OK")
        for selector, kind in (("#nothing", "not_found"), ("#t", "not_file_input")):
            try:
                await client.set_file_input("127.0.0.1", selector, [path])
                print("FAIL %s was accepted" % selector)
            except CdpError as error:
                print("%s refused: %s %s" % (selector, error.kind, "OK" if error.kind == kind else "FAIL"))
        import websockets
        targets = _http_json("127.0.0.1", 9333, "/json/list", 5)
        import urllib.parse
        page = [t for t in targets if t["type"] == "page"][0]
        url = "ws://127.0.0.1:9333" + urllib.parse.urlparse(page["webSocketDebuggerUrl"]).path
        async with websockets.connect(url, ping_interval=None) as ws:
            t = WsTransport(ws)
            result = await t.call("Runtime.evaluate", {"expression": "document.getElementById('x').textContent"})
            value = result["result"]["value"]
        print("page says:", value, "OK" if value == "picked:cv.pdf:16" else "FAIL")
    finally:
        proc.terminate()
        web.shutdown()


asyncio.run(main(sys.argv[1], sys.argv[2:]))
