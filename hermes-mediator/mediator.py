"""Loopback OpenAI-compatible mediator for Hermes tenants.

The tenant (Hermes) talks to this service with a per-tenant token. The service
checks the token, reserves credit, forwards the request with the upstream
provider key (which tenants never see), and settles the actual cost.

Only POST /v1/chat/completions, GET /v1/models and GET /healthz exist.
Stdlib only, Python 3.9+. See README.md.
"""
import hashlib
import json
import logging
import os
import stat
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from ledger import Ledger, cost_micro

log = logging.getLogger("mediator")

LOOPBACK_HOSTS = ("127.0.0.1", "::1", "localhost")


class Limiter:
    """At most `limit` in-flight requests per tenant."""

    def __init__(self, limit):
        self._limit = limit
        self._lock = threading.Lock()
        self._active = {}

    def acquire(self, tenant_id):
        with self._lock:
            count = self._active.get(tenant_id, 0)
            if count >= self._limit:
                return False
            self._active[tenant_id] = count + 1
            return True

    def release(self, tenant_id):
        with self._lock:
            count = self._active.get(tenant_id, 0) - 1
            if count <= 0:
                self._active.pop(tenant_id, None)
            else:
                self._active[tenant_id] = count


class Reservation:
    """A credit hold that is settled exactly once; unsettled holds are refunded."""

    def __init__(self, ledger, tenant_id, amount_micro, model):
        self._ledger = ledger
        self._tenant_id = tenant_id
        self._amount = amount_micro
        self._model = model
        self._settled = False

    def settle(self, actual_micro, model, prompt_tokens, completion_tokens, status):
        if self._settled:
            return
        self._settled = True
        self._ledger.settle(self._tenant_id, self._amount, actual_micro,
                            model, prompt_tokens, completion_tokens, status,
                            int(time.time()))

    def refund_if_open(self):
        self.settle(0, self._model, 0, 0, 0)

    def charge_full_hold(self):
        """Used when the provider gave no usage: charge the reserved amount, not less."""
        self.settle(self._amount, self._model, 0, 0, 200)


def load_upstream_key(path):
    """Refuse to start if the key file is readable by group or others."""
    mode = stat.S_IMODE(os.stat(path).st_mode)
    if mode & 0o077:
        raise SystemExit("upstream key file must not be group/world accessible: %s" % path)
    with open(path, "r", encoding="utf-8") as fh:
        key = fh.read().strip()
    if not key:
        raise SystemExit("upstream key file is empty")
    return key


class Handler(BaseHTTPRequestHandler):
    # Set per server by make_server().
    cfg = None
    ledger = None
    upstream_key = None
    limiter = None

    server_version = "hermes-mediator"
    sys_version = ""

    def log_message(self, fmt, *args):
        # The default access log prints request lines; keep stderr to our own records.
        return

    # ---- helpers -------------------------------------------------------

    def _send_json(self, status, payload):
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _error(self, status, code, message):
        self._send_json(status, {"error": {"message": message, "type": code, "code": code}})

    def _authenticate(self):
        header = self.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            self._error(401, "unauthorized", "missing bearer token")
            return None
        token = header[len("Bearer "):].strip()
        if not token:
            self._error(401, "unauthorized", "missing bearer token")
            return None
        digest = hashlib.sha256(token.encode("utf-8")).hexdigest()
        found = self.ledger.tenant_by_token_hash(digest)
        if found is None:
            self._error(401, "unauthorized", "invalid token")
            return None
        tenant_id, enabled = found
        if not enabled:
            self._error(403, "forbidden", "tenant disabled")
            return None
        return tenant_id

    def _audit(self, tenant_id, model, status, prompt_tokens, completion_tokens,
               cost, started, note=""):
        # Metadata only: never the request body, headers, token or upstream key.
        log.info(json.dumps({
            "tenant": tenant_id,
            "model": model,
            "status": status,
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "cost_micro": cost,
            "ms": int((time.time() - started) * 1000),
            "note": note,
        }, sort_keys=True))

    # ---- routes --------------------------------------------------------

    def do_GET(self):
        if self.path == "/healthz":
            return self._send_json(200, {"ok": True})
        if self.path == "/v1/models":
            if self._authenticate() is None:
                return None
            data = [{"id": name, "object": "model", "owned_by": "mediator"}
                    for name in sorted(self.cfg["models"])]
            return self._send_json(200, {"object": "list", "data": data})
        return self._error(404, "not_found", "not found")

    def do_POST(self):
        if self.path != "/v1/chat/completions":
            return self._error(404, "not_found", "not found")
        started = time.time()
        tenant_id = self._authenticate()
        if tenant_id is None:
            return None

        length_header = self.headers.get("Content-Length", "")
        try:
            length = int(length_header)
        except ValueError:
            return self._error(400, "invalid_request", "Content-Length required")
        if length <= 0:
            return self._error(400, "invalid_request", "empty body")
        if length > self.cfg["max_body_bytes"]:
            return self._error(413, "payload_too_large", "request body too large")

        try:
            body = json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return self._error(400, "invalid_request", "body is not valid JSON")
        if not isinstance(body, dict) or not isinstance(body.get("messages"), list):
            return self._error(400, "invalid_request", "messages must be a list")

        public_model = body.get("model")
        model_cfg = self.cfg["models"].get(public_model)
        if model_cfg is None:
            return self._error(400, "model_not_allowed", "model is not available")

        requested = body.get("max_completion_tokens", body.get("max_tokens"))
        if requested is None:
            requested = self.cfg["default_output_tokens"]
        if isinstance(requested, bool) or not isinstance(requested, int) or requested < 1:
            return self._error(400, "invalid_request", "max_tokens must be a positive integer")
        out_limit = min(requested, self.cfg["max_output_tokens"])

        # Conservative prompt estimate: about 2 characters per token, plus tools.
        est_prompt = (len(json.dumps(body["messages"], ensure_ascii=False))
                      + len(json.dumps(body.get("tools", []), ensure_ascii=False))) // 2 + 1
        reserve = cost_micro(est_prompt, out_limit, model_cfg)

        if not self.limiter.acquire(tenant_id):
            return self._error(429, "rate_limited", "too many concurrent requests")
        try:
            if not self.ledger.reserve(tenant_id, reserve):
                self._audit(tenant_id, public_model, 402, 0, 0, 0, started, "insufficient_credit")
                return self._error(402, "insufficient_credit", "insufficient credit")
            hold = Reservation(self.ledger, tenant_id, reserve, public_model)
            try:
                self._forward(tenant_id, public_model, model_cfg, body, out_limit,
                              bool(body.get("stream")), hold, started)
            except Exception as exc:  # noqa: BLE001 - must refund on any failure
                hold.refund_if_open()
                self._audit(tenant_id, public_model, 500, 0, 0, 0, started,
                            type(exc).__name__)
                try:
                    self._error(500, "internal_error", "internal error")
                except OSError:
                    pass
            else:
                hold.refund_if_open()
        finally:
            self.limiter.release(tenant_id)
        return None

    # ---- upstream ------------------------------------------------------

    def _forward(self, tenant_id, public_model, model_cfg, body, out_limit, stream,
                 hold, started):
        upstream_body = dict(body)
        upstream_body["model"] = model_cfg["upstream"]
        upstream_body.pop("max_completion_tokens", None)
        upstream_body["max_tokens"] = out_limit
        if stream:
            upstream_body["stream_options"] = {"include_usage": True}

        url = self.cfg["upstream_base_url"].rstrip("/") + "/chat/completions"
        req = urllib.request.Request(
            url,
            data=json.dumps(upstream_body).encode("utf-8"),
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Authorization": "Bearer " + self.upstream_key,
                "User-Agent": "hermes-mediator",
            },
        )
        try:
            resp = urllib.request.urlopen(req, timeout=self.cfg["upstream_timeout_s"])
        except urllib.error.HTTPError as exc:
            exc.read()  # drain; never relay upstream error bodies (they may echo input)
            # Refund before replying, so the client never sees a stale balance.
            hold.refund_if_open()
            self._audit(tenant_id, public_model, 502, 0, 0, 0, started,
                        "upstream_http_%d" % exc.code)
            return self._error(502, "upstream_error", "upstream provider rejected the request")
        except (urllib.error.URLError, OSError):
            hold.refund_if_open()
            self._audit(tenant_id, public_model, 502, 0, 0, 0, started, "upstream_unreachable")
            return self._error(502, "upstream_error", "upstream provider unreachable")

        with resp:
            if stream:
                return self._relay_stream(resp, tenant_id, public_model, model_cfg,
                                          hold, started)
            return self._relay_json(resp, tenant_id, public_model, model_cfg, hold, started)

    def _relay_json(self, resp, tenant_id, public_model, model_cfg, hold, started):
        raw = resp.read(self.cfg["max_body_bytes"] + 1)
        try:
            data = json.loads(raw.decode("utf-8"))
            usage = data.get("usage") or {}
            pt = int(usage.get("prompt_tokens", 0))
            ct = int(usage.get("completion_tokens", 0))
        except (ValueError, TypeError, AttributeError, UnicodeDecodeError):
            hold.refund_if_open()
            self._audit(tenant_id, public_model, 502, 0, 0, 0, started, "bad_upstream_json")
            return self._error(502, "upstream_error", "upstream returned an invalid response")

        cost = cost_micro(pt, ct, model_cfg)
        hold.settle(cost, public_model, pt, ct, 200)
        self._audit(tenant_id, public_model, 200, pt, ct, cost, started)
        data_bytes = json.dumps(data).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data_bytes)))
        self.end_headers()
        self.wfile.write(data_bytes)
        return None

    def _relay_stream(self, resp, tenant_id, public_model, model_cfg, hold, started):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()

        usage = None
        client_gone = False
        for line in resp:
            if line.startswith(b"data:") and b"[DONE]" not in line:
                try:
                    chunk = json.loads(line[len(b"data:"):].decode("utf-8"))
                    if chunk.get("usage"):
                        usage = chunk["usage"]
                except (ValueError, AttributeError, UnicodeDecodeError):
                    pass
            if not client_gone:
                try:
                    self.wfile.write(line)
                    self.wfile.flush()
                except OSError:
                    # Client left. Keep reading so usage is still settled.
                    client_gone = True

        if usage is None:
            # No usage reported: charge the full hold rather than guess low.
            hold.charge_full_hold()
            self._audit(tenant_id, public_model, 200, 0, 0, 0, started,
                        "usage_missing_charged_hold")
            return None
        pt = int(usage.get("prompt_tokens", 0))
        ct = int(usage.get("completion_tokens", 0))
        cost = cost_micro(pt, ct, model_cfg)
        hold.settle(cost, public_model, pt, ct, 200)
        self._audit(tenant_id, public_model, 200, pt, ct, cost, started,
                    "client_disconnected" if client_gone else "")
        return None


class _Server(ThreadingHTTPServer):
    daemon_threads = True


def make_server(cfg, ledger, upstream_key):
    host, port = cfg["listen"].rsplit(":", 1)
    if host not in LOOPBACK_HOSTS:
        raise SystemExit("refusing to listen on non-loopback address: %s" % host)
    handler = type("MediatorHandler", (Handler,), {
        "cfg": cfg,
        "ledger": ledger,
        "upstream_key": upstream_key,
        "limiter": Limiter(cfg["per_tenant_concurrency"]),
    })
    return _Server((host, int(port)), handler)


def load_config(path):
    with open(path, "r", encoding="utf-8") as fh:
        cfg = json.load(fh)
    required = ("listen", "db_path", "upstream_base_url", "upstream_key_file",
                "max_output_tokens", "default_output_tokens", "max_body_bytes",
                "upstream_timeout_s", "per_tenant_concurrency", "models")
    missing = [k for k in required if k not in cfg]
    if missing:
        raise SystemExit("config missing keys: %s" % ", ".join(missing))
    for name, price in cfg["models"].items():
        for key in ("upstream", "in_micro_per_mtok", "out_micro_per_mtok"):
            if key not in price:
                raise SystemExit("model %s missing %s" % (name, key))
    return cfg


def main(argv):
    if len(argv) != 2:
        print("usage: mediator.py CONFIG.json", file=sys.stderr)
        return 2
    logging.basicConfig(level=logging.INFO, format="%(message)s", stream=sys.stderr)
    cfg = load_config(argv[1])
    key = load_upstream_key(cfg["upstream_key_file"])
    ledger = Ledger(cfg["db_path"])
    server = make_server(cfg, ledger, key)
    log.info(json.dumps({"event": "listening", "listen": cfg["listen"]}))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
