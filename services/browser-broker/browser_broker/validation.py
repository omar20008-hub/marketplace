from __future__ import annotations

import re
import unicodedata

SESSION_ID = re.compile(r"^[a-f0-9]{32}$")
FILE_ID = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
AGENT_KEY = re.compile(r"^[A-Za-z0-9._~+/=-]{16,200}$")
MAX_SELECTOR = 200
MAX_NAME = 100

_BAD_NAME_CHARS = re.compile(r'[\x00-\x1f\x7f<>:"|?*\\/]')


def bearer(header: str):
    """The key in `Authorization: Bearer <key>`, or None when absent or not shaped like a key."""
    if not header or not header.startswith("Bearer "):
        return None
    key = header[7:].strip()
    return key if AGENT_KEY.match(key) else None


def selector_ok(value) -> bool:
    """A CSS selector goes to DOM.querySelector as data, never as code; bound it and keep it printable."""
    return (
        isinstance(value, str)
        and 0 < len(value) <= MAX_SELECTOR
        and all(c.isprintable() for c in value)
    )


def sanitize_filename(name: str) -> str:
    """A safe name for a file placed in the broker's own folder: no path, no control characters, bounded."""
    text = unicodedata.normalize("NFC", str(name))
    text = re.split(r"[\\/]", text)[-1]          # keep only the last path segment
    text = _BAD_NAME_CHARS.sub(" ", text)
    text = re.sub(r"\s+", " ", text).strip().lstrip(".").strip()
    if not text:
        return "file"
    if len(text) > MAX_NAME:
        stem, dot, ext = text.rpartition(".")
        if dot and 0 < len(ext) <= 10:
            text = stem[: MAX_NAME - len(ext) - 1] + "." + ext
        else:
            text = text[:MAX_NAME]
        text = text.strip() or "file"
    return text
