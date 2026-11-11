import asyncio
import json
import threading
import unittest
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer

from browser_broker.cdp import CdpError, run_upload
from browser_broker.platform import CachedIdentity, PlatformClient, PlatformError

GOOD = "testkey-0123456789abcdef"


class Stub(BaseHTTPRequestHandler):
    seen = []

    def log_message(self, *a):
        pass

    def do_GET(self):
        Stub.seen.append(self.path)
        if self.headers.get("Authorization") != "Bearer " + GOOD:
            return self._send(401, b"{}")
        if self.path == "/api/agent/whoami":
            return self._send(200, json.dumps({"userId": "u-1"}).encode())
        if self.path == "/api/agent/files/big-file-0001":
            return self._send(200, b"x" * 100)
        if self.path == "/api/agent/files/redirect-0001":
            self.send_response(302)
            self.send_header("Location", "http://127.0.0.1:1/steal")
            self.end_headers()
            return
        if self.path == "/api/agent/files/file-0000001":
            return self._send(200, b"cv bytes", {"X-File-Name": urllib.parse.quote("السيرة.pdf")})
        self._send(404, b"{}")

    def _send(self, code, body, extra=None):
        self.send_response(code)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)


class PlatformTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        Stub.seen = []
        self.http = HTTPServer(("127.0.0.1", 0), Stub)
        threading.Thread(target=self.http.serve_forever, daemon=True).start()
        self.client = PlatformClient("http://127.0.0.1:%d" % self.http.server_port, timeout=3)

    def tearDown(self):
        self.http.shutdown()
        self.http.server_close()

    async def kind(self, coro):
        try:
            await coro
        except PlatformError as error:
            return error.kind

    async def test_whoami_and_file(self):
        self.assertEqual(await self.client.whoami(GOOD), "u-1")
        name, data = await self.client.fetch_file(GOOD, "file-0000001", 1000)
        self.assertEqual((name, data), ("السيرة.pdf", b"cv bytes"))

    async def test_errors_are_classified(self):
        self.assertEqual(await self.kind(self.client.whoami("wrong-key-0123456789abc")), "unauthorized")
        self.assertEqual(await self.kind(self.client.fetch_file(GOOD, "missing-0001", 1000)), "not_found")
        self.assertEqual(await self.kind(self.client.fetch_file(GOOD, "big-file-0001", 10)), "too_large")
        dead = PlatformClient("http://127.0.0.1:1", timeout=1)
        self.assertEqual(await self.kind(dead.whoami(GOOD)), "unavailable")

    async def test_a_redirect_is_never_followed_so_the_key_goes_nowhere_else(self):
        self.assertEqual(await self.kind(self.client.fetch_file(GOOD, "redirect-0001", 1000)), "unavailable")
        self.assertEqual(Stub.seen, ["/api/agent/files/redirect-0001"])

    async def test_identity_is_cached_under_a_hash(self):
        class Counter:
            n = 0

            async def whoami(self, key):
                self.n += 1
                return "u"

        now = [0.0]
        counter = Counter()
        identity = CachedIdentity(counter, ttl=60, clock=lambda: now[0])
        await identity.user_for(GOOD)
        await identity.user_for(GOOD)
        self.assertEqual(counter.n, 1)
        self.assertNotIn(GOOD, json.dumps(list(identity._seen.keys())))
        now[0] = 61
        await identity.user_for(GOOD)
        self.assertEqual(counter.n, 2)


class FakeTransport:
    def __init__(self, answers):
        self.answers = answers
        self.calls = []

    async def call(self, method, params=None):
        self.calls.append((method, params))
        return self.answers[method]


class RunUpload(unittest.IsolatedAsyncioTestCase):
    def answers(self, node_id=7, name="INPUT", attrs=("type", "file")):
        return {
            "DOM.getDocument": {"root": {"nodeId": 1}},
            "DOM.querySelector": {"nodeId": node_id},
            "DOM.describeNode": {"node": {"nodeName": name, "attributes": ["id", "f", *attrs]}},
            "DOM.setFileInputFiles": {},
        }

    async def test_sets_the_files_on_the_matched_file_input(self):
        t = FakeTransport(self.answers())
        await run_upload(t, "#f", ["/uploads/1/cv.pdf"])
        self.assertEqual(t.calls[-1], ("DOM.setFileInputFiles", {"nodeId": 7, "files": ["/uploads/1/cv.pdf"]}))

    async def test_no_match_and_wrong_element_are_refused_before_anything_is_set(self):
        for answers, kind in ((self.answers(node_id=0), "not_found"),
                              (self.answers(name="DIV"), "not_file_input"),
                              (self.answers(attrs=("type", "text")), "not_file_input")):
            t = FakeTransport(answers)
            with self.assertRaises(CdpError) as caught:
                await run_upload(t, "#f", ["/uploads/1/cv.pdf"])
            self.assertEqual(caught.exception.kind, kind)
            self.assertNotIn("DOM.setFileInputFiles", [c[0] for c in t.calls])


if __name__ == "__main__":
    unittest.main()
