"""
Manual check against a real Chrome (not part of the unit suite):
  python tests/live_submit_check.py <chrome-binary> [extra chrome flags...]
A form the browser refuses to send (a required field is empty), then the same form filled in: the click, the wait
for the page that follows, what that page shows, and a picture of it.
"""
import asyncio
import http.server
import os
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from browser_broker.cdp import CdpClient, _evaluate  # noqa: E402

FORM = b"""<html><head><title>Order</title></head><body><h1>Pizza order</h1>
<form action="/done" method="get"><input id="n" name="n" required><button type="submit">Send order</button></form></body></html>"""


class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        if url.path == "/done":
            name = urllib.parse.parse_qs(url.query).get("n", [""])[0]
            body = ("<html><head><title>Thanks</title></head><body><h1>Thank you %s</h1></body></html>" % name).encode()
        else:
            body = FORM
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


RESULTS = []


def check(label, ok, detail=""):
    RESULTS.append(bool(ok))
    print(("PASS  " if ok else "FAIL  ") + label + ((" -> " + str(detail)) if detail != "" else ""))


async def main(chrome, flags):
    web = http.server.HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=web.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()
    proc = subprocess.Popen([chrome, "--headless=new", "--remote-debugging-port=9337", "--user-data-dir=" + tempfile.mkdtemp(),
                             "--no-first-run", "http://127.0.0.1:%d/form" % web.server_port] + flags,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        client = CdpClient(9337)
        for _ in range(60):
            if await client.ready("127.0.0.1"):
                break
            time.sleep(0.5)
        else:
            sys.exit("chrome never answered")
        await asyncio.sleep(1.5)

        out = await client.submit("127.0.0.1", None, "send order")          # words are matched without case
        check("a form the browser refuses is reported as unchanged, naming the empty field",
              out["changed"] is False and out["invalid"] == ["n"], (out["changed"], out["invalid"]))
        check("the button was found by its words", out["clicked"] == "Send order", out["clicked"])

        await client._with_page("127.0.0.1", lambda t: _evaluate(t, "document.getElementById('n').value = 'Omar'"), 15)
        out = await client.submit("127.0.0.1", "button[type=submit]", None)  # and by a selector
        check("the filled form is sent and the page that follows is read", out["changed"] is True and out["title"] == "Thanks", out["title"])
        check("what the new page shows comes back as text", "Thank you Omar" in out["text"], out["text"][:40])
        check("the address before and after differ", out["urlBefore"].endswith("/form") and "/done?n=Omar" in out["url"], out["url"][-20:])

        shot = await client.screenshot("127.0.0.1")
        check("a JPEG of the page comes back", shot[:3] == b"\xff\xd8\xff" and len(shot) > 2000, len(shot))
        try:
            await client.submit("127.0.0.1", None, "no such button")
            check("a missing button is an error", False)
        except Exception as error:  # noqa: BLE001
            check("a missing button is an error", getattr(error, "kind", "") == "not_found", getattr(error, "kind", type(error).__name__))
    finally:
        proc.terminate()
        web.shutdown()
    print("RESULT: %d of %d" % (sum(RESULTS), len(RESULTS)))
    sys.exit(0 if all(RESULTS) else 1)


asyncio.run(main(sys.argv[1], sys.argv[2:]))
