from __future__ import annotations

import json
import logging
import time

log = logging.getLogger("browser-broker")

# Only these fields may ever be logged. Page addresses, file names, page content and
# keys are not in the list on purpose: adding one is a decision, not an accident.
ALLOWED = frozenset(
    {
        "session", "uid", "reason", "state", "file_id", "size", "duration_s",
        "mem_peak_mb", "queued", "active", "count", "container", "error", "uploads",
    }
)


class ForbiddenLogField(Exception):
    pass


def event(name: str, /, **fields) -> None:
    bad = set(fields) - ALLOWED
    if bad:
        raise ForbiddenLogField(", ".join(sorted(bad)))
    record = {"ts": round(time.time(), 3), "event": name}
    record.update(fields)
    log.info(json.dumps(record, ensure_ascii=False, sort_keys=True))
