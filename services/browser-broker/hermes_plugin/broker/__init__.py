"""
Hermes browser provider "broker" and two tools, for the multi-user browser service.

  browser.cloud_provider: broker      (in a profile's config.yaml)

How it fits (see docs/browser-service-phase1-hermes.md):
  * create_session -> the broker (a unix socket, the person's agent key) makes an isolated container and
    returns a loopback DevTools address whose path is a secret. Hermes drives that browser with its own tools.
  * browser_upload -> puts one of the person's saved files into an <input type=file> on the page.
  * browser_waiting -> tells the broker the session is waiting for the person (a shorter limit applies).

Safety rule that shapes the code: Hermes falls back to a Chromium ON THIS MACHINE when a provider raises,
or says it is unavailable. That would run outside every limit and firewall rule, so this provider
never raises and is always available. When the broker cannot give a browser it returns a session whose
DevTools address is dead on purpose (port 9, with the reason in the path); the browser tools then fail with
a connection error that names the reason, and no local browser is started.

One file on purpose: the plugin loader's import path for user plugins is not something to depend on.
Python 3.9 compatible. Standard library plus Hermes' own modules.
"""
from __future__ import annotations

import hashlib
import http.client
import json
import logging
import os
import socket
import threading
import time
import urllib.error
import urllib.request
from typing import Any, Dict, Optional

from agent.browser_provider import BrowserProvider

try:
    from agent.secret_scope import get_secret
except Exception:  # pragma: no cover - only if Hermes moves it
    def get_secret(name, default=None):
        return os.environ.get(name, default)

# Under "tools." on purpose: Hermes writes only some logger namespaces (hermes_cli, tools, agent, aiohttp) to
# agent.log, and the module's own name is not one of them, so its warnings would never be seen.
logger = logging.getLogger("tools.browser_broker")

DEFAULT_SOCKET = "/run/browser-broker/broker.sock"
# Reasons the broker can give a person, as the last part of the dead address (letters and hyphens only).
_REASONS = {
    "busy": "busy", "user_busy": "busy", "quota_exceeded": "quota", "unauthorized": "unauthorized",
    "start_failed": "start-failed", "unavailable": "unavailable",
}

_lock = threading.Lock()
_KEY_OF_SESSION: Dict[str, str] = {}      # broker session id -> agent key (memory only; closes may run outside a profile scope)
_LATEST: Dict[str, str] = {}              # sha256(agent key) -> its open session id (the broker allows one per person)
_DONE: set = set()                        # sessions the assistant said it is finished with: closed at once, not kept
_LAST_PROOF: Dict[str, float] = {}        # session id -> when a picture of its page last went to the person
PROOF_EVERY_S = 30                        # one picture is enough for actions this close together


def _socket_path() -> str:
    return os.environ.get("BROWSER_BROKER_SOCKET", DEFAULT_SOCKET)


def _agent_key() -> Optional[str]:
    try:
        key = get_secret("PLATFORM_AGENT_KEY")
    except Exception:
        return None
    return key.strip() if isinstance(key, str) and key.strip() else None


def _platform_url() -> str:
    try:
        return (get_secret("PLATFORM_URL") or "").rstrip("/")
    except Exception:
        return ""


def _proof_enabled() -> bool:
    return os.environ.get("BROKER_PROOF", "1").strip().lower() not in ("0", "false", "no", "off")


def _who(key: str) -> str:
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------- the broker, over its socket
class BrokerError(Exception):
    def __init__(self, code: str, status: int = 0):
        super().__init__(code)
        self.code = code
        self.status = status


class _Unix(http.client.HTTPConnection):
    def __init__(self, path: str, timeout: float):
        super().__init__("localhost", timeout=timeout)
        self._path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self._path)


def broker_call(method: str, path: str, key: str, body: Optional[dict] = None, timeout: float = 120.0) -> dict:
    conn = _Unix(_socket_path(), timeout)
    try:
        headers = {"Authorization": "Bearer " + key, "Content-Type": "application/json"}
        conn.request(method, path, json.dumps(body) if body is not None else None, headers)
        response = conn.getresponse()
        data = json.loads(response.read() or b"{}")
    except (OSError, http.client.HTTPException, ValueError):
        raise BrokerError("unavailable")
    finally:
        conn.close()
    if response.status >= 400:
        raise BrokerError(str(data.get("error", "unavailable")), response.status)
    return data


# ---------------------------------------------------------------------- the provider
def _dead_session(reason: str) -> Dict[str, object]:
    logger.warning("browser broker gave no browser (%s); the browser tools will fail instead of using a local browser", reason)
    return {
        "session_name": "broker-" + reason,
        "bb_session_id": "",
        "cdp_url": "ws://127.0.0.1:9/devtools/browser/broker-" + reason,
        "features": {"isolated": True, "error": reason},
    }


class BrokerBrowserProvider(BrowserProvider):
    @property
    def name(self) -> str:
        return "broker"

    @property
    def display_name(self) -> str:
        return "Isolated browser (broker)"

    def is_available(self) -> bool:
        # Always true on purpose: "unavailable" makes Hermes fall back to a browser on this machine.
        return True

    def create_session(self, task_id: str) -> Dict[str, object]:
        key = _agent_key()
        if not key:
            return _dead_session("no-key")
        try:
            try:
                # A session kept open while it waited for the person (a missing answer, a confirmation): the page is
                # as they left it. Otherwise a fresh browser is made.
                made = broker_call("POST", "/v1/sessions/resume", key, timeout=30.0)
                logger.info("browser broker session %s resumed for task %s", str(made.get("id", ""))[:12], task_id)
            except BrokerError as error:
                if error.code != "no_waiting_session":
                    raise
                made = broker_call("POST", "/v1/sessions", key)
            session_id, url = str(made["id"]), str(made["cdpUrl"])
        except BrokerError as error:
            return _dead_session(_REASONS.get(error.code, "unavailable"))
        except Exception:
            return _dead_session("unavailable")
        with _lock:
            _KEY_OF_SESSION[session_id] = key
            _LATEST[_who(key)] = session_id
        logger.info("browser broker session %s opened for task %s", session_id[:12], task_id)
        return {"session_name": "broker-" + session_id[:12], "bb_session_id": session_id, "cdp_url": url,
                "features": {"isolated": True}}

    def close_session(self, session_id: str) -> bool:
        if not session_id:
            return True                               # a dead session holds nothing
        with _lock:
            key = _KEY_OF_SESSION.get(session_id)
            done = session_id in _DONE
        key = key or _agent_key()
        if not key:
            return False
        self._send_proof(session_id, key)
        if not done:
            # Hermes closes its browser every time it finishes a reply, and a person's answer can come minutes later.
            # So a browser is kept for a grace period (the broker closes it itself if nobody comes back), unless the
            # assistant said it is finished (browser_waiting(false)).
            try:
                view = broker_call("GET", "/v1/sessions/%s" % session_id, key, timeout=15.0)
                if view.get("waiting") is not True:
                    broker_call("POST", "/v1/sessions/%s/release" % session_id, key, timeout=15.0)
                logger.info("browser broker session %s kept open for the person", session_id[:12])
                return True
            except BrokerError as error:
                if error.code == "not_found":
                    self._forget(session_id, key)
                    return True
            except Exception:
                pass                                   # could not keep it: close it
        return self._close_now(session_id, key)

    def _send_proof(self, session_id: str, key: str) -> None:
        """A picture of the page the browser ends on goes to the person with the reply: evidence that does not rest on
        what the assistant says it did. Best effort, and skipped when one was just sent (browser_submit sends its own)."""
        if not _proof_enabled():
            return
        with _lock:
            recent = time.time() - _LAST_PROOF.get(session_id, 0.0) < PROOF_EVERY_S
        if recent:
            return
        try:
            broker_call("POST", "/v1/sessions/%s/proof" % session_id, key, {"caption": "Page snapshot"}, timeout=40.0)
            with _lock:
                _LAST_PROOF[session_id] = time.time()
        except Exception:
            pass

    def _forget(self, session_id: str, key: str) -> None:
        with _lock:
            _KEY_OF_SESSION.pop(session_id, None)
            _DONE.discard(session_id)
            _LAST_PROOF.pop(session_id, None)
            if _LATEST.get(_who(key)) == session_id:
                del _LATEST[_who(key)]

    def _close_now(self, session_id: str, key: str) -> bool:
        self._forget(session_id, key)
        try:
            broker_call("POST", "/v1/sessions/%s/close" % session_id, key, timeout=30.0)
            return True
        except BrokerError as error:
            return error.code == "not_found"           # already gone is fine
        except Exception:
            return False

    def emergency_cleanup(self, session_id: str) -> None:
        """Process exit or a signal: nobody will come back, so close for real."""
        try:
            if not session_id:
                return
            with _lock:
                key = _KEY_OF_SESSION.get(session_id)
            key = key or _agent_key()
            if key:
                self._close_now(session_id, key)
        except Exception:
            pass


# ---------------------------------------------------------------------- tools
def _result(data: Dict[str, Any]) -> str:
    return json.dumps(data, ensure_ascii=False)


def _current_session(key: str) -> Optional[str]:
    with _lock:
        return _LATEST.get(_who(key))


def _find_file_id(key: str, name: str) -> Optional[str]:
    """The id of the person's saved file with exactly this name (the newest, if several)."""
    base = _platform_url()
    if not base:
        raise BrokerError("platform_unavailable")
    request = urllib.request.Request(base + "/api/agent/context", headers={"Authorization": "Bearer " + key})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            files = json.loads(response.read()).get("files", [])
    except (urllib.error.URLError, OSError, ValueError):
        raise BrokerError("platform_unavailable")
    for item in files:
        if item.get("name") == name and item.get("id"):
            return str(item["id"])
    return None


_UPLOAD_HINTS = {
    "selector_not_found": "No element matches that selector on the current page. Use a snapshot to find the file input.",
    "not_a_file_input": "That element is not a file input (input type=file). Pick the file input itself.",
    "not_found": "The browser session or the file was not found.",
    "not_ready": "The browser session is not ready yet.",
    "too_many_uploads": "This browser session has reached its upload limit.",
    "file_too_large": "The file is larger than the upload limit.",
    "platform_unavailable": "The platform could not be reached.",
    "browser_unavailable": "The browser could not be reached.",
    "browser_error": "The browser refused the request.",
}


def _handle_browser_upload(args: dict, **kwargs) -> str:
    selector = str((args or {}).get("selector", "")).strip()
    file_name = str((args or {}).get("file_name", "")).strip()
    if not selector or not file_name:
        return _result({"ok": False, "error": "bad_request", "hint": "Give both selector and file_name."})
    key = _agent_key()
    if not key:
        return _result({"ok": False, "error": "no_key", "hint": "No agent key is set for this profile."})
    session_id = _current_session(key)
    if not session_id:
        return _result({"ok": False, "error": "no_session",
                        "hint": "No isolated browser is open. Open the page with the browser tools first."})
    try:
        file_id = _find_file_id(key, file_name)
        if not file_id:
            return _result({"ok": False, "error": "file_not_found",
                            "hint": "None of the person's saved files has exactly that name."})
        broker_call("POST", "/v1/sessions/%s/upload" % session_id, key, {"fileId": file_id, "selector": selector})
    except BrokerError as error:
        return _result({"ok": False, "error": error.code, "hint": _UPLOAD_HINTS.get(error.code, "The upload failed.")})
    return _result({"ok": True, "message": "The file was put into the page's file input. Submit the form yourself when the person has confirmed."})


def _handle_browser_submit(args: dict, **kwargs) -> str:
    text = str((args or {}).get("text", "")).strip()
    selector = str((args or {}).get("selector", "")).strip()
    if not (text or selector):
        return _result({"ok": False, "error": "bad_request", "hint": "Give the button's words (text) or its CSS selector."})
    key = _agent_key()
    session_id = _current_session(key) if key else None
    if not (key and session_id):
        return _result({"ok": False, "error": "no_session", "hint": "No isolated browser is open."})
    body = {k: v for k, v in (("text", text), ("selector", selector)) if v}
    try:
        found = broker_call("POST", "/v1/sessions/%s/submit" % session_id, key, body, timeout=90.0)
    except BrokerError as error:
        return _result({"ok": False, "error": error.code, "hint": _UPLOAD_HINTS.get(error.code, "The click failed.")})
    sent = bool(found.get("attachment"))
    if sent:
        with _lock:
            _LAST_PROOF[session_id] = time.time()
    invalid = found.get("invalid") or []
    if found.get("changed") and found.get("url") != found.get("urlBefore"):
        hint = ("The page changed. Report exactly what it shows (page_text), in the user's language. "
                "Say it was submitted only if the text is a confirmation.")
    elif invalid:
        hint = "The browser refused to send the form: these fields are empty or invalid: %s. Fix them, then submit again." % ", ".join(map(str, invalid))
    else:
        hint = "The page did not change. The form may not have been sent. Do not say it was submitted; look at the page and tell the user."
    return _result({
        "ok": True, "clicked": found.get("clicked", ""), "page_changed": bool(found.get("changed")),
        "url": found.get("url", ""), "title": found.get("title", ""), "page_text": found.get("text", ""),
        "invalid_fields": invalid, "picture_sent_to_user": sent, "hint": hint,
    })


def _handle_browser_waiting(args: dict, **kwargs) -> str:
    waiting = (args or {}).get("waiting")
    if not isinstance(waiting, bool):
        return _result({"ok": False, "error": "bad_request", "hint": "waiting must be true or false."})
    key = _agent_key()
    session_id = _current_session(key) if key else None
    if not (key and session_id):
        return _result({"ok": False, "error": "no_session", "hint": "No isolated browser is open."})
    try:
        broker_call("POST", "/v1/sessions/%s/waiting" % session_id, key, {"waiting": waiting}, timeout=30.0)
    except BrokerError as error:
        return _result({"ok": False, "error": error.code})
    with _lock:
        if waiting:
            _DONE.discard(session_id)
        else:
            _DONE.add(session_id)                      # "I am finished": the browser closes when this reply ends
    return _result({"ok": True})


UPLOAD_SCHEMA = {
    "name": "browser_upload",
    "description": (
        "Put one of the person's saved files (for example their CV as PDF or Word) into a file input on the page open "
        "in the isolated browser. Give the CSS selector of the file input (often input[type=file]) and the exact name "
        "of the saved file. This only fills the input; submitting the form stays subject to the person's confirmation."),
    "parameters": {
        "type": "object",
        "properties": {
            "selector": {"type": "string", "description": "CSS selector of the <input type=file> element"},
            "file_name": {"type": "string", "description": "Exact name of one of the person's saved files, for example cv.pdf"},
        },
        "required": ["selector", "file_name"],
    },
}

SUBMIT_SCHEMA = {
    "name": "browser_submit",
    "description": (
        "Press the final Submit / Apply / Send button of a form in the isolated browser, wait for the page that follows, "
        "and get back what that page shows. Use it for the FINAL submit instead of a plain click, and only after the "
        "person confirmed in their latest message. Give the button's visible words (text) or its CSS selector. It "
        "returns the page's address, title and text, whether the page changed, and any field the browser refused. "
        "A picture of the page is sent to the person automatically. Never say the form was submitted unless the "
        "returned page text is a confirmation."),
    "parameters": {
        "type": "object",
        "properties": {
            "text": {"type": "string", "description": "The visible words of the button, for example Submit application"},
            "selector": {"type": "string", "description": "CSS selector of the button, if the words are not enough"},
        },
    },
}

WAITING_SCHEMA = {
    "name": "browser_waiting",
    "description": (
        "Tell the browser service this session is waiting for the person (for example for their confirmation before an "
        "irreversible step): waiting=true keeps the browser for up to 15 minutes. waiting=false means you are finished "
        "with the browser: it is closed when this reply ends. If you do nothing, the browser is kept for about 10 minutes "
        "after your reply anyway, in case the person answers."),
    "parameters": {
        "type": "object",
        "properties": {"waiting": {"type": "boolean", "description": "true while waiting for the person, false when done"}},
        "required": ["waiting"],
    },
}


STALE_REF_HINT = (
    "HINT FROM THE BROWSER SERVICE: that element reference no longer exists (the browser was reconnected between "
    "tasks, so references from earlier snapshots are gone). Call browser_snapshot now and use a reference from THAT "
    "snapshot; never reuse one from an earlier turn. For the FINAL Submit / Apply / Send button, use "
    "browser_submit(text=\"<the button's words>\"): it needs no reference, and report only what it returns."
)

_REF_TOOLS = ("browser_click", "browser_type", "browser_press", "browser_hover", "browser_scroll", "browser_select")


def _transform_tool_result(tool_name=None, result=None, error_message=None, **kwargs):
    """Hermes' transform_tool_result hook: runs after a tool finished and before its result reaches the model. A click
    on a stale reference ("Unknown ref: e1") made the assistant conclude that "the site does not respond to the
    tools" and stop; the model follows what a tool result says far more reliably than a rule in its persona. This
    adds the way out to that one failure. Anything else is passed through untouched; this never raises."""
    try:
        if tool_name not in _REF_TOOLS:
            return None
        text = result if isinstance(result, str) else json.dumps(result, ensure_ascii=False, default=str)
        if "unknown ref" not in (text + " " + str(error_message or "")).lower():
            return None
        try:
            data = json.loads(text)
        except ValueError:
            data = None
        if isinstance(data, dict):
            data["hint"] = STALE_REF_HINT
            return json.dumps(data, ensure_ascii=False)
        return text + "\n\n" + STALE_REF_HINT
    except Exception:
        return None


def register(ctx) -> None:
    ctx.register_browser_provider(BrokerBrowserProvider())
    try:
        ctx.register_hook("transform_tool_result", _transform_tool_result)
    except Exception:
        logger.warning("the transform_tool_result hook is not available; stale-reference hints are off")
    for name, schema, handler, emoji in (
        ("browser_upload", UPLOAD_SCHEMA, _handle_browser_upload, "📎"),
        ("browser_waiting", WAITING_SCHEMA, _handle_browser_waiting, "⏳"),
        ("browser_submit", SUBMIT_SCHEMA, _handle_browser_submit, "✅"),
    ):
        ctx.register_tool(name=name, toolset="browser", schema=schema, handler=handler,
                          description=schema["description"], emoji=emoji)
