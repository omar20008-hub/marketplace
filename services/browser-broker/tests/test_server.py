import asyncio
import grp
import json
import os
import tempfile
import unittest

from browser_broker.manager import Manager
from browser_broker.platform import CachedIdentity
from browser_broker.server import Api, serve
from tests.fakes import Clock, FakeCdp, FakeDocker, FakePlatform, FakeRelay, KEY_A, KEY_B, make_config


class ServerCase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.clock = Clock()
        self.docker, self.cdp, self.platform = FakeDocker(), FakeCdp(), FakePlatform()
        cfg = make_config()
        self.m = Manager(cfg, self.docker, self.cdp, b"k" * 32, clock=self.clock, sleep=self.clock.sleep, relay_cls=FakeRelay)
        api = Api(self.m, self.platform, CachedIdentity(self.platform, clock=self.clock))
        self.path = os.path.join(tempfile.mkdtemp(prefix="bb-sock-"), "broker.sock")
        group = grp.getgrgid(os.getgid()).gr_name
        self.server = await serve(api, self.path, group, 10)

    async def asyncTearDown(self):
        self.server.close()
        await self.server.wait_closed()

    async def raw(self, payload: bytes):
        reader, writer = await asyncio.open_unix_connection(self.path)
        writer.write(payload)
        await writer.drain()
        data = await reader.read()
        writer.close()
        head, _, body = data.partition(b"\r\n\r\n")
        return int(head.split(b" ")[1]), json.loads(body or b"{}")

    async def call(self, method, path, body=None, key=KEY_A, extra=""):
        data = json.dumps(body).encode() if body is not None else b""
        auth = ("Authorization: Bearer %s\r\n" % key) if key else ""
        request = ("%s %s HTTP/1.1\r\nHost: x\r\n%s%sContent-Length: %d\r\n\r\n" % (method, path, auth, extra, len(data))).encode() + data
        return await self.raw(request)


class Api_(ServerCase):
    async def test_socket_is_private_to_owner_and_group(self):
        self.assertEqual(oct(os.stat(self.path).st_mode & 0o777), "0o660")

    async def test_health_needs_no_key(self):
        status, body = await self.call("GET", "/v1/health", key=None)
        self.assertEqual((status, body["ok"]), (200, True))

    async def test_a_key_is_required_and_must_be_known(self):
        self.assertEqual((await self.call("POST", "/v1/sessions", key=None))[0], 401)
        self.assertEqual((await self.call("POST", "/v1/sessions", key="short"))[0], 401)
        self.assertEqual((await self.call("POST", "/v1/sessions", key="unknown-key-0123456789abcdef"))[0], 401)

    async def test_full_flow_with_ownership(self):
        status, made = await self.call("POST", "/v1/sessions")
        self.assertEqual(status, 201)
        sid = made["id"]
        self.assertRegex(made["cdpUrl"], r"^ws://127\.0\.0\.1:\d+/devtools/browser/")
        self.assertNotIn("cdpUrl", (await self.call("GET", "/v1/sessions/" + sid))[1])     # the secret is given once
        self.assertEqual((await self.call("GET", "/v1/sessions/" + sid))[1]["state"], "ready")
        self.assertEqual((await self.call("GET", "/v1/sessions/" + sid, key=KEY_B))[0], 404)   # not theirs
        self.assertEqual((await self.call("POST", "/v1/sessions"))[1], {"error": "user_busy"})
        status, body = await self.call("POST", "/v1/sessions/%s/waiting" % sid, {"waiting": True})
        self.assertEqual((status, body["waiting"]), (200, True))
        self.assertEqual((await self.call("POST", "/v1/sessions/%s/waiting" % sid, {"waiting": "yes"}))[0], 400)
        self.assertEqual((await self.call("POST", "/v1/sessions/%s/touch" % sid))[0], 200)
        self.assertEqual((await self.call("POST", "/v1/sessions/%s/close" % sid))[0], 200)
        self.assertEqual((await self.call("GET", "/v1/sessions/" + sid))[0], 404)

    async def test_resume_gives_a_waiting_session_back_with_its_address_to_its_owner_only(self):
        made = (await self.call("POST", "/v1/sessions"))[1]
        self.assertEqual((await self.call("POST", "/v1/sessions/resume"))[1], {"error": "no_waiting_session"})   # not waiting
        await self.call("POST", "/v1/sessions/%s/waiting" % made["id"], {"waiting": True})
        self.assertEqual((await self.call("POST", "/v1/sessions/resume", key=KEY_B))[0], 404)                     # not theirs
        self.assertEqual((await self.call("POST", "/v1/sessions/resume", key=None))[0], 401)
        status, body = await self.call("POST", "/v1/sessions/resume")
        self.assertEqual((status, body["id"], body["waiting"]), (200, made["id"], False))
        self.assertEqual(body["cdpUrl"], made["cdpUrl"])                                                          # the same browser

    async def test_release_keeps_the_browser_and_resume_gives_it_back(self):
        made = (await self.call("POST", "/v1/sessions"))[1]
        self.assertEqual((await self.call("POST", "/v1/sessions/%s/release" % made["id"], key=KEY_B))[0], 404)   # not theirs
        status, body = await self.call("POST", "/v1/sessions/%s/release" % made["id"])
        self.assertEqual((status, body["waiting"]), (200, True))
        status, back = await self.call("POST", "/v1/sessions/resume")
        self.assertEqual((status, back["id"], back["cdpUrl"]), (200, made["id"], made["cdpUrl"]))

    async def test_upload_validation_and_errors_map_to_clear_codes(self):
        sid = (await self.call("POST", "/v1/sessions"))[1]["id"]
        url = "/v1/sessions/%s/upload" % sid
        self.assertEqual((await self.call("POST", url, {}))[0], 400)
        self.assertEqual((await self.call("POST", url, {"fileId": "../../x", "selector": "#f"}))[0], 400)
        self.assertEqual((await self.call("POST", url, {"fileId": "file-aaaa-1", "selector": "a" * 300}))[0], 400)
        ok = await self.call("POST", url, {"fileId": "file-aaaa-1", "selector": "input[type=file]"})
        self.assertEqual(ok, (200, {"uploaded": True}))
        self.assertEqual(self.cdp.calls[0][2], ["/uploads/1/passwd.pdf"])
        self.assertEqual((await self.call("POST", url, {"fileId": "file-bbbb-1", "selector": "#f"}))[1], {"error": "not_found"})
        self.platform.fetch_error = "too_large"
        self.assertEqual((await self.call("POST", url, {"fileId": "file-aaaa-1", "selector": "#f"}))[0], 413)
        self.platform.fetch_error = "unavailable"
        self.assertEqual((await self.call("POST", url, {"fileId": "file-aaaa-1", "selector": "#f"}))[0], 502)
        self.platform.fetch_error = None
        self.cdp.error = "not_file_input"
        self.assertEqual((await self.call("POST", url, {"fileId": "file-aaaa-1", "selector": "#f"}))[1], {"error": "not_a_file_input"})

    async def test_malformed_requests_are_refused(self):
        self.assertEqual((await self.raw(b"GARBAGE\r\n\r\n"))[0], 400)
        self.assertEqual((await self.call("POST", "/v1/sessions", extra="Transfer-Encoding: chunked\r\n"))[0], 400)
        big = ("POST /v1/sessions HTTP/1.1\r\nAuthorization: Bearer %s\r\nContent-Length: 99999\r\n\r\n" % KEY_A).encode()
        self.assertEqual((await self.raw(big))[0], 413)
        bad_json = ("POST /v1/sessions/%s/upload HTTP/1.1\r\nAuthorization: Bearer %s\r\nContent-Length: 5\r\n\r\n{nope" % ("a" * 32, KEY_A)).encode()
        self.assertEqual((await self.raw(bad_json))[0], 400)
        self.assertEqual((await self.call("GET", "/v1/nothing"))[0], 404)
        self.assertEqual((await self.call("GET", "/v1/sessions/not-an-id"))[0], 404)

    async def test_an_unexpected_failure_reveals_nothing(self):
        async def boom(*args, **kwargs):
            raise RuntimeError("secret detail /var/lib/x")
        self.m.create = boom
        status, body = await self.call("POST", "/v1/sessions")
        self.assertEqual((status, body), (500, {"error": "internal_error"}))

    async def test_the_key_is_asked_about_once_then_remembered_briefly(self):
        await self.call("POST", "/v1/sessions")
        await self.call("GET", "/v1/health", key=None)
        sid = list(self.m.sessions)[0]
        for _ in range(3):
            await self.call("POST", "/v1/sessions/%s/touch" % sid)
        self.assertEqual(self.platform.whoami_calls, 1)
        self.clock.t += 61
        await self.call("POST", "/v1/sessions/%s/touch" % sid)
        self.assertEqual(self.platform.whoami_calls, 2)


if __name__ == "__main__":
    unittest.main()
