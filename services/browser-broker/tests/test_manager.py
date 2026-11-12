import asyncio
import json
import logging
import os
import unittest

from browser_broker.manager import BrokerError, Manager
from tests.fakes import Clock, FakeCdp, FakeDocker, FakePlatform, KEY_A, make_config


class Capture(logging.Handler):
    def __init__(self):
        super().__init__()
        self.lines = []

    def emit(self, record):
        self.lines.append(record.getMessage())


class ManagerCase(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.clock = Clock()
        self.docker = FakeDocker()
        self.cdp = FakeCdp()
        self.platform = FakePlatform()
        self.capture = Capture()
        logging.getLogger("browser-broker").addHandler(self.capture)
        logging.getLogger("browser-broker").setLevel(logging.INFO)

    def tearDown(self):
        logging.getLogger("browser-broker").removeHandler(self.capture)

    def make(self, **over):
        cfg = make_config(**over)
        self.cfg = cfg
        self.m = Manager(cfg, self.docker, self.cdp, b"k" * 32, clock=self.clock, sleep=self.clock.sleep)
        return self.m

    async def code(self, coro):
        try:
            await coro
        except BrokerError as error:
            return error.code
        return None


class Lifecycle(ManagerCase):
    async def test_create_starts_one_hardened_container_and_a_private_uploads_folder(self):
        m = self.make()
        s = await m.create("user-a")
        self.assertEqual(s.state, "ready")
        self.assertEqual(len(self.docker.started), 1)
        sid, deadline, uploads = self.docker.started[0]
        self.assertEqual(deadline, self.clock() + self.cfg.cap_s)
        self.assertTrue(os.path.isdir(uploads))
        self.assertEqual(oct(os.stat(uploads).st_mode & 0o777), "0o755")

    async def test_one_live_session_per_user(self):
        m = self.make()
        await m.create("user-a")
        self.assertEqual(await self.code(m.create("user-a")), "user_busy")

    async def test_closing_removes_container_and_folder_and_frees_the_slot(self):
        m = self.make()
        s = await m.create("user-a")
        folder = os.path.join(m.sessions_dir, s.id)
        self.assertTrue(os.path.isdir(folder))
        await m.close(s.id, "user-a")
        self.assertEqual(self.docker.removed, ["bb-" + s.id])
        self.assertFalse(os.path.exists(folder))
        await m.close_all()                       # closing twice is harmless
        again = await m.create("user-b")          # the slot is free again
        self.assertEqual(again.state, "ready")

    async def test_failed_start_cleans_up_and_frees_the_slot(self):
        m = self.make()
        self.docker.fail_start = True
        self.assertEqual(await self.code(m.create("user-a")), "start_failed")
        self.assertEqual(os.listdir(m.sessions_dir) if os.path.isdir(m.sessions_dir) else [], [])
        self.docker.fail_start = False
        self.assertEqual((await m.create("user-a")).state, "ready")

    async def test_a_browser_that_never_answers_is_removed(self):
        m = self.make(start_timeout_s=2)
        self.cdp.is_ready = False
        self.assertEqual(await self.code(m.create("user-a")), "start_failed")
        self.assertEqual(len(self.docker.removed), 1)

    async def test_sessions_of_other_people_are_not_found(self):
        m = self.make()
        s = await m.create("user-a")
        self.assertEqual(self._sync_code(lambda: m.owned(s.id, "user-b")), "not_found")
        self.assertEqual(self._sync_code(lambda: m.owned("0" * 32, "user-a")), "not_found")
        await m.close(s.id, "user-a")
        self.assertEqual(self._sync_code(lambda: m.owned(s.id, "user-a")), "not_found")

    def _sync_code(self, fn):
        try:
            fn()
        except BrokerError as error:
            return error.code
        return None


class QueueAndQuota(ManagerCase):
    async def test_the_second_person_waits_for_the_slot_then_gets_it(self):
        m = self.make(queue_wait_s=5)
        first = await m.create("user-a")
        waiting = asyncio.create_task(m.create("user-b"))
        await asyncio.sleep(0.05)
        self.assertFalse(waiting.done())
        self.assertEqual(m.counts()["queued"], 1)
        await m.close(first.id, "user-a")
        second = await asyncio.wait_for(waiting, 2)
        self.assertEqual(second.state, "ready")

    async def test_busy_when_the_queue_is_full_or_the_wait_runs_out(self):
        m = self.make(queue_max=1, queue_wait_s=5)
        await m.create("user-a")
        queued = asyncio.create_task(m.create("user-b"))
        await asyncio.sleep(0.05)
        self.assertEqual(await self.code(m.create("user-c")), "busy")      # queue of 1 is full
        queued.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await queued
        m2 = self.make(queue_wait_s=0.05)
        await m2.create("user-a")
        self.assertEqual(await self.code(m2.create("user-b")), "busy")     # waited, never got a slot

    async def test_daily_quota_per_person_resets_after_a_day(self):
        m = self.make(per_user_daily=2)
        for _ in range(2):
            s = await m.create("user-a")
            await m.close(s.id, "user-a")
        self.assertEqual(await self.code(m.create("user-a")), "quota_exceeded")
        self.assertEqual((await m.create("user-b")).state, "ready")        # someone else is unaffected
        self.clock.t += 86401
        await m.close_all()
        self.assertEqual((await m.create("user-a")).state, "ready")


class Deadlines(ManagerCase):
    async def test_idle_session_is_closed_and_activity_keeps_it_alive(self):
        m = self.make()
        s = await m.create("user-a")
        self.clock.t += 200
        m.touch(s.id, "user-a")
        self.clock.t += 200
        await m.tick()
        self.assertEqual(s.state, "ready")
        self.clock.t += 200
        await m.tick()
        self.assertEqual((s.state, s.reason), ("closed", "idle_timeout"))
        self.assertEqual(self.docker.removed, ["bb-" + s.id])

    async def test_waiting_for_the_person_has_its_own_shorter_limit(self):
        m = self.make()
        s = await m.create("user-a")
        m.set_waiting(s.id, "user-a", True)
        self.clock.t += 179
        await m.tick()
        self.assertEqual(s.state, "ready")
        self.clock.t += 2
        await m.tick()
        self.assertEqual(s.reason, "waiting_timeout")

    async def test_the_absolute_cap_closes_even_an_active_session(self):
        m = self.make()
        s = await m.create("user-a")
        for _ in range(3):                      # 720 s of steady activity: still inside the 900 s cap
            self.clock.t += 240
            m.touch(s.id, "user-a")
            await m.tick()
        self.assertEqual(s.state, "ready")
        self.clock.t += 200                     # 920 s: past the cap although the session is active
        m.touch(s.id, "user-a")
        await m.tick()
        self.assertEqual((s.state, s.reason), ("closed", "cap"))

    async def test_peak_memory_is_sampled_and_logged_at_close(self):
        m = self.make()
        s = await m.create("user-a")
        self.docker.mem = 420.0
        self.clock.t += 20
        await m.tick()
        self.docker.mem = 100.0
        self.clock.t += 20
        m.touch(s.id, "user-a")
        await m.tick()
        await m.close(s.id, "user-a")
        closed = [json.loads(l) for l in self.capture.lines if '"closed"' in l][-1]
        self.assertEqual(closed["mem_peak_mb"], 420.0)


class Uploads(ManagerCase):
    async def test_the_file_comes_from_the_platform_and_lands_inside_the_session_folder(self):
        m = self.make()
        s = await m.create("user-a")
        await m.upload(s.id, "user-a", KEY_A, "file-aaaa-1", "input[type=file]", self.platform)
        ip, selector, paths = self.cdp.calls[0]
        self.assertEqual(paths, ["/uploads/1/passwd.pdf"])                 # '../../etc/' was cut
        on_disk = os.path.join(m.sessions_dir, s.id, "uploads", "1", "passwd.pdf")
        with open(on_disk, "rb") as handle:
            self.assertEqual(handle.read(), b"%PDF-1 a")
        self.assertEqual(oct(os.stat(on_disk).st_mode & 0o777), "0o444")
        self.assertFalse(os.path.exists(os.path.join(m.sessions_dir, s.id, "etc")))

    async def test_another_persons_file_is_not_found_and_nothing_is_written(self):
        m = self.make()
        s = await m.create("user-a")
        from browser_broker.platform import PlatformError
        with self.assertRaises(PlatformError) as caught:
            await m.upload(s.id, "user-a", KEY_A, "file-bbbb-1", "#f", self.platform)
        self.assertEqual(caught.exception.kind, "not_found")
        self.assertEqual(os.listdir(os.path.join(m.sessions_dir, s.id, "uploads")), [])
        self.assertEqual(self.cdp.calls, [])

    async def test_someone_elses_session_cannot_be_uploaded_into(self):
        m = self.make()
        s = await m.create("user-a")
        self.assertEqual(await self.code(m.upload(s.id, "user-b", "key-user-b-0123456789abcdef", "file-bbbb-1", "#f", self.platform)), "not_found")

    async def test_a_failed_browser_step_leaves_no_file_behind(self):
        from browser_broker.cdp import CdpError
        m = self.make()
        s = await m.create("user-a")
        self.cdp.error = "not_found"
        with self.assertRaises(CdpError):
            await m.upload(s.id, "user-a", KEY_A, "file-aaaa-1", "#nope", self.platform)
        self.assertEqual(os.listdir(os.path.join(m.sessions_dir, s.id, "uploads")), [])
        self.assertEqual(s.uploads, 0)

    async def test_uploads_per_session_are_limited(self):
        m = self.make(max_uploads_per_session=1)
        s = await m.create("user-a")
        await m.upload(s.id, "user-a", KEY_A, "file-aaaa-1", "#f", self.platform)
        self.assertEqual(await self.code(m.upload(s.id, "user-a", KEY_A, "file-aaaa-1", "#f", self.platform)), "too_many_uploads")

    async def test_logs_never_hold_keys_file_names_or_user_ids(self):
        m = self.make()
        s = await m.create("user-a")
        await m.upload(s.id, "user-a", KEY_A, "file-aaaa-1", "input[type=file]", self.platform)
        await m.close(s.id, "user-a")
        text = "\n".join(self.capture.lines)
        for secret in (KEY_A, "passwd", ".pdf", "user-a", "input[type=file]"):
            self.assertNotIn(secret, text)
        self.assertIn("file-aaaa-1", text)                                  # the file's id is allowed


class StateAndCleanup(ManagerCase):
    async def test_state_file_holds_no_user_id_and_is_private(self):
        m = self.make()
        s = await m.create("user-a")
        await m.close(s.id, "user-a")
        with open(m.state_path) as handle:
            raw = handle.read()
        self.assertNotIn("user-a", raw)
        self.assertEqual(oct(os.stat(m.state_path).st_mode & 0o777), "0o600")

    async def test_after_a_restart_nothing_is_resumed_and_the_quota_is_remembered(self):
        m = self.make(per_user_daily=1)
        await m.create("user-a")                                            # still live when the broker "dies"
        m2 = Manager(self.cfg, self.docker, self.cdp, b"k" * 32, clock=self.clock, sleep=self.clock.sleep)
        m2.load()
        self.assertEqual({s.state for s in m2.sessions.values()}, {"closed"})
        self.assertEqual({s.reason for s in m2.sessions.values()}, {"broker_restart"})
        self.assertEqual(await self.code(m2.create("user-a")), "quota_exceeded")

    async def test_reconcile_removes_orphans_but_not_live_sessions(self):
        m = self.make()
        live = await m.create("user-a")
        self.docker.labeled = [("bb-" + live.id, live.id), ("bb-orphan", "f" * 32)]
        os.makedirs(os.path.join(m.sessions_dir, "f" * 32, "uploads"))
        removed = await m.reconcile()
        self.assertEqual(removed, 1)
        self.assertEqual(self.docker.removed, ["bb-orphan"])
        self.assertFalse(os.path.exists(os.path.join(m.sessions_dir, "f" * 32)))
        self.assertTrue(os.path.exists(os.path.join(m.sessions_dir, live.id)))

    async def test_closed_records_are_pruned_after_seven_days(self):
        m = self.make()
        s = await m.create("user-a")
        await m.close(s.id, "user-a")
        self.clock.t += 7 * 24 * 3600 - 10
        await m.reconcile()
        self.assertIn(s.id, m.sessions)
        self.clock.t += 20
        await m.reconcile()
        self.assertNotIn(s.id, m.sessions)

    async def test_a_container_that_will_not_go_is_retried_by_the_reconciler(self):
        m = self.make()
        s = await m.create("user-a")
        self.docker.fail_remove = True
        await m.close(s.id, "user-a")
        self.assertEqual(s.state, "closed")
        self.docker.fail_remove = False
        self.docker.labeled = [("bb-" + s.id, s.id)]
        self.assertEqual(await m.reconcile(), 1)


if __name__ == "__main__":
    unittest.main()
