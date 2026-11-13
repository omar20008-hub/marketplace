from __future__ import annotations

import hashlib
import ipaddress
import json
import os
import re
import secrets
from dataclasses import dataclass, fields
from typing import Any, Dict, Optional, Tuple
from urllib.parse import urlparse

IMAGE_ID = re.compile(r"^sha256:[0-9a-f]{64}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")


class ConfigError(Exception):
    pass


@dataclass(frozen=True)
class Config:
    # Required: no safe default exists for these.
    image: str                      # the image by ID (sha256:...), never by a movable tag
    seccomp_sha256: str             # expected digest of the seccomp profile; the broker refuses to start on a mismatch
    platform_url: str               # https://... (plain http only for a loopback test stub)

    socket_path: str = "/run/browser-broker/broker.sock"
    socket_group: str = "hmt-001"
    state_dir: str = "/var/lib/browser-broker"
    seccomp_profile: str = "/etc/browser-broker/seccomp-chrome.json"
    hmac_key_file: str = "/var/lib/browser-broker/hmac.key"   # state dir: writable by the service, /etc is read-only to it
    network: str = "browser-net"
    dns: Tuple[str, ...] = ("1.1.1.1", "8.8.8.8")
    memory: str = "700m"
    cpus: str = "1"
    pids_limit: int = 256

    max_concurrent: int = 1         # phase 1: 1.7 GB free, up to 700 MB per browser
    queue_max: int = 5
    queue_wait_s: int = 60
    idle_s: int = 300               # no activity
    waiting_s: int = 900            # waiting for the person (a missing answer, or a confirmation before an irreversible step)
    cap_s: int = 1800               # absolute ceiling (a long application form plus the time to answer)
    start_timeout_s: int = 20
    per_user_active: int = 1
    per_user_daily: int = 20
    closed_keep_s: int = 7 * 24 * 3600
    max_upload_bytes: int = 25 * 1024 * 1024
    max_uploads_per_session: int = 5
    request_timeout_s: int = 90
    cdp_port: int = 9222


_INT_FIELDS = {
    "pids_limit", "max_concurrent", "queue_max", "queue_wait_s", "idle_s", "waiting_s", "cap_s",
    "start_timeout_s", "per_user_active", "per_user_daily", "closed_keep_s", "max_upload_bytes",
    "max_uploads_per_session", "request_timeout_s", "cdp_port",
}


def validate(cfg: Config) -> Config:
    if not IMAGE_ID.match(cfg.image):
        raise ConfigError("image must be an image ID (sha256:<64 hex>), not a tag")
    if not SHA256.match(cfg.seccomp_sha256):
        raise ConfigError("seccomp_sha256 must be 64 hex characters")
    url = urlparse(cfg.platform_url)
    loopback = url.hostname in ("127.0.0.1", "localhost", "::1")
    if url.scheme != "https" and not (url.scheme == "http" and loopback):
        raise ConfigError("platform_url must be https (http only for loopback)")
    if not url.hostname:
        raise ConfigError("platform_url has no host")
    for server in cfg.dns:
        try:
            ipaddress.IPv4Address(server)
        except ValueError:
            raise ConfigError("dns entries must be IPv4 addresses")
    for name in _INT_FIELDS:
        if not isinstance(getattr(cfg, name), int) or getattr(cfg, name) <= 0:
            raise ConfigError("%s must be a positive integer" % name)
    if cfg.waiting_s > cfg.cap_s or cfg.idle_s > cfg.cap_s:
        raise ConfigError("idle_s and waiting_s cannot exceed cap_s")
    if not re.match(r"^\d+[mg]$", cfg.memory) or not re.match(r"^\d+(\.\d+)?$", cfg.cpus):
        raise ConfigError("memory like 700m and cpus like 1 are required")
    return cfg


def from_dict(raw: Dict[str, Any]) -> Config:
    known = {f.name for f in fields(Config)}
    unknown = set(raw) - known
    if unknown:
        raise ConfigError("unknown settings: %s" % ", ".join(sorted(unknown)))
    values = dict(raw)
    if "dns" in values:
        values["dns"] = tuple(values["dns"])
    try:
        cfg = Config(**values)
    except TypeError as error:
        raise ConfigError(str(error))
    return validate(cfg)


def load(path: str) -> Config:
    with open(path, "r", encoding="utf-8") as handle:
        return from_dict(json.load(handle))


def check_seccomp(cfg: Config) -> None:
    """The profile that opens the user-namespace syscalls is security-critical: it must be the reviewed one."""
    with open(cfg.seccomp_profile, "rb") as handle:
        digest = hashlib.sha256(handle.read()).hexdigest()
    if digest != cfg.seccomp_sha256:
        raise ConfigError("seccomp profile does not match the expected digest")


def load_or_create_key(path: str) -> bytes:
    """The key that makes user ids in logs and state unreadable (HMAC). Created once, root-only."""
    try:
        with open(path, "rb") as handle:
            key = handle.read()
        if len(key) >= 32:
            return key
    except FileNotFoundError:
        pass
    key = secrets.token_bytes(32)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as handle:
        handle.write(key)
    return key


def optional_env(name: str) -> Optional[str]:
    value = os.environ.get(name)
    return value if value else None
