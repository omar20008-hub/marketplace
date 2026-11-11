# browser-broker

Creates, limits and removes the per-task browser containers for the assistant. Design and decisions:
`docs/browser-service-phase1-broker.md` (and the image and network documents beside it).
Python 3.9 (the server's), standard library plus one dependency: `websockets` (pinned).

## Layout

| File | What it is |
|---|---|
| `browser_broker/config.py` | settings, refusals (image by ID, https platform, limits), seccomp digest check |
| `browser_broker/docker_runner.py` | **the only place** that builds `docker run` (every security flag is fixed here) |
| `browser_broker/manager.py` | sessions: queue, quotas, deadlines, uploads, cleanup, saved state |
| `browser_broker/server.py` | HTTP over a unix socket, five routes, no network port |
| `browser_broker/platform.py` | asks the platform who a key is and for that person's file (never follows redirects) |
| `browser_broker/cdp.py` | puts a file into `<input type=file>` through Chrome DevTools |
| `browser_broker/events.py` | the log: only allowlisted fields, so no key, address, file name or content can be logged |
| `deploy/` | systemd unit, example config, the firewall script (versioned here) |

## Test

```bash
python3 -m unittest discover -s . -p "test_*.py"          # 50 tests, no Docker, no network
python tests/live_cdp_check.py <chrome> [flags]            # manual: the upload against a real Chrome
```

## Install (on the server; each step needs approval before it is run)

1. `python3 -m venv /opt/browser-broker/venv && /opt/browser-broker/venv/bin/pip install websockets==15.0.1`
   and, before production, record the file hashes (`pip download websockets==15.0.1 --no-deps -d w && pip hash w/*`)
   and install with `--require-hashes`.
2. Copy this folder to `/opt/browser-broker/app` (root-owned, not writable by others).
3. `/etc/browser-broker/`: `seccomp-chrome.json` (the reviewed profile) and `config.json` from `deploy/config.example.json`
   with the image ID (`docker image inspect --format '{{.Id}}' hermes-browser:phase1-145`) and the profile's sha256.
4. Re-apply the firewall script (adds the OUTPUT guard for port 9222), then install `deploy/browser-broker.service`.
5. The platform needs `GET /api/agent/whoami` and `GET /api/agent/files/{id}` first (see the design document).

## Phase 1 limits, stated plainly

- One browser at a time (1.7 GB free on the server). Queue of 5, 60 s wait.
- Activity is what the broker sees (API calls). Until the CDP relay of step 5 exists, a browser the assistant
  drives directly looks idle to the broker, so the 5-minute idle limit would close it. Step 5 closes this gap.
- The DevTools port of a session is reachable on the browser network only by root (OUTPUT guard).
