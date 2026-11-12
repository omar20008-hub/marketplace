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
import urllib.error
import urllib.request
from typing import Any, Dict, Optional

from agent.browser_provider import BrowserProvider

try:
    from agent.secret_scope import get_secret
except Exception:  # pragma: no cover - only if Hermes moves it
    def get_secret(name, default=None):
        return os.environ.get(name, default)

logger = logging.getLogger(__name__)

DEFAULT_SOCKET = "/run/browser-broker/broker.sock"
# Reasons the broker can give a person, as the last part of the dead address (letters and hyphens only).
_REASONS = {
    "busy": "busy", "user_busy": "busy", "quota_exceeded": "quota", "unauthorized": "unauthorized",
    "start_failed": "start-failed", "unavailable": "unavailable",
}

_lock = threading.Lock()
_KEY_OF_SESSION: Dict[str, str] = {}      # broker session id -> agent key (memory only; closes may run outside a profile scope)
_LATEST: Dict[str, str] = {}              # sha256(agent key) -> its open session id (the broker allows one per person)


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
            made = broker_call("POST", "/v1/sessions", key)
            session_id, url = str(made["id"]), str(made["cdpUrl"])
        except BrokerError as error:
            return _dead_session(_REASONS.get(error.code, "unavailable"))
        except Exception:
            return _dead_session("unavailable")
        with _lock:
            _KEY_OF_SESSION[session_id] = key
            _LATEST[_who(key)] = session_id
        return {"session_name": "broker-" + session_id[:12], "bb_session_id": session_id, "cdp_url": url,
                "features": {"isolated": True}}

    def close_session(self, session_id: str) -> bool:
        if not session_id:
            return True                               # a dead session holds nothing
        with _lock:
            key = _KEY_OF_SESSION.pop(session_id, None)
        key = key or _agent_key()
        if not key:
            return False
        with _lock:
            if _LATEST.get(_who(key)) == session_id:
                del _LATEST[_who(key)]
        try:
            broker_call("POST", "/v1/sessions/%s/close" % session_id, key, timeout=30.0)
            return True
        except BrokerError as error:
            return error.code == "not_found"           # already gone is fine
        except Exception:
            return False

    def emergency_cleanup(self, session_id: str) -> None:
        try:
            self.close_session(session_id)
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

WAITING_SCHEMA = {
    "name": "browser_waiting",
    "description": (
        "Tell the browser service this session is waiting for the person (for example for their confirmation before an "
        "irreversible step). Set waiting=true before asking, and waiting=false when you continue. Prevents the session "
        "from being closed while you wait, within a limit."),
    "parameters": {
        "type": "object",
        "properties": {"waiting": {"type": "boolean", "description": "true while waiting for the person, false when done"}},
        "required": ["waiting"],
    },
}


def register(ctx) -> None:
    ctx.register_browser_provider(BrokerBrowserProvider())
    for name, schema, handler, emoji in (
        ("browser_upload", UPLOAD_SCHEMA, _handle_browser_upload, "📎"),
        ("browser_waiting", WAITING_SCHEMA, _handle_browser_waiting, "⏳"),
    ):
        ctx.register_tool(name=name, toolset="browser", schema=schema, handler=handler,
                          description=schema["description"], emoji=emoji)
