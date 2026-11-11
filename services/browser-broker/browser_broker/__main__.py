from __future__ import annotations

import asyncio
import logging
import os
import signal
import sys

from . import config as config_module
from .cdp import CdpClient
from .docker_runner import DockerCLI
from .manager import Manager
from .platform import CachedIdentity, PlatformClient
from .server import Api, serve


async def run(cfg) -> None:
    config_module.check_seccomp(cfg)
    key = config_module.load_or_create_key(cfg.hmac_key_file)
    os.makedirs(os.path.join(cfg.state_dir, "sessions"), exist_ok=True)
    platform = PlatformClient(cfg.platform_url)
    manager = Manager(cfg, DockerCLI(cfg), CdpClient(cfg.cdp_port), key)
    manager.load()
    await manager.reconcile()   # nothing is resumed: every container of ours left from before is removed
    server = await serve(Api(manager, platform, CachedIdentity(platform)), cfg.socket_path, cfg.socket_group, cfg.request_timeout_s)

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)

    async def every(seconds: float, work) -> None:
        while True:
            await asyncio.sleep(seconds)
            try:
                await work()
            except Exception as error:  # a failed round must not stop the loop
                logging.getLogger("browser-broker").error("background error: %s", type(error).__name__)

    tasks = [asyncio.create_task(every(5, manager.tick)), asyncio.create_task(every(30, manager.reconcile))]
    await stop.wait()
    server.close()
    for task in tasks:
        task.cancel()
    await manager.close_all("shutdown")
    try:
        os.unlink(cfg.socket_path)
    except FileNotFoundError:
        pass


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(message)s", stream=sys.stdout)
    path = os.environ.get("BROWSER_BROKER_CONFIG", "/etc/browser-broker/config.json")
    try:
        cfg = config_module.load(path)
        asyncio.run(run(cfg))
    except config_module.ConfigError as error:
        print("configuration error: %s" % error, file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
