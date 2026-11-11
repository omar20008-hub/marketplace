from __future__ import annotations

import asyncio
import json
import re
from typing import List, Optional, Tuple

from .config import Config


class DockerError(Exception):
    pass


def container_name(session_id: str) -> str:
    return "bb-" + session_id


def build_run_args(cfg: Config, session_id: str, deadline: float, uploads_dir: str) -> List[str]:
    """
    The one place that decides how a browser container runs. Every security setting is
    fixed here (steps 1 and 2 of phase 1); a caller cannot add, drop or change any of them.
    """
    args = [
        "docker", "run", "-d",
        "--name", container_name(session_id),
        "--label", "browser-broker=1",
        "--label", "bb.session=" + session_id,
        "--label", "bb.deadline=%d" % int(deadline),
        "--network", cfg.network,
    ]
    for server in cfg.dns:
        args += ["--dns", server]
    args += [
        "--read-only",
        "--tmpfs", "/tmp:rw,size=256m",
        "--tmpfs", "/home/browser:rw,size=128m",
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        "--security-opt", "seccomp=" + cfg.seccomp_profile,
        "--pids-limit", str(cfg.pids_limit),
        "--memory", cfg.memory,
        "--cpus", cfg.cpus,
        "--user", "10001",
        "-e", "HOME=/home/browser",
        "-e", "XDG_CONFIG_HOME=/tmp/xdg-config",
        "-e", "XDG_CACHE_HOME=/tmp/xdg-cache",
        # The only host folder the browser ever sees: this session's uploads, read-only.
        "-v", uploads_dir + ":/uploads:ro",
        cfg.image,
        "--remote-debugging-address=0.0.0.0",
        "--remote-debugging-port=%d" % cfg.cdp_port,
        "about:blank",
    ]
    return args


_MIB = {"KiB": 1 / 1024, "MiB": 1.0, "GiB": 1024.0, "kB": 1 / 1000, "MB": 1.0, "GB": 1000.0, "B": 1 / 1048576}


def parse_mem_mb(usage: str) -> Optional[float]:
    """'198.6MiB / 700MiB' -> 198.6"""
    match = re.match(r"^\s*([0-9.]+)\s*([A-Za-z]+)", usage or "")
    if not match or match.group(2) not in _MIB:
        return None
    return float(match.group(1)) * _MIB[match.group(2)]


class DockerCLI:
    """Thin wrapper over the docker CLI. Arguments are lists, never a shell string."""

    def __init__(self, cfg: Config, timeout: float = 30.0):
        self.cfg = cfg
        self.timeout = timeout

    async def _run(self, args: List[str], timeout: Optional[float] = None) -> str:
        proc = await asyncio.create_subprocess_exec(
            *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
        try:
            out, err = await asyncio.wait_for(proc.communicate(), timeout or self.timeout)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            raise DockerError("docker timed out")
        if proc.returncode != 0:
            raise DockerError("docker failed: " + err.decode("utf-8", "replace").strip()[:300])
        return out.decode("utf-8", "replace")

    async def start(self, session_id: str, deadline: float, uploads_dir: str) -> str:
        out = await self._run(build_run_args(self.cfg, session_id, deadline, uploads_dir), timeout=60)
        return out.strip()

    async def ip(self, session_id: str) -> str:
        out = await self._run(["docker", "inspect", container_name(session_id)])
        data = json.loads(out)[0]
        address = data["NetworkSettings"]["Networks"][self.cfg.network]["IPAddress"]
        if not address:
            raise DockerError("container has no address yet")
        return address

    async def remove(self, session_id: str) -> None:
        await self.remove_name(container_name(session_id))

    async def remove_name(self, name: str) -> None:
        try:
            await self._run(["docker", "rm", "-f", name])
        except DockerError as error:
            if "No such container" not in str(error):
                raise

    async def list_labeled(self) -> List[Tuple[str, str]]:
        """(container name, session id) of every container this broker made, running or not."""
        out = await self._run(
            ["docker", "ps", "-a", "--filter", "label=browser-broker=1",
             "--format", '{{.Names}}\t{{.Label "bb.session"}}']
        )
        rows = []
        for line in out.splitlines():
            name, _, session = line.partition("\t")
            if name:
                rows.append((name, session))
        return rows

    async def memory_mb(self, session_id: str) -> Optional[float]:
        out = await self._run(
            ["docker", "stats", "--no-stream", "--format", "{{.MemUsage}}", container_name(session_id)]
        )
        return parse_mem_mb(out)
