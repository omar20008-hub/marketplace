"""
Deterministic check on the server, with Hermes' own Python and no language model in the loop.

  sudo -u hmt-001 -H <Hermes' managed python3> -I hermes_fallback_check.py [profile-dir]

It runs Hermes' real session-creation code for a profile (its real config.yaml: browser.cloud_provider) with the
LOCAL browser creator replaced by one that records the call and fails. So:
  * broker running  -> a session is created through the broker and the local creator is never called;
  * broker stopped  -> a dead DevTools address comes back and the local creator is STILL never called;
  * provider not resolved at all (plugin not loaded, wrong name) -> Hermes would use the local browser: reported as FAIL.
The person's key is read from the profile's own .env and never printed.
"""
import json
import os
import re
import sys

PROFILE = sys.argv[1] if len(sys.argv) > 1 else "/home/hmt-001/.hermes/profiles/testuser1"
HERMES = os.environ.get("HERMES_AGENT_DIR", "/home/hmt-001/.hermes/hermes-agent")
os.environ.pop("PYTHONHOME", None)               # what Hermes' own launcher does first
os.environ.pop("PYTHONPATH", None)
os.environ["HERMES_HOME"] = PROFILE
sys.path.insert(0, HERMES)
os.chdir(HERMES)
try:
    import hermes_bootstrap  # noqa: F401  (the launcher imports it before anything else of Hermes')
except Exception as exc:  # noqa: BLE001
    print("hermes_bootstrap: " + type(exc).__name__ + ": " + str(exc)[:120])

with open(os.path.join(PROFILE, ".env"), "r", encoding="utf-8") as handle:
    for line in handle:
        match = re.match(r"^(PLATFORM_AGENT_KEY|PLATFORM_URL)=(.*)$", line.strip())
        if match:
            os.environ[match.group(1)] = match.group(2).strip().strip("'\"")

RESULTS = []


def check(label, ok, detail=""):
    RESULTS.append(bool(ok))
    print(("PASS  " if ok else "FAIL  ") + label + ((" -> " + str(detail)) if detail != "" else ""))


import tools.browser_tool_session as session  # noqa: E402
import tools.browser_tool_cloud as cloud  # noqa: E402

local_calls = []


def forbidden_local(*args, **kwargs):
    local_calls.append(1)
    raise RuntimeError("the local browser was asked for")


session._create_local_session = forbidden_local

cloud._ensure_browser_plugins_loaded()
provider = cloud._get_cloud_provider()
name = type(provider).__name__ if provider is not None else None
print("HERMES_HOME=%s" % os.environ["HERMES_HOME"])
check("the configured provider resolves to the broker provider", name == "BrokerBrowserProvider", name)

info = None
error = ""
try:
    info = session._create_session_for_key("fallback-check", False)
except Exception as exc:                               # noqa: BLE001
    error = type(exc).__name__ + ": " + str(exc)[:120]

check("the local browser was never asked for", not local_calls, "asked %d time(s)" % len(local_calls))
if info is None:
    check("a session came back", False, error)
else:
    url = str(info.get("cdp_url", ""))
    dead = ":9/devtools/browser/broker-" in url
    live = bool(re.match(r"^ws://127\.0\.0\.1:\d+/devtools/browser/", url)) and not dead
    check("the session is either live through the broker or dead on purpose (never local)", dead or live,
          "dead (%s)" % url.rsplit("broker-", 1)[-1] if dead else ("live" if live else "neither"))
    if live and provider is not None and info.get("bb_session_id"):
        # Persistence: Hermes closes its browser every time it finishes a reply, whatever the assistant did. The browser
        # must be kept for a grace period (no tool call needed from the model) and handed back to the next task.
        plugin = sys.modules[type(provider).__module__]
        sid, key = str(info["bb_session_id"]), os.environ["PLATFORM_AGENT_KEY"]
        kept = provider.close_session(sid)                    # what Hermes does at the end of a reply
        view = plugin.broker_call("GET", "/v1/sessions/%s" % sid, key, timeout=15)
        check("the browser is NOT closed when Hermes finishes a reply (kept for a grace period)",
              kept is True and view.get("state") == "ready" and view.get("waiting") is True, view.get("state"))
        again = provider.create_session("persistence-check-2")
        check("the next task gets the same browser back (same session, same address)",
              again.get("bb_session_id") == sid and again.get("cdp_url") == info.get("cdp_url"),
              "same" if again.get("bb_session_id") == sid else "different")
        done = json.loads(plugin._handle_browser_waiting({"waiting": False}))      # the assistant: "I am finished"
        check("when the assistant says it is finished, the browser is closed at once",
              done.get("ok") is True and provider.close_session(sid) is True)
        try:
            plugin.broker_call("GET", "/v1/sessions/%s" % sid, key, timeout=15)
            gone = False
        except Exception as exc:  # noqa: BLE001
            gone = getattr(exc, "code", "") == "not_found"
        check("and the broker no longer has it", gone)

print("RESULT: %d of %d" % (sum(RESULTS), len(RESULTS)))
sys.exit(0 if all(RESULTS) else 1)
