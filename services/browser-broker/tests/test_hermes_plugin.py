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
        self.waiting = False             # is the one fake session waiting for the person?
        self.page_changed = True         # did the last submit lead to a new page?
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

    def do_GET(self):
        self.server.calls.append((self.path, self.headers.get("Authorization", ""), None))
        if self.server.fail:
            return self._reply(*self.server.fail)
        self._reply(200, {"id": "a" * 32, "state": "ready", "waiting": self.server.waiting})

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        auth = self.headers.get("Authorization", "")
        self.server.calls.append((self.path, auth, body))
        if self.path == "/v1/sessions/resume":
            if self.server.waiting:
                self.server.waiting = False
                return self._reply(200, {"id": "a" * 32, "state": "ready", "waiting": False,
                                         "cdpUrl": "ws://127.0.0.1:45678/devtools/browser/0a1b2c3d-1111-2222"})
            return self._reply(404, {"error": "no_waiting_session"})
        if self.server.fail:
            return self._reply(*self.server.fail)
        if self.path == "/v1/sessions":
            return self._reply(201, {"id": "a" * 32, "state": "ready",
                                     "cdpUrl": "ws://127.0.0.1:45678/devtools/browser/0a1b2c3d-1111-2222"})
        if self.path.endswith("/submit"):
            return self._reply(200, {"clicked": "Submit order", "changed": self.server.page_changed, "url": "https://shop.test/done",
                                     "urlBefore": "https://shop.test/form", "title": "Thanks", "text": "Thank you for your order",
                                     "invalid": [] if self.server.page_changed else ["custname"], "attachment": True})
        if self.path.endswith("/proof"):
            return self._reply(200, {"attachment": True})
        if self.path.endswith("/release"):
            self.server.waiting = True
            return self._reply(200, {"id": "a" * 32, "state": "ready", "waiting": True})
        if self.path.endswith("/waiting"):
            self.server.waiting = bool(body.get("waiting"))
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
        plugin._DONE.clear()
        plugin._LAST_PROOF.clear()
        os.environ.pop("BROKER_PROOF", None)
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

    def test_what_happens_is_logged_where_hermes_writes_its_log(self):
        capture = Capture()
        hermes_side = logging.getLogger("tools")                 # a namespace Hermes' log file collects
        hermes_side.addHandler(capture)
        hermes_side.setLevel(logging.DEBUG)
        try:
            self.provider.create_session("task-9")
            self.broker.fail = (503, {"error": "busy"})
            self.provider.create_session("task-9")
        finally:
            hermes_side.removeHandler(capture)
        text = "\n".join(capture.lines)
        self.assertIn("opened for task task-9", text)
        self.assertIn("gave no browser (busy)", text)
        self.assertNotIn(KEY, text)

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
        self.assertTrue(self.provider.close_session("a" * 32))         # kept for the grace period, with the remembered key
        self.assertEqual(self.broker.calls[-1][0], "/v1/sessions/%s/release" % ("a" * 32))
        self.assertEqual(self.broker.calls[-1][1], "Bearer " + KEY)
        self.provider.emergency_cleanup("a" * 32)                      # and closed for real at exit, with the same key
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


class Waiting(Case):
    def test_a_session_waiting_for_the_person_is_not_closed_when_hermes_finishes_its_reply(self):
        self.provider.create_session("t1")
        self.broker.waiting = True
        before = len(self.broker.calls)
        self.assertTrue(self.provider.close_session("a" * 32))
        sent = [path for path, _, _ in self.broker.calls[before:] if not path.endswith("/proof")]
        self.assertEqual(sent, ["/v1/sessions/%s" % ("a" * 32)])           # it only looked (and sent a picture); no close
        self.assertIn("a" * 32, plugin._KEY_OF_SESSION)                    # still remembered, so it can be closed later

    def test_a_browser_nobody_declared_waiting_is_still_kept_for_a_grace_period(self):
        self.provider.create_session("t1")
        self.broker.waiting = False                              # the assistant never called browser_waiting
        self.assertTrue(self.provider.close_session("a" * 32))
        paths = [path for path, _, _ in self.broker.calls]
        self.assertEqual(paths[-1], "/v1/sessions/%s/release" % ("a" * 32))      # released, not closed
        self.assertNotIn("/v1/sessions/%s/close" % ("a" * 32), paths)
        info = self.provider.create_session("t2")                # the next task gets it back
        self.assertEqual([p for p, _, _ in self.broker.calls][-1], "/v1/sessions/resume")
        self.assertEqual(info["bb_session_id"], "a" * 32)

    def test_when_the_assistant_says_it_is_finished_the_browser_is_closed_at_once(self):
        self.provider.create_session("t1")
        self.assertTrue(json.loads(plugin._handle_browser_waiting({"waiting": False}))["ok"])
        self.assertTrue(self.provider.close_session("a" * 32))
        self.assertEqual(self.broker.calls[-1][0], "/v1/sessions/%s/close" % ("a" * 32))
        self.assertNotIn("a" * 32, plugin._KEY_OF_SESSION)

    def test_waiting_true_after_finished_keeps_it_again(self):
        self.provider.create_session("t1")
        plugin._handle_browser_waiting({"waiting": False})
        plugin._handle_browser_waiting({"waiting": True})
        self.provider.close_session("a" * 32)
        self.assertNotEqual(self.broker.calls[-1][0], "/v1/sessions/%s/close" % ("a" * 32))

    def test_emergency_cleanup_always_closes_even_a_waiting_browser(self):
        self.provider.create_session("t1")
        self.broker.waiting = True
        self.provider.emergency_cleanup("a" * 32)
        self.assertEqual(self.broker.calls[-1][0], "/v1/sessions/%s/close" % ("a" * 32))

    def test_the_next_task_gets_the_waiting_session_back_instead_of_a_new_browser(self):
        self.provider.create_session("t1")
        self.broker.waiting = True
        self.provider.close_session("a" * 32)                              # kept
        info = self.provider.create_session("t2")
        paths = [path for path, _, _ in self.broker.calls]
        self.assertEqual(paths[-1], "/v1/sessions/resume")                 # resumed, no second POST /v1/sessions
        self.assertEqual(paths.count("/v1/sessions"), 1)
        self.assertEqual(info["bb_session_id"], "a" * 32)
        self.assertEqual(info["cdp_url"], "ws://127.0.0.1:45678/devtools/browser/0a1b2c3d-1111-2222")

    def test_with_nothing_waiting_a_new_browser_is_made(self):
        info = self.provider.create_session("t1")
        paths = [path for path, _, _ in self.broker.calls]
        self.assertEqual(paths[:2], ["/v1/sessions/resume", "/v1/sessions"])
        self.assertEqual(info["bb_session_id"], "a" * 32)

    def test_a_broker_that_is_down_still_gives_a_dead_address_not_a_local_browser(self):
        os.environ["BROWSER_BROKER_SOCKET"] = os.path.join(self.dir, "missing.sock")
        self.assertTrue(self.provider.create_session("t1")["cdp_url"].endswith("/broker-unavailable"))


class Proof(Case):
    def sent(self):
        return [p for p, _, _ in self.broker.calls if p.endswith("/proof")]

    def test_a_picture_of_the_page_is_sent_when_the_reply_that_used_the_browser_ends(self):
        self.provider.create_session("t1")
        self.provider.close_session("a" * 32)
        self.assertEqual(self.sent(), ["/v1/sessions/%s/proof" % ("a" * 32)])
        calls = [p for p, _, _ in self.broker.calls]
        self.assertLess(calls.index("/v1/sessions/%s/proof" % ("a" * 32)), calls.index("/v1/sessions/%s/release" % ("a" * 32)))

    def test_not_twice_in_a_row_and_never_at_exit(self):
        self.provider.create_session("t1")
        self.provider.close_session("a" * 32)
        self.provider.close_session("a" * 32)                          # a picture was just sent
        self.assertEqual(len(self.sent()), 1)
        self.provider.emergency_cleanup("a" * 32)                      # nobody is waiting for a picture at exit
        self.assertEqual(len(self.sent()), 1)

    def test_it_can_be_switched_off(self):
        os.environ["BROKER_PROOF"] = "0"
        self.provider.create_session("t1")
        self.provider.close_session("a" * 32)
        self.assertEqual(self.sent(), [])

    def test_a_picture_that_fails_never_stops_the_session_from_being_kept(self):
        self.provider.create_session("t1")
        self.broker.fail = (500, {"error": "internal_error"})
        self.assertTrue(self.provider.close_session("a" * 32) in (True, False))      # no exception


class Submit(Case):
    def go(self, **args):
        return json.loads(plugin._handle_browser_submit(args, task_id="t"))

    def test_the_result_of_the_click_comes_back_as_what_the_page_shows(self):
        self.provider.create_session("t1")
        out = self.go(text="Submit order")
        self.assertEqual((out["ok"], out["page_changed"], out["title"], out["page_text"], out["picture_sent_to_user"]),
                         (True, True, "Thanks", "Thank you for your order", True))
        path, auth, body = self.broker.calls[-1]
        self.assertEqual((path, body, auth), ("/v1/sessions/%s/submit" % ("a" * 32), {"text": "Submit order"}, "Bearer " + KEY))
        self.assertIn("Report exactly what it shows", out["hint"])

    def test_a_form_the_browser_refused_is_not_reported_as_sent(self):
        self.provider.create_session("t1")
        self.broker.page_changed = False
        out = self.go(selector="#go")
        self.assertEqual((out["ok"], out["page_changed"], out["invalid_fields"]), (True, False, ["custname"]))
        self.assertIn("refused to send", out["hint"])

    def test_it_needs_a_browser_and_some_words_and_it_does_not_double_up_the_picture(self):
        self.assertEqual(self.go(text="Go")["error"], "no_session")
        self.provider.create_session("t1")
        self.assertEqual(self.go()["error"], "bad_request")
        self.go(text="Submit order")
        before = len([p for p, _, _ in self.broker.calls if p.endswith("/proof")])
        self.provider.close_session("a" * 32)                          # its own picture was just sent
        self.assertEqual(len([p for p, _, _ in self.broker.calls if p.endswith("/proof")]), before)

    def test_broker_errors_come_back_as_clear_reasons(self):
        self.provider.create_session("t1")
        self.broker.fail = (400, {"error": "selector_not_found"})
        out = self.go(text="Nope")
        self.assertEqual((out["ok"], out["error"]), (False, "selector_not_found"))


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
        self.assertEqual(set(seen["tools"]), {"browser_upload", "browser_waiting", "browser_submit"})
        for kw in seen["tools"].values():
            self.assertEqual(kw["toolset"], "browser")
            self.assertTrue(callable(kw["handler"]))
            self.assertEqual(kw["schema"]["name"], kw["name"])
            self.assertEqual(kw["schema"]["parameters"]["type"], "object")
        self.assertEqual(seen["tools"]["browser_upload"]["schema"]["parameters"]["required"], ["selector", "file_name"])

    def test_the_manifest_lists_what_the_code_registers(self):
        with open(os.path.join(os.path.dirname(PLUGIN), "plugin.yaml")) as handle:
            text = handle.read()
        for name in ("browser_upload", "browser_waiting", "browser_submit", "broker", "kind: backend"):
            self.assertIn(name, text)


if __name__ == "__main__":
    unittest.main()
