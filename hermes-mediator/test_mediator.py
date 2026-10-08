"""Tests for the Hermes mediator. Run: python3 -m unittest -v test_mediator (from this directory).

A fake upstream provider runs on loopback and records every request it receives,
so the tests can check exactly what the mediator forwards.
"""
import hashlib
import io
import json
import logging
import os
import tempfile
import threading
import unittest
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import mediator
from ledger import Ledger, cost_micro

UPSTREAM_KEY = "upstream-secret-key-value"
TENANT_TOKEN = "tenant-token-value-abc"
MODEL_PRICE = {"upstream": "real-upstream-model",
               "in_micro_per_mtok": 1000000,   # 1 micro-USD per prompt token
               "out_micro_per_mtok": 2000000}  # 2 micro-USD per completion token


class FakeUpstream:
    """Records requests; replies according to `mode` set by each test."""

    def __init__(self):
        self.requests = []
        self.mode = "json"  # json | stream_usage | stream_no_usage | error500

        outer = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, fmt, *args):
                return

            def do_POST(self):
                length = int(self.headers.get("Content-Length", 0))
                body = json.loads(self.rfile.read(length).decode("utf-8"))
                outer.requests.append({"path": self.path,
                                       "headers": dict(self.headers),
                                       "body": body})
                if outer.mode == "error500":
                    self.send_response(500)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                if outer.mode == "json":
                    data = json.dumps({
                        "id": "x", "object": "chat.completion",
                        "choices": [{"index": 0, "finish_reason": "stop",
                                     "message": {"role": "assistant", "content": "hi"}}],
                        "usage": {"prompt_tokens": 100, "completion_tokens": 10,
                                  "total_tokens": 110},
                    }).encode("utf-8")
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                    return
                # SSE modes
                chunks = [{"choices": [{"delta": {"content": "hi"}}]}]
                if outer.mode == "stream_usage":
                    chunks.append({"choices": [],
                                   "usage": {"prompt_tokens": 50, "completion_tokens": 5}})
                lines = [b"data: " + json.dumps(c).encode("utf-8") + b"\n\n" for c in chunks]
                lines.append(b"data: [DONE]\n\n")
                payload = b"".join(lines)
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(payload)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.server.daemon_threads = True
        self.url = "http://127.0.0.1:%d/v1" % self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class MediatorTest(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.key_path = os.path.join(self.tmp.name, "upstream.key")
        with open(self.key_path, "w") as fh:
            fh.write(UPSTREAM_KEY + "\n")
        os.chmod(self.key_path, 0o600)

        self.upstream = FakeUpstream()
        self.cfg = {
            "listen": "127.0.0.1:0",
            "db_path": os.path.join(self.tmp.name, "ledger.sqlite"),
            "upstream_base_url": self.upstream.url,
            "upstream_key_file": self.key_path,
            "max_output_tokens": 512,
            "default_output_tokens": 128,
            "max_body_bytes": 64 * 1024,
            "upstream_timeout_s": 5,
            "per_tenant_concurrency": 2,
            "models": {"hermes-test": MODEL_PRICE},
        }
        self.ledger = Ledger(self.cfg["db_path"])
        self.ledger.create_tenant("acme", hashlib.sha256(TENANT_TOKEN.encode()).hexdigest(),
                                  10000000, 0)  # 10 USD in micro
        self.server = mediator.make_server(self.cfg, self.ledger, UPSTREAM_KEY)
        self.base = "http://127.0.0.1:%d" % self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

        self.log_stream = io.StringIO()
        self.handler = logging.StreamHandler(self.log_stream)
        logging.getLogger("mediator").addHandler(self.handler)
        logging.getLogger("mediator").setLevel(logging.INFO)

    def tearDown(self):
        logging.getLogger("mediator").removeHandler(self.handler)
        self.server.shutdown()
        self.server.server_close()
        self.upstream.close()
        self.ledger.close()
        self.tmp.cleanup()

    # ---- helpers -------------------------------------------------------

    def post(self, body, token=TENANT_TOKEN, raw=None):
        data = raw if raw is not None else json.dumps(body).encode("utf-8")
        req = urllib.request.Request(self.base + "/v1/chat/completions", data=data,
                                     method="POST")
        req.add_header("Content-Type", "application/json")
        if token is not None:
            req.add_header("Authorization", "Bearer " + token)
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read()

    def request_body(self, **extra):
        body = {"model": "hermes-test",
                "messages": [{"role": "user", "content": "hello"}],
                "max_tokens": 64}
        body.update(extra)
        return body

    def balance(self):
        return self.ledger.balance("acme")

    def usage_rows(self):
        return self.ledger._db.execute(
            "SELECT model, prompt_tokens, completion_tokens, cost_micro, status FROM usage"
        ).fetchall()

    # ---- tests ---------------------------------------------------------

    def test_healthz_is_open(self):
        with urllib.request.urlopen(self.base + "/healthz", timeout=5) as resp:
            self.assertEqual(resp.status, 200)

    def test_missing_or_bad_token_is_401_and_upstream_untouched(self):
        status, _ = self.post(self.request_body(), token=None)
        self.assertEqual(status, 401)
        status, _ = self.post(self.request_body(), token="wrong")
        self.assertEqual(status, 401)
        self.assertEqual(self.upstream.requests, [])

    def test_disabled_tenant_is_403(self):
        self.ledger.set_enabled("acme", False)
        status, _ = self.post(self.request_body())
        self.assertEqual(status, 403)
        self.assertEqual(self.upstream.requests, [])

    def test_models_list_requires_auth_and_lists_public_names_only(self):
        req = urllib.request.Request(self.base + "/v1/models")
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(req, timeout=5)
        self.assertEqual(ctx.exception.code, 401)
        req.add_header("Authorization", "Bearer " + TENANT_TOKEN)
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read())
        self.assertEqual([m["id"] for m in data["data"]], ["hermes-test"])
        self.assertNotIn("real-upstream-model", json.dumps(data))

    def test_unknown_model_is_400(self):
        status, _ = self.post(self.request_body(model="gpt-whatever"))
        self.assertEqual(status, 400)
        self.assertEqual(self.upstream.requests, [])

    def test_invalid_json_and_bad_shapes_are_400(self):
        status, _ = self.post(None, raw=b"{not json")
        self.assertEqual(status, 400)
        status, _ = self.post({"model": "hermes-test", "messages": "nope"})
        self.assertEqual(status, 400)
        status, _ = self.post(self.request_body(max_tokens=0))
        self.assertEqual(status, 400)
        status, _ = self.post(self.request_body(max_tokens=True))
        self.assertEqual(status, 400)
        self.assertEqual(self.upstream.requests, [])

    def test_oversized_body_is_413(self):
        big = "x" * (self.cfg["max_body_bytes"] + 10)
        status, _ = self.post({"model": "hermes-test", "messages": [{"content": big}]})
        self.assertEqual(status, 413)
        self.assertEqual(self.upstream.requests, [])

    def test_insufficient_credit_is_402_and_upstream_untouched(self):
        self.ledger.add_credit("acme", -(10000000 - 100))  # leave 100 micro
        before = self.balance()
        status, _ = self.post(self.request_body())
        self.assertEqual(status, 402)
        self.assertEqual(self.upstream.requests, [])
        self.assertEqual(self.balance(), before)

    def test_json_success_charges_actual_cost_and_hides_key(self):
        before = self.balance()
        status, raw = self.post(self.request_body())
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(raw)["choices"][0]["message"]["content"], "hi")

        expected = cost_micro(100, 10, MODEL_PRICE)
        self.assertEqual(self.balance(), before - expected)
        rows = self.usage_rows()
        self.assertEqual(rows, [("hermes-test", 100, 10, expected, 200)])

        sent = self.upstream.requests[0]
        self.assertEqual(sent["body"]["model"], "real-upstream-model")
        self.assertEqual(sent["headers"]["Authorization"], "Bearer " + UPSTREAM_KEY)
        self.assertNotIn(TENANT_TOKEN, json.dumps(sent["body"]))
        self.assertNotIn(TENANT_TOKEN, json.dumps(sent["headers"]))

    def test_max_tokens_is_capped_by_config(self):
        self.post(self.request_body(max_tokens=10 ** 6))
        self.assertEqual(self.upstream.requests[0]["body"]["max_tokens"],
                         self.cfg["max_output_tokens"])

    def test_missing_max_tokens_uses_default(self):
        body = self.request_body()
        body.pop("max_tokens")
        self.post(body)
        self.assertEqual(self.upstream.requests[0]["body"]["max_tokens"],
                         self.cfg["default_output_tokens"])

    def test_tools_and_stream_flag_are_passed_through(self):
        tools = [{"type": "function", "function": {"name": "memory", "parameters": {}}}]
        self.post(self.request_body(tools=tools))
        sent = self.upstream.requests[0]["body"]
        self.assertEqual(sent["tools"], tools)

    def test_stream_with_usage_charges_actual_cost(self):
        self.upstream.mode = "stream_usage"
        before = self.balance()
        status, raw = self.post(self.request_body(stream=True))
        self.assertEqual(status, 200)
        self.assertIn(b"data: [DONE]", raw)
        expected = cost_micro(50, 5, MODEL_PRICE)
        self.assertEqual(self.balance(), before - expected)
        self.assertEqual(self.upstream.requests[0]["body"]["stream_options"],
                         {"include_usage": True})

    def test_stream_without_usage_charges_full_hold(self):
        self.upstream.mode = "stream_no_usage"
        before = self.balance()
        status, _ = self.post(self.request_body(stream=True))
        self.assertEqual(status, 200)
        reserved = cost_micro(
            (len(json.dumps([{"role": "user", "content": "hello"}], ensure_ascii=False))
             + len("[]")) // 2 + 1, 64, MODEL_PRICE)
        self.assertEqual(self.balance(), before - reserved)
        self.assertIn("usage_missing_charged_hold", self.log_stream.getvalue())

    def test_upstream_failure_refunds_hold_and_hides_upstream_body(self):
        self.upstream.mode = "error500"
        before = self.balance()
        status, raw = self.post(self.request_body())
        self.assertEqual(status, 502)
        self.assertEqual(self.balance(), before)
        self.assertNotIn(UPSTREAM_KEY.encode(), raw)

    def test_logs_contain_no_secrets_or_bodies(self):
        self.post(self.request_body(messages=[{"role": "user", "content": "private text"}]))
        logged = self.log_stream.getvalue()
        self.assertTrue(logged)
        self.assertNotIn(TENANT_TOKEN, logged)
        self.assertNotIn(UPSTREAM_KEY, logged)
        self.assertNotIn("private text", logged)

    def test_per_tenant_concurrency_limit(self):
        self.assertTrue(self.server.RequestHandlerClass.limiter.acquire("acme"))
        self.assertTrue(self.server.RequestHandlerClass.limiter.acquire("acme"))
        status, _ = self.post(self.request_body())
        self.assertEqual(status, 429)
        self.assertEqual(self.upstream.requests, [])


class CostAndLoadTest(unittest.TestCase):

    def test_cost_rounds_up(self):
        price = {"in_micro_per_mtok": 1, "out_micro_per_mtok": 1}
        self.assertEqual(cost_micro(1, 0, price), 1)  # 1 micro-token rounds up to 1 micro-USD

    def test_key_file_permissions_are_enforced(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "k")
            with open(path, "w") as fh:
                fh.write("k")
            os.chmod(path, 0o644)
            with self.assertRaises(SystemExit):
                mediator.load_upstream_key(path)
            os.chmod(path, 0o600)
            self.assertEqual(mediator.load_upstream_key(path), "k")

    def test_non_loopback_listen_is_refused(self):
        cfg = {"listen": "0.0.0.0:8790", "models": {}}
        with self.assertRaises(SystemExit):
            mediator.make_server(cfg, None, "k")


if __name__ == "__main__":
    unittest.main()
