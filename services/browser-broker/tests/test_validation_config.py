import os
import tempfile
import unittest

from browser_broker import config
from browser_broker.docker_runner import build_run_args, parse_mem_mb
from browser_broker.events import ForbiddenLogField, event
from browser_broker.validation import bearer, sanitize_filename, selector_ok
from tests.fakes import make_config


class Sanitize(unittest.TestCase):
    def test_paths_are_cut_to_the_last_segment(self):
        self.assertEqual(sanitize_filename("../../etc/passwd.pdf"), "passwd.pdf")
        self.assertEqual(sanitize_filename("C:\\Users\\me\\cv.docx"), "cv.docx")
        self.assertEqual(sanitize_filename("/"), "file")

    def test_control_and_special_characters_go(self):
        self.assertEqual(sanitize_filename("a\x00b\nc<d>.pdf"), "a b c d .pdf")
        self.assertEqual(sanitize_filename(".hidden"), "hidden")
        self.assertEqual(sanitize_filename(""), "file")
        self.assertEqual(sanitize_filename("..."), "file")

    def test_arabic_is_kept_and_length_is_bounded_keeping_the_extension(self):
        self.assertEqual(sanitize_filename("السيرة الذاتية.pdf"), "السيرة الذاتية.pdf")
        long = sanitize_filename("x" * 300 + ".pdf")
        self.assertEqual(len(long), 100)
        self.assertTrue(long.endswith(".pdf"))


class Inputs(unittest.TestCase):
    def test_bearer(self):
        self.assertEqual(bearer("Bearer abcdefghijklmnop"), "abcdefghijklmnop")
        self.assertIsNone(bearer(""))
        self.assertIsNone(bearer("Basic abcdefghijklmnop"))
        self.assertIsNone(bearer("Bearer short"))
        self.assertIsNone(bearer("Bearer has space inside here!!"))

    def test_selector(self):
        self.assertTrue(selector_ok("input[type=file]"))
        self.assertFalse(selector_ok(""))
        self.assertFalse(selector_ok("a" * 201))
        self.assertFalse(selector_ok("a\x00b"))
        self.assertFalse(selector_ok(5))


class Logging(unittest.TestCase):
    def test_a_field_outside_the_allowlist_is_refused(self):
        for bad in ("url", "name", "filename", "key", "body"):
            with self.assertRaises(ForbiddenLogField):
                event("x", **{bad: "v"})


class RunArgs(unittest.TestCase):
    def test_hardening_is_fixed_in_one_place(self):
        cfg = make_config()
        args = build_run_args(cfg, "s" * 32, 1700000000.0, "/var/lib/browser-broker/sessions/x/uploads")
        joined = " ".join(args)
        for needed in (
            "--read-only", "--cap-drop ALL", "--security-opt no-new-privileges",
            "--security-opt seccomp=" + cfg.seccomp_profile, "--user 10001", "--network browser-net",
            "--dns 1.1.1.1", "--dns 8.8.8.8", "--pids-limit 256", "--memory 700m", "--cpus 1",
            "-e XDG_CONFIG_HOME=/tmp/xdg-config", "--label browser-broker=1",
        ):
            self.assertIn(needed, joined)
        for forbidden in ("--privileged", "--cap-add", "docker.sock", "--no-sandbox", "--network host", " -p ", "--publish"):
            self.assertNotIn(forbidden, joined)
        self.assertEqual(args.count("-v"), 1)
        self.assertTrue(args[args.index("-v") + 1].endswith(":/uploads:ro"))
        self.assertIn(cfg.image, args)              # by image ID
        self.assertEqual(args[-1], "about:blank")
        self.assertNotIn("--remote-debugging", joined)   # the image's entrypoint owns DevTools

    def test_memory_parsing(self):
        self.assertAlmostEqual(parse_mem_mb("198.6MiB / 700MiB"), 198.6)
        self.assertAlmostEqual(parse_mem_mb("1.5GiB / 2GiB"), 1536.0)
        self.assertIsNone(parse_mem_mb("--"))


class Config(unittest.TestCase):
    def good(self, **over):
        raw = dict(image="sha256:" + "a" * 64, seccomp_sha256="b" * 64, platform_url="https://p.example")
        raw.update(over)
        return config.from_dict(raw)

    def test_defaults_match_the_design(self):
        cfg = self.good()
        self.assertEqual((cfg.max_concurrent, cfg.queue_max, cfg.idle_s, cfg.waiting_s, cfg.cap_s), (1, 5, 300, 180, 900))
        self.assertEqual(cfg.closed_keep_s, 7 * 24 * 3600)

    def test_refusals(self):
        for over in (
            {"image": "hermes-browser:phase1-145"},          # a tag can move
            {"seccomp_sha256": "zz"},
            {"platform_url": "http://platform.example"},     # plain http off loopback
            {"idle_s": 1000},
            {"dns": ["not-an-ip"]},
            {"memory": "lots"},
            {"nonsense": 1},
        ):
            with self.assertRaises(config.ConfigError, msg=str(over)):
                self.good(**over)
        self.good(platform_url="http://127.0.0.1:9999")       # loopback http is for the test stub

    def test_seccomp_digest_must_match(self):
        with tempfile.NamedTemporaryFile("wb", delete=False) as f:
            f.write(b"{}")
        cfg = self.good(seccomp_profile=f.name)
        with self.assertRaises(config.ConfigError):
            config.check_seccomp(cfg)
        import hashlib
        cfg = self.good(seccomp_profile=f.name, seccomp_sha256=hashlib.sha256(b"{}").hexdigest())
        config.check_seccomp(cfg)

    def test_hmac_key_is_created_private_and_stable(self):
        path = os.path.join(tempfile.mkdtemp(), "hmac.key")
        first = config.load_or_create_key(path)
        self.assertEqual(len(first), 32)
        self.assertEqual(oct(os.stat(path).st_mode & 0o777), "0o600")
        self.assertEqual(config.load_or_create_key(path), first)


if __name__ == "__main__":
    unittest.main()
