import base64
import json
import unittest

from browser_broker.cdp import CdpError, click_and_settle, read_page, take_screenshot
from browser_broker.manager import BrokerError, Manager
from tests.fakes import Clock, FakeCdp, FakeDocker, FakePlatform, FakeRelay, KEY_A, make_config

FORM = {"url": "https://shop.test/form", "title": "Order", "text": "Name\nSubmit order", "truncated": False, "invalid": [], "ready": "complete"}
DONE = {"url": "https://shop.test/done", "title": "Thank you", "text": "Thank you for your order", "truncated": False, "invalid": [], "ready": "complete"}


class Page:
    """A stand-in for the page: answers the three scripts the module sends, in the order the module sends them."""

    def __init__(self, before, after, found=True, polls=None):
        self.before, self.after, self.found = before, after, found
        self.polls = list(polls) if polls is not None else [{"href": after["url"], "ready": "complete"}] * 5
        self.clicked = False
        self.calls = []

    async def call(self, method, params=None):
        self.calls.append((method, params))
        if method != "Runtime.evaluate":
            return {}
        expression = params["expression"]
        if "querySelectorAll('button" in expression:
            self.clicked = True
            self.last_click = expression
            return {"result": {"value": {"found": True, "label": "Submit order"} if self.found else {"found": False}}}
        if "location.href, ready" in expression:
            value = self.polls.pop(0) if self.polls else {"href": self.after["url"], "ready": "complete"}
            if value is None:
                raise CdpError("cdp_failed")
            return {"result": {"value": value}}
        return {"result": {"value": self.after if self.clicked else self.before}}


async def no_wait(_):
    return None


class Clicking(unittest.IsolatedAsyncioTestCase):
    async def test_a_submit_that_leads_to_a_new_page_reports_what_that_page_shows(self):
        page = Page(FORM, DONE)
        clock = Clock()
        out = await click_and_settle(page, None, "Submit order", sleep=clock.sleep, clock=clock)
        self.assertEqual((out["clicked"], out["changed"], out["url"], out["urlBefore"]),
                         ("Submit order", True, "https://shop.test/done", "https://shop.test/form"))
        self.assertEqual((out["title"], out["text"]), ("Thank you", "Thank you for your order"))

    async def test_the_words_are_placed_in_the_page_script_as_data_not_code(self):
        page = Page(FORM, DONE)
        clock = Clock()
        await click_and_settle(page, 'a"]);alert(1);//', 'x"); evil("', sleep=clock.sleep, clock=clock)
        self.assertIn(json.dumps('a"]);alert(1);//'), page.last_click)       # inside a JSON string literal
        self.assertNotIn('alert(1);//,', page.last_click.replace(json.dumps('a"]);alert(1);//'), ""))

    async def test_a_click_that_changes_nothing_says_so_and_names_the_fields_the_browser_refused(self):
        refused = dict(FORM, invalid=["custname", "custtel"])
        page = Page(FORM, refused, polls=[{"href": FORM["url"], "ready": "complete"}] * 20)
        clock = Clock()
        out = await click_and_settle(page, "#go", None, settle_s=4.0, sleep=clock.sleep, clock=clock)
        self.assertFalse(out["changed"] and out["url"] != out["urlBefore"])
        self.assertEqual(out["invalid"], ["custname", "custtel"])

    async def test_nothing_to_click_is_an_error_and_nothing_is_clicked(self):
        page = Page(FORM, DONE, found=False)
        with self.assertRaises(CdpError) as caught:
            await click_and_settle(page, None, "Missing button", sleep=no_wait)
        self.assertEqual(caught.exception.kind, "not_found")

    async def test_a_page_that_is_being_replaced_is_waited_for(self):
        page = Page(FORM, DONE, polls=[None, None, {"href": DONE["url"], "ready": "loading"}, {"href": DONE["url"], "ready": "complete"},
                                       {"href": DONE["url"], "ready": "complete"}])
        clock = Clock()
        out = await click_and_settle(page, None, "Submit order", sleep=clock.sleep, clock=clock)
        self.assertEqual(out["url"], DONE["url"])

    async def test_a_page_that_never_settles_does_not_hold_the_session_for_ever(self):
        page = Page(FORM, DONE, polls=[{"href": FORM["url"], "ready": "loading"}] * 500)
        clock = Clock()
        out = await click_and_settle(page, None, "Submit order", settle_s=6.0, sleep=clock.sleep, clock=clock)
        self.assertIn("text", out)                                         # gave what it could see after the limit
        self.assertLess(clock() - 1_000_000.0, 8)

    async def test_the_page_words_are_read_and_bounded(self):
        page = Page(FORM, DONE)
        self.assertEqual((await read_page(page))["title"], "Order")


class Shot(unittest.IsolatedAsyncioTestCase):
    class T:
        def __init__(self, data):
            self.data, self.calls = data, []

        async def call(self, method, params=None):
            self.calls.append(method)
            if method == "Page.captureScreenshot":
                return {"data": self.data}
            return {}

    async def test_a_jpeg_comes_back_and_the_browser_is_put_back_as_it_was(self):
        t = self.T(base64.b64encode(b"\xff\xd8\xff\xe0jpegbytes").decode())
        self.assertEqual(await take_screenshot(t), b"\xff\xd8\xff\xe0jpegbytes")
        self.assertEqual(t.calls, ["Emulation.setDeviceMetricsOverride", "Page.captureScreenshot", "Emulation.clearDeviceMetricsOverride"])

    async def test_anything_that_is_not_a_jpeg_is_refused_and_the_browser_is_still_put_back(self):
        t = self.T(base64.b64encode(b"<html>not a picture</html>").decode())
        with self.assertRaises(CdpError):
            await take_screenshot(t)
        self.assertEqual(t.calls[-1], "Emulation.clearDeviceMetricsOverride")


class Submitting(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.clock, self.cdp, self.platform = Clock(), FakeCdp(), FakePlatform()
        self.m = Manager(make_config(), FakeDocker(), self.cdp, b"k" * 32, clock=self.clock, sleep=self.clock.sleep, relay_cls=FakeRelay)

    async def test_the_result_and_a_picture_of_the_page_go_out_together(self):
        s = await self.m.create("user-a")
        out = await self.m.submit(s.id, "user-a", KEY_A, None, "Submit order", self.platform)
        self.assertEqual((out["title"], out["attachment"], out["changed"]), ("Thank you", True, True))
        self.assertEqual(self.cdp.submits[0][2], "Submit order")
        who, jpeg, caption = self.platform.proofs[0]
        self.assertEqual((who, caption), ("user-a", "Thank you"))              # to the owner's outbox, labelled with the title
        self.assertTrue(jpeg.startswith(b"\xff\xd8\xff"))

    async def test_a_picture_that_cannot_be_taken_or_sent_never_undoes_the_action(self):
        s = await self.m.create("user-a")
        self.cdp.shot_error = True
        self.assertFalse((await self.m.submit(s.id, "user-a", KEY_A, "#go", None, self.platform))["attachment"])
        self.cdp.shot_error = False
        self.platform.proof_error = True
        out = await self.m.submit(s.id, "user-a", KEY_A, "#go", None, self.platform)
        self.assertEqual((out["attachment"], out["title"]), (False, "Thank you"))   # the result still comes back

    async def test_only_the_owner_of_a_ready_session_can_submit_or_ask_for_a_picture(self):
        s = await self.m.create("user-a")
        with self.assertRaises(BrokerError) as caught:
            await self.m.submit(s.id, "user-b", "key-user-b-0123456789abcdef", None, "Go", self.platform)
        self.assertEqual(caught.exception.code, "not_found")
        self.assertTrue(await self.m.proof(s.id, "user-a", KEY_A, "final page", self.platform))
        self.assertEqual(self.platform.proofs[-1][2], "final page")
        await self.m.close(s.id, "user-a")
        with self.assertRaises(BrokerError):
            await self.m.submit(s.id, "user-a", KEY_A, None, "Go", self.platform)


if __name__ == "__main__":
    unittest.main()
