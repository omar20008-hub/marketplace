"""
Manual check against a real Chrome (not part of the unit suite):
  python tests/live_relay_check.py <chrome-binary> [extra chrome flags...]
Puts the relay in front of Chrome's DevTools and drives it the way an assistant's browser tools do:
a raw CDP client and Playwright's connectOverCDP, both through the secret path only.
"""
import asyncio
import http.client
import json
import os
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from browser_broker.cdp import CdpClient, WsTransport  # noqa: E402
from browser_broker.relay import Relay  # noqa: E402

PORT = 9336
RESULTS = []


def http_status(port, path):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        conn.request("GET", path)
        return conn.getresponse().status
    finally:
        conn.close()


def check(label, ok, detail=""):
    RESULTS.append(ok)
    print(("PASS  " if ok else "FAIL  ") + label + ((" -> " + str(detail)) if detail != "" else ""))


async def main(chrome, flags):
    import websockets

    profile = tempfile.mkdtemp()
    proc = subprocess.Popen([chrome, "--headless=new", "--remote-debugging-port=%d" % PORT, "--user-data-dir=" + profile,
                             "--no-first-run", "about:blank"] + flags, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    relay = None
    try:
        client = CdpClient(PORT)
        for _ in range(60):
            if await client.ready("127.0.0.1"):
                break
            time.sleep(0.5)
        else:
            sys.exit("chrome never answered")
        path = await client.browser_ws_path("127.0.0.1")
        seen = []
        relay = Relay("127.0.0.1", PORT, path, lambda: seen.append(1))
        port = await relay.start()
        url = "ws://127.0.0.1:%d%s" % (port, path)
        check("the browser's own path was read (secret)", path.startswith("/devtools/browser/"))

        async with websockets.connect(url, ping_interval=None) as ws:
            version = await WsTransport(ws).call("Browser.getVersion")
        check("a raw CDP client works through the relay", "Chrome" in version.get("product", ""), version.get("product"))
        check("the relay saw the traffic", len(seen) > 0, len(seen))

        for bad in ("/json/version", "/json/list", path + "x", "/devtools/browser/wrong"):
            status = await asyncio.to_thread(http_status, port, bad)      # off the loop: the relay lives on it
            check("%s on the relay port is refused" % bad, status == 404, status)

        script = (
            "const { chromium } = require('playwright');"
            "(async () => {"
            "  const browser = await chromium.connectOverCDP(process.argv[1]);"
            "  const ctx = browser.contexts()[0] || await browser.newContext();"
            "  const page = await ctx.newPage();"
            "  await page.goto('data:text/html,<title>through-the-relay</title><input id=f type=file>');"
            "  console.log('TITLE=' + await page.title());"
            "  await browser.close();"
            "})().catch(e => { console.log('ERROR=' + e.message.split('\\n')[0]); process.exit(1); });"
        )
        node = await asyncio.create_subprocess_exec("node", "-e", script, url, stdout=asyncio.subprocess.PIPE,
                                                    stderr=asyncio.subprocess.PIPE)
        stdout, stderr = await asyncio.wait_for(node.communicate(), 90)
        line = (stdout.decode().strip().splitlines() or [stderr.decode().strip()[:200]])[-1]
        check("Playwright connectOverCDP drives the browser through the relay", line == "TITLE=through-the-relay", line)
    finally:
        if relay:
            await relay.stop()
        proc.terminate()
    print("RESULT: %d of %d" % (sum(RESULTS), len(RESULTS)))
    sys.exit(0 if all(RESULTS) else 1)


asyncio.run(main(sys.argv[1], sys.argv[2:]))
