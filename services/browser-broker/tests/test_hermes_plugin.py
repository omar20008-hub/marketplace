import abc
import importlib.util
import json
import logging
import os
import socketserver
import sys
import tempfile
import threading
import types
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

PLUGIN = os.path.join(os.path.dirname(__file__), "..", "hermes_plugin", "broker", "__init__.py")
KEY = "ak_test-key-0123456789abcdefghij"
OTHER_KEY = "ak_other-key-0123456789abcdefghij"
SECRETS = {}


def load_plugin():
    """The plugin imports Hermes' own modules; stand-ins with the same shape let its logic run here."""
    agent = types.ModuleType("agent")
    provider_mod = types.ModuleType("agent.browser_provider")

    class BrowserProvider(abc.ABC):
        @property
        @abc.abstractmethod
        def name(self): ...

        @abc.abstractmethod
        def is_available(self): ...

        @abc.abstractmethod
        def create_session(self, task_id): ...

        @abc.abstractmethod
        def close_session(self, session_id): ...

        @abc.abstractmethod
        def emergency_cleanup(self, session_id): ...

    provider_mod.BrowserProvider = BrowserProvider
    scope = types.ModuleType("agent.secret_scope")

    def get_secret(name, default=None):
        if SECRETS.get("raise"):
            raise RuntimeError("UnscopedSecretError")
        return SECRETS.get(name, default)

    scope.get_secret = get_secret
    sys.modules.update({"agent": agent, "agent.browser_provider": provider_mod, "agent.secret_scope": scope})
    spec = importlib.util.spec_from_file_location("broker_plugin_under_test", PLUGIN)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


plugin = load_plugin()


class FakeBroker(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True

    def __init__(self, path):
        self.calls = []
        self.fail = None                 # (status, code) to answer every call with
        super().__init__(path, _BrokerHandler)


class _BrokerHandler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def address_string(self):
        return "unix"

    def _reply(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        auth = self.headers.get("Authorization", "")
        self.server.calls.append((self.path, auth, body))
        if self.server.fail:
            return self._reply(*self.server.fail)
        if self.path == "/v1/sessions":
            return self._reply(201, {"id": "a" * 32, "state": "ready",
                                     "cdpUrl": "ws://127.0.0.1:45678/devtools/browser/0a1b2c3d-1111-2222"})
        if self.path.endswith("/upload") or self.path.endswith("/waiting"):
            return self._reply(200, {"uploaded": True})
        if self.path.endswith("/close"):
            return self._reply(200, {"closed": True})
        self._reply(404, {"error": "not_found"})


class PlatformStub(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path == "/api/agent/context" and self.headers.get("Authorization") == "Bearer " + KEY:
            body = json.dumps({"files": [
                {"id": "file-new-0001", "name": "cv.pdf"}, {"id": "file-old-0001", "name": "cv.pdf"},
                {"id": "file-doc-0001", "name": "cv.docx"}]}).encode()
            self.send_response(200)
        else:
            body, _ = b"{}", self.send_response(401)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class Capture(logging.Handler):
    def __init__(self):
        super().__init__()
        self.lines = []

    def emit(self, record):
        self.lines.append(record.getMessage())


class Case(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="bbp-")
        self.sock = os.path.join(self.dir, "b.sock")
        self.broker = FakeBroker(self.sock)
        threading.Thread(target=self.broker.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True).start()
        self.http = HTTPServer(("127.0.0.1", 0), PlatformStub)
        threading.Thread(target=self.http.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True).start()
        SECRETS.clear()
        SECRETS.update({"PLATFORM_AGENT_KEY": KEY, "PLATFORM_URL": "http://127.0.0.1:%d" % self.http.server_port})
        os.environ["BROWSER_BROKER_SOCKET"] = self.sock
        plugin._KEY_OF_SESSION.clear()
        plugin._LATEST.clear()
        self.capture = Capture()
        logging.getLogger().addHandler(self.capture)
        logging.getLogger().setLevel(logging.DEBUG)
        self.provider = plugin.BrokerBrowserProvider()

    def tearDown(self):
        logging.getLogger().removeHandler(self.capture)
        self.broker.shutdown()
        self.broker.server_close()
        self.http.shutdown()
        self.http.server_close()
        os.environ.pop("BROWSER_BROKER_SOCKET", None)


class Provider(Case):
    def test_identity_and_always_available(self):
        self.assertEqual(self.provider.name, "broker")
        self.assertTrue(self.provider.is_available())            # "unavailable" would send Hermes to a local browser
        SECRETS.clear()
        self.assertTrue(self.provider.is_available())

    def test_a_session_comes_back_with_the_brokers_address_and_the_persons_key_was_the_credential(self):
        info = self.provider.create_session("task-1")
        self.assertEqual(info["bb_session_id"], "a" * 32)
        self.assertEqual(info["cdp_url"], "ws://127.0.0.1:45678/devtools/browser/0a1b2c3d-1111-2222")
        self.assertEqual(self.broker.calls[0][1], "Bearer " + KEY)

    def test_every_failure_becomes_a_dead_address_never_an_exception(self):
        cases = [
            ((503, {"error": "busy"}), "busy"), ((429, {"error": "user_busy"}), "busy"),
            ((429, {"error": "quota_exceeded"}), "quota"), ((401, {"error": "unauthorized"}), "unauthorized"),
            ((502, {"error": "start_failed"}), "start-failed"), ((500, {"error": "internal_error"}), "unavailable"),
        ]
        for fail, reason in cases:
            self.broker.fail = fail
            info = self.provider.create_session("t")
            self.assertEqual(info["cdp_url"], "ws://127.0.0.1:9/devtools/browser/broker-" + reason, fail)
            self.assertEqual(info["bb_session_id"], "")
            self.assertIn("/devtools/browser/", info["cdp_url"])      # Hermes passes such a URL through untouched

    def test_no_broker_and_no_key_are_dead_addresses_too(self):
        os.environ["BROWSER_BROKER_SOCKET"] = os.path.join(self.dir, "missing.sock")
        self.assertTrue(self.provider.create_session("t")["cdp_url"].endswith("/broker-unavailable"))
        SECRETS["raise"] = True                                        # Hermes' scope error: fail closed
        self.assertTrue(self.provider.create_session("t")["cdp_url"].endswith("/broker-no-key"))
        SECRETS.clear()
        self.assertTrue(self.provider.create_session("t")["cdp_url"].endswith("/broker-no-key"))

    def test_close_uses_the_remembered_key_even_outside_a_profile_scope(self):
        self.provider.create_session("t")
        SECRETS["raise"] = True                                        # an atexit call has no profile scope
        self.assertTrue(self.provider.close_session("a" * 32))
        self.assertEqual(self.broker.calls[-1][0], "/v1/sessions/%s/close" % ("a" * 32))
        self.assertEqual(self.broker.calls[-1][1], "Bearer " + KEY)

    def test_closing_a_dead_session_is_a_no_op_and_cleanup_never_raises(self):
        before = len(self.broker.calls)
        self.assertTrue(self.provider.close_session(""))
        self.assertEqual(len(self.broker.calls), before)
        os.environ["BROWSER_BROKER_SOCKET"] = os.path.join(self.dir, "missing.sock")
        self.provider.emergency_cleanup("a" * 32)
        self.provider.emergency_cleanup("")

    def test_a_session_already_gone_counts_as_closed(self):
        self.provider.create_session("t")
        self.broker.fail = (404, {"error": "not_found"})
        self.assertTrue(self.provider.close_session("a" * 32))


class Tools(Case):
    def upload(self, **args):
        return json.loads(plugin._handle_browser_upload(args, task_id="t"))

    def test_uploads_the_newest_file_with_that_name_through_the_broker(self):
        self.provider.create_session("t")
        out = self.upload(selector="input[type=file]", file_name="cv.pdf")
        self.assertTrue(out["ok"], out)
        path, auth, body = self.broker.calls[-1]
        self.assertEqual(path, "/v1/sessions/%s/upload" % ("a" * 32))
        self.assertEqual(body, {"fileId": "file-new-0001", "selector": "input[type=file]"})
        self.assertEqual(self.upload(selector="#f", file_name="cv.docx")["ok"], True)

    def test_clear_errors_for_the_model_when_something_is_missing(self):
        self.assertEqual(self.upload(selector="#f", file_name="cv.pdf")["error"], "no_session")
        self.provider.create_session("t")
        self.assertEqual(self.upload(selector="#f", file_name="nope.pdf")["error"], "file_not_found")
        self.assertEqual(self.upload(selector="", file_name="cv.pdf")["error"], "bad_request")
        self.broker.fail = (400, {"error": "selector_not_found"})
        out = self.upload(selector="#x", file_name="cv.pdf")
        self.assertEqual(out["error"], "selector_not_found")
        self.assertIn("snapshot", out["hint"])
        SECRETS.pop("PLATFORM_AGENT_KEY")
        self.assertEqual(self.upload(selector="#f", file_name="cv.pdf")["error"], "no_key")

    def test_another_persons_key_cannot_reach_this_persons_session_or_files(self):
        self.provider.create_session("t")
        SECRETS["PLATFORM_AGENT_KEY"] = OTHER_KEY                      # a different profile's key
        self.assertEqual(self.upload(selector="#f", file_name="cv.pdf")["error"], "no_session")

    def test_waiting_flag(self):
        self.provider.create_session("t")
        self.assertTrue(json.loads(plugin._handle_browser_waiting({"waiting": True}))["ok"])
        self.assertEqual(self.broker.calls[-1][2], {"waiting": True})
        self.assertEqual(json.loads(plugin._handle_browser_waiting({"waiting": "yes"}))["error"], "bad_request")

    def test_the_key_never_appears_in_a_tool_result_or_a_log_line(self):
        self.provider.create_session("t")
        outputs = [plugin._handle_browser_upload({"selector": "#f", "file_name": "cv.pdf"}),
                   plugin._handle_browser_upload({"selector": "#f", "file_name": "nope.pdf"}),
                   plugin._handle_browser_waiting({"waiting": False})]
        self.broker.fail = (503, {"error": "busy"})
        self.provider.close_session("a" * 32)
        self.provider.create_session("t")
        self.assertFalse(any(KEY in text for text in outputs))
        self.assertFalse(any(KEY in line for line in self.capture.lines))


class Registration(unittest.TestCase):
    def test_registers_the_provider_and_both_tools_in_the_browser_toolset(self):
        seen = {"providers": [], "tools": {}}

        class Ctx:
            def register_browser_provider(self, p):
                seen["providers"].append(p.name)

            def register_tool(self, **kw):
                seen["tools"][kw["name"]] = kw

        plugin.register(Ctx())
        self.assertEqual(seen["providers"], ["broker"])
        self.assertEqual(set(seen["tools"]), {"browser_upload", "browser_waiting"})
        for kw in seen["tools"].values():
            self.assertEqual(kw["toolset"], "browser")
            self.assertTrue(callable(kw["handler"]))
            self.assertEqual(kw["schema"]["name"], kw["name"])
            self.assertEqual(kw["schema"]["parameters"]["type"], "object")
        self.assertEqual(seen["tools"]["browser_upload"]["schema"]["parameters"]["required"], ["selector", "file_name"])

    def test_the_manifest_lists_what_the_code_registers(self):
        with open(os.path.join(os.path.dirname(PLUGIN), "plugin.yaml")) as handle:
            text = handle.read()
        for name in ("browser_upload", "browser_waiting", "broker", "kind: backend"):
            self.assertIn(name, text)


if __name__ == "__main__":
    unittest.main()
