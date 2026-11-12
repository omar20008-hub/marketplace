import asyncio
import unittest

from browser_broker.relay import MAX_HEAD, Relay

PATH = "/devtools/browser/0a1b2c3d-1111-2222-3333-444455556666"


def request(path=PATH, extra="", upgrade=True, method="GET"):
    head = "%s %s HTTP/1.1\r\nHost: 127.0.0.1:9999\r\n" % (method, path)
    if upgrade:
        head += "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGVzdA==\r\nSec-WebSocket-Version: 13\r\n"
    return (head + extra + "\r\n").encode()


class RelayCase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.heads = []                       # what the "browser" received
        self.activity = 0
        self.upstream = await asyncio.start_server(self._browser, "127.0.0.1", 0)
        up_port = self.upstream.sockets[0].getsockname()[1]
        self.relay = Relay("127.0.0.1", up_port, PATH, self._bump)
        self.port = await self.relay.start()

    async def asyncTearDown(self):
        await self.relay.stop()
        self.upstream.close()
        await self.upstream.wait_closed()

    def _bump(self):
        self.activity += 1

    async def _browser(self, reader, writer):
        """A stand-in for Chrome: answers the upgrade, then shouts back what it is sent."""
        try:
            head = await reader.readuntil(b"\r\n\r\n")
            self.heads.append(head.decode("latin-1"))
            writer.write(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")
            await writer.drain()
            while True:
                data = await reader.read(1024)
                if not data:
                    break
                writer.write(data.upper())
                await writer.drain()
        except (ConnectionError, asyncio.IncompleteReadError):
            pass
        finally:
            writer.close()

    async def connect(self, payload: bytes):
        reader, writer = await asyncio.open_connection("127.0.0.1", self.port)
        writer.write(payload)
        await writer.drain()
        return reader, writer

    async def status_of(self, payload: bytes) -> str:
        reader, writer = await self.connect(payload)
        data = await asyncio.wait_for(reader.read(), 5)
        writer.close()
        return data.split(b"\r\n", 1)[0].decode()


class Accepts(RelayCase):
    async def test_the_exact_upgrade_passes_through_both_ways_and_counts_as_activity(self):
        reader, writer = await self.connect(request(extra="Origin: https://evil.example\r\n"))
        head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 5)
        self.assertTrue(head.startswith(b"HTTP/1.1 101"))
        writer.write(b"hello")
        await writer.drain()
        self.assertEqual(await asyncio.wait_for(reader.readexactly(5), 5), b"HELLO")
        self.assertGreater(self.activity, 1)
        sent = self.heads[0]
        self.assertIn("Host: localhost", sent)                 # presented as a local client
        self.assertNotIn("127.0.0.1:9999", sent)
        self.assertNotIn("Origin", sent)                       # a page origin would be refused by Chrome
        self.assertIn("Sec-WebSocket-Key: dGVzdA==", sent)     # the handshake itself is untouched
        writer.close()

    async def test_several_connections_at_once(self):
        pairs = [await self.connect(request()) for _ in range(3)]
        for reader, writer in pairs:
            await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 5)
            writer.write(b"x")
            await writer.drain()
            self.assertEqual(await asyncio.wait_for(reader.readexactly(1), 5), b"X")
            writer.close()


class Refuses(RelayCase):
    async def test_a_wrong_or_partial_path_is_not_found_and_never_reaches_the_browser(self):
        for path in ("/devtools/browser/other", PATH + "x", PATH + "?a=1", PATH[:-1], "/", "/json/version", "/json/list"):
            self.assertEqual(await self.status_of(request(path)), "HTTP/1.1 404 Not Found", path)
        self.assertEqual(self.heads, [])

    async def test_the_right_path_without_a_websocket_upgrade_is_not_found(self):
        self.assertEqual(await self.status_of(request(upgrade=False)), "HTTP/1.1 404 Not Found")
        self.assertEqual(await self.status_of(request(method="POST")), "HTTP/1.1 404 Not Found")
        self.assertEqual(self.heads, [])

    async def test_garbage_and_oversized_requests_do_not_get_through(self):
        reader, writer = await self.connect(b"NOT HTTP AT ALL\r\n\r\n")
        self.assertIn(b"404", await asyncio.wait_for(reader.read(), 5))
        writer.close()
        big = request(extra="X-Pad: " + "a" * (MAX_HEAD * 3) + "\r\n")
        reader, writer = await self.connect(big)
        data = await asyncio.wait_for(reader.read(), 5)       # closed without a pass-through
        self.assertNotIn(b"101", data)
        writer.close()
        self.assertEqual(self.heads, [])

    async def test_an_unreachable_browser_is_a_bad_gateway(self):
        dead = Relay("127.0.0.1", 1, PATH, self._bump)
        port = await dead.start()
        reader, writer = await asyncio.open_connection("127.0.0.1", port)
        writer.write(request())
        await writer.drain()
        self.assertTrue((await asyncio.wait_for(reader.read(), 5)).startswith(b"HTTP/1.1 502"))
        writer.close()
        await dead.stop()


class Stops(RelayCase):
    async def test_stopping_closes_open_connections_and_the_door(self):
        reader, writer = await self.connect(request())
        await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 5)
        await self.relay.stop()
        self.assertEqual(await asyncio.wait_for(reader.read(), 5), b"")      # the open connection ended
        with self.assertRaises(OSError):
            await asyncio.open_connection("127.0.0.1", self.port)
        writer.close()


if __name__ == "__main__":
    unittest.main()
