"""
End-to-end check on the server (manual, not part of the unit suite). Run as root with the broker's venv:

    BROKER_KEY=<agent key> /opt/browser-broker/venv/bin/python tests/e2e_upload_check.py [file-name] [page-url]

It goes through the real chain: broker socket -> real container -> the platform for the file -> DevTools -> a
public test page (default https://the-internet.herokuapp.com/upload). It uses a throwaway file of the person's
(default name upload-test.txt): the file's bytes go to the test page, so never use a real document.
The key comes from the environment and is never printed.
"""
import asyncio
import http.client
import json
import os
import socket
import subprocess
import sys
import time
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from browser_broker.cdp import WsTransport, _http_json  # noqa: E402

SOCKET = "/run/browser-broker/broker.sock"
CONFIG = "/etc/browser-broker/config.json"
STATE = "/var/lib/browser-broker/sessions"
KEY = os.environ.get("BROKER_KEY", "")
NAME = sys.argv[1] if len(sys.argv) > 1 else "upload-test.txt"
PAGE = sys.argv[2] if len(sys.argv) > 2 else "https://the-internet.herokuapp.com/upload"
RESULTS = []


class Unix(http.client.HTTPConnection):
    def __init__(self):
        super().__init__("localhost", timeout=120)

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(120)
        self.sock.connect(SOCKET)


def api(method, path, body=None, key=KEY):
    conn = Unix()
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = "Bearer " + key
    conn.request(method, path, json.dumps(body) if body is not None else None, headers)
    response = conn.getresponse()
    data = json.loads(response.read() or b"{}")
    conn.close()
    return response.status, data


def check(label, ok, detail=""):
    RESULTS.append(ok)
    print(("PASS  " if ok else "FAIL  ") + label + (("  -> " + str(detail)) if detail != "" else ""))
    return ok


def find_file_id():
    with open(CONFIG) as handle:
        base = json.load(handle)["platform_url"].rstrip("/")
    request = urllib.request.Request(base + "/api/agent/context", headers={"Authorization": "Bearer " + KEY})
    with urllib.request.urlopen(request, timeout=20) as response:
        files = json.loads(response.read()).get("files", [])
    matches = [f for f in files if f.get("name") == NAME]
    return matches[0]["id"] if matches else None


def container_ip(session_id):
    out = subprocess.run(["docker", "inspect", "bb-" + session_id], capture_output=True, text=True, check=True).stdout
    return json.loads(out)[0]["NetworkSettings"]["Networks"]["browser-net"]["IPAddress"]


async def evaluate(transport, expression):
    result = await transport.call("Runtime.evaluate", {"expression": expression, "returnByValue": True})
    return result.get("result", {}).get("value")


async def wait_for(transport, expression, seconds):
    deadline = time.time() + seconds
    while time.time() < deadline:
        try:
            value = await evaluate(transport, expression)
        except Exception:
            value = None
        if value:
            return value
        await asyncio.sleep(0.5)
    return None


async def main():
    import websockets

    if not KEY:
        sys.exit("BROKER_KEY is not set")
    file_id = find_file_id()
    if not check("the test file %r is in the person's platform space" % NAME, bool(file_id)):
        sys.exit("Attach a small text file named %s in the platform chat first." % NAME)

    check("create without a key is refused", api("POST", "/v1/sessions", key="")[0] == 401)
    status, made = api("POST", "/v1/sessions")
    if not check("create a session", status == 201 and "id" in made, status):
        sys.exit(1)
    sid = made["id"]
    session_dir = os.path.join(STATE, sid)
    try:
        status, again = api("POST", "/v1/sessions")
        check("a second session for the same person is refused", status == 429 and again.get("error") == "user_busy", status)

        ip = container_ip(sid)
        targets = _http_json(ip, 9222, "/json/list", 5)
        page = [t for t in targets if t.get("type") == "page"][0]
        path = urllib.parse.urlparse(page["webSocketDebuggerUrl"]).path
        async with websockets.connect("ws://%s:9222%s" % (ip, path), max_size=1 << 22, ping_interval=None) as ws:
            t = WsTransport(ws)
            await t.call("Page.enable")
            await t.call("Page.navigate", {"url": PAGE})
            loaded = await wait_for(t, "document.readyState === 'complete' && !!document.querySelector('#file-upload')", 45)
            loaded_ok = check("the public test page loaded inside the container", bool(loaded))
            if loaded_ok:

                up = "/v1/sessions/%s/upload" % sid
                status, body = api("POST", up, {"fileId": file_id, "selector": "#nothing-here"})
                check("a selector that matches nothing is refused", status == 400 and body.get("error") == "selector_not_found", (status, body))
                status, body = api("POST", up, {"fileId": file_id, "selector": "h3"})
                check("an element that is not a file input is refused", status == 400 and body.get("error") == "not_a_file_input", (status, body))
                status, body = api("POST", up, {"fileId": "cm0000000000000000000000", "selector": "#file-upload"})
                check("a file that is not the person's is not found", status == 404 and body.get("error") == "not_found", (status, body))
                status, body = api("POST", up, {"fileId": file_id, "selector": "#file-upload"})
                check("the person's own file is uploaded into the input", status == 200 and body.get("uploaded") is True, (status, body))

                await evaluate(t, "document.querySelector('#file-submit').click()")
                shown = await wait_for(t, "document.querySelector('#uploaded-files') && document.querySelector('#uploaded-files').innerText", 45)
                check("the site received the file (it shows the name)", bool(shown) and NAME in str(shown), shown)

                status, view = api("GET", "/v1/sessions/%s" % sid)
                check("the session counts one upload", status == 200 and view.get("uploads") == 1, view)
    finally:
        status, _ = api("POST", "/v1/sessions/%s/close" % sid)
        check("close the session", status == 200, status)
        time.sleep(1)
        gone = subprocess.run(["docker", "ps", "-a", "--filter", "name=bb-" + sid, "--format", "{{.Names}}"],
                              capture_output=True, text=True).stdout.strip() == ""
        check("the container is gone", gone)
        check("the session folder and its uploaded copy are gone", not os.path.exists(session_dir))
        check("the closed session is not found any more", api("GET", "/v1/sessions/%s" % sid)[0] == 404)

    print()
    print("RESULT: %d of %d checks passed" % (sum(RESULTS), len(RESULTS)))
    sys.exit(0 if all(RESULTS) else 1)


asyncio.run(main())
