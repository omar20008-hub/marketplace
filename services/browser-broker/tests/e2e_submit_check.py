"""
End-to-end check on the server (manual, not part of the unit suite). Run as root with the broker's venv:

    BROKER_KEY=<agent key> /opt/browser-broker/venv/bin/python tests/e2e_submit_check.py

Real container, real DevTools, a public echo form (https://httpbin.org/forms/post, which only returns what it was
sent; nothing real is submitted). It fills the form, calls the broker's submit route and checks that the page changed,
shows what was sent, and that a snapshot was taken and sent to the platform. A waiting session of the same person is
closed first (their one slot). The snapshot is delivered to that person's WhatsApp with their next reply.
The key comes from the environment and is never printed.
"""
import asyncio
import http.client
import json
import os
import socket
import subprocess
import sys
import urllib.parse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from browser_broker.cdp import WsTransport, _http_json  # noqa: E402

SOCK = "/run/browser-broker/broker.sock"
KEY = os.environ.get("BROKER_KEY", "")
RESULTS = []

FILL = """(function(){const q=n=>document.querySelector('[name="'+n+'"]');
q('custname').value='Test Karim';q('custtel').value='0555000111';q('custemail').value='test.karim@example.com';
document.querySelector('input[name=size][value=large]').click();
document.querySelector('input[name=topping][value=bacon]').click();
document.querySelector('input[name=topping][value=cheese]').click();
q('comments').value='e2e submit check';return true})()"""


class Unix(http.client.HTTPConnection):
    def __init__(self):
        super().__init__("localhost", timeout=150)

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(150)
        self.sock.connect(SOCK)


def api(method, path, body=None):
    conn = Unix()
    conn.request(method, path, json.dumps(body) if body is not None else None,
                 {"Content-Type": "application/json", "Authorization": "Bearer " + KEY})
    response = conn.getresponse()
    data = json.loads(response.read() or b"{}")
    conn.close()
    return response.status, data


def check(label, ok, detail=""):
    RESULTS.append(bool(ok))
    print(("PASS  " if ok else "FAIL  ") + label + (("  -> " + str(detail)[:300]) if detail != "" else ""))


async def main():
    import websockets

    if not KEY:
        sys.exit("BROKER_KEY is not set")
    status, made = api("POST", "/v1/sessions")
    if status == 429 and made.get("error") == "user_busy":
        resumed, held = api("POST", "/v1/sessions/resume")
        if resumed == 200:
            api("POST", "/v1/sessions/%s/close" % held["id"])
        status, made = api("POST", "/v1/sessions")
    check("create a session", status == 201 and "id" in made, (status, made.get("error")))
    if status != 201:
        sys.exit(1)
    sid = made["id"]
    try:
        out = subprocess.run(["docker", "inspect", "bb-" + sid], capture_output=True, text=True, check=True).stdout
        ip = json.loads(out)[0]["NetworkSettings"]["Networks"]["browser-net"]["IPAddress"]
        page = [t for t in _http_json(ip, 9222, "/json/list", 5) if t.get("type") == "page"][0]
        path = urllib.parse.urlparse(page["webSocketDebuggerUrl"]).path
        async with websockets.connect("ws://%s:9222%s" % (ip, path), max_size=1 << 22, ping_interval=None) as ws:
            t = WsTransport(ws)
            await t.call("Page.enable")
            await t.call("Page.navigate", {"url": "https://httpbin.org/forms/post"})
            loaded = False
            for _ in range(60):
                value = (await t.call("Runtime.evaluate", {
                    "expression": "document.readyState==='complete' && !!document.querySelector('[name=custname]')",
                    "returnByValue": True})).get("result", {}).get("value")
                if value:
                    loaded = True
                    break
                await asyncio.sleep(0.5)
            check("the form page loaded in the container", loaded)
            if loaded:
                filled = (await t.call("Runtime.evaluate", {"expression": FILL, "returnByValue": True})).get("result", {}).get("value")
                check("the form was filled", filled is True)
                status, body = api("POST", "/v1/sessions/%s/submit" % sid, {"text": "Submit order"})
                check("submit answered 200", status == 200, (status, body.get("error")))
                check("the page changed after the click", body.get("changed") is True, body.get("url"))
                shown = str(body.get("text", ""))
                check("the page shows what was sent (Test Karim, large)", "Test Karim" in shown and "large" in shown)
                check("a snapshot was taken and sent to the platform", body.get("attachment") is True)
    finally:
        status, _ = api("POST", "/v1/sessions/%s/close" % sid)
        check("close the session", status == 200)
    print()
    print("RESULT: %d of %d" % (sum(RESULTS), len(RESULTS)))
    sys.exit(0 if all(RESULTS) else 1)


asyncio.run(main())
