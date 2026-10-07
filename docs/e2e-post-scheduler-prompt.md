# Prompt: end-to-end test of "Post scheduler" in Chrome

Paste everything below the line into a NEW Claude Code session started on your own
machine, inside a local clone of this repository, with the Claude in Chrome
extension installed and connected.

---

## Goal
Run the first REAL end-to-end test of the "Post scheduler" product on the live test
platform, driving my own Chrome through Claude in Chrome (tools named
`mcp__claude-in-chrome__*`; read the `chrome-browser` skill first if available).
Report precisely what works and what breaks. Fix only clear bugs in this repo;
otherwise report. Write the report in Arabic, with exact error text quoted as-is.

Platform (test): https://marketplace-production-3f79.up.railway.app/  (login at /login)
Repo: this checkout, branch `main`. Read `docs/post-scheduler.md` first, then
`AGENTS.md` (this Next.js has breaking changes).

## What was built (so you know what to expect)
- Template `templates/post-scheduler.json`: an on-demand product. The user asks in the
  main chat; the Orchestrator (n8n workflow `MP · Orchestrator`) collects
  `caption`, `networks` (`facebook`, `instagram` or both, comma-separated),
  `scheduledAt` (ISO 8601 **UTC**), `mediaUrl` and `postId`.
- **Every declared input is required** by the dispatcher, so two carry words:
  `mediaUrl` = the image link, or `none` for a text-only Facebook post; `postId` =
  `new` when scheduling (the assistant must pass it WITHOUT asking me).
- Scheduling saves the post in the platform (`ScheduledPost`, `/api/posts`). The tick
  (about once a minute) hands each due post back to the same installation, which
  publishes it with my Facebook connection (first Page the token manages; Instagram
  through that Page's linked Business account).
- Screens: My workspace → the product's **Posts** button → `/workspace/<id>/posts`
  (Upcoming / History, UTC times, Cancel). Failures show their reason there.
- Chat attachments: a paperclip in the composer and in the thread follow-up box
  uploads a JPEG/PNG (8 MB, up to 4) to `/api/media`; the message then shows
  `Attached image: <url>` and the assistant is told to use that URL as `mediaUrl`.
- Instagram publishes JPEG only: a PNG link for an Instagram post must be refused.
- Nothing here has ever run against a real Facebook account. Treat every step as unproven.

## Before you start: ask me for / confirm (never guess, never print secrets in chat or commit them)
1. Platform logins: a CREATOR account (upload) and an ADMIN account (approve), and a
   normal USER account (may be the same person). I type passwords myself if asked.
2. A **test** Facebook Page I own (never a real audience's Page) and a long-lived
   user access token that manages it, with `pages_manage_posts`,
   `pages_read_engagement` and, for Instagram, `instagram_content_publish`. For the
   Instagram steps, an Instagram Business account linked to that Page. If Instagram is
   not available, skip those steps and say so. I paste the token into the platform's
   connect form myself; you never read it back or log it.
3. Two small test images on my computer: a JPEG and a PNG. Tell me if you cannot use
   a file picker and I will tell you what to do.
4. The deployment already has: the latest `main` deployed (3 new migrations applied:
   `scheduled_posts`, `product_uses_posts`, `media_uploads`), `PUBLIC_URL` set to the
   public address, and something calling the tick about once a minute
   (`KNOWLEDGE_TICK_INTERVAL_SECONDS=60`, or `POST /api/schedules/tick`). If any is
   missing, STOP and tell me what to set; do not work around it.

## Steps (screenshot each; note exact error text on any failure)
1. **Upload.** As creator → Creator studio → upload `templates/post-scheduler.json`
   (title "Post scheduler", a category, a one-line summary, action type write).
   Expect: accepted; invocation mode `on_demand`; required credential
   `facebookGraphApi` only; durability durable; flagged nodes: `code` (two Code
   nodes, manual review); external hosts `graph.facebook.com` and the platform host;
   input fields `caption, networks, scheduledAt, mediaUrl, postId`. If rejected, copy
   the exact reason (n8n workflow "MP · Upload & Provision", node "Validate and Sanitize").
2. **Approve.** As admin → Admin review → open the submission, read the flagged Code
   nodes, approve. Expect status PUBLISHED (the panel may ask to finish in n8n).
3. **Activate.** As a normal user → open the product → Activate. Expect: a connection
   step for the Facebook token and **no "Your files" step** (this is not a Drive
   product). Connect, finish. Expect the product in My workspace with a **Posts** button.
4. **Schedule a text post.** In the main chat: "Schedule a Facebook post on my Page
   for 3 minutes from now saying: Test post from Builder". Expect the assistant to:
   know the current time, ask for my time zone only if I did not give one, show the
   final values with the time in UTC and ask me to confirm, and **never ask for a post
   id or page**. It may ask once whether I want an image; answer "no". After I confirm,
   expect a reply that the post was scheduled (Arabic). Then open the Posts screen:
   one row under Upcoming, status Scheduled, correct UTC time.
5. **It publishes.** Wait past the scheduled time plus one tick (up to 2 minutes). Reload
   Posts: expect Published (it also moves to History). Open the Facebook Page and
   confirm the post exists. If it shows Failed, copy the reason verbatim and open the
   n8n execution for that run if you can reach it.
6. **Post with an image.** In a new chat, click the paperclip, choose the JPEG; expect a
   chip with a thumbnail. Type: "Post this on Facebook and Instagram in 3 minutes,
   caption: Image test" and send. Expect the thread to show `Attached image: <url>`,
   that URL to open the image in a **private/signed-out window** (public link), the
   assistant to use exactly that URL and not ask for another, and a scheduled row in
   Posts. After the time: Published; confirm a photo post on the Page and on Instagram.
7. **PNG on Instagram is refused.** Attach the PNG and ask for an Instagram post.
   Expect a clear message that Instagram only accepts JPEG, and nothing scheduled for
   Instagram. A PNG for Facebook only should work.
8. **Attachment limits.** Try attaching a `.txt` file: expect "Only JPEG and PNG images
   can be attached." and no chip. (Optionally an image over 8 MB: expect a refusal.)
9. **Cancel.** Schedule a post for tomorrow, open Posts, click Cancel: expect it moves
   to History as Cancelled and is never published.
10. **Two posts.** Ask for two posts at different times in one request. Expect two
    separate rows (the assistant may confirm each).
11. **Refusals.** Ask for a post in the past: expect it to be refused or corrected with
    a sentence, not scheduled. Ask for a time more than 75 days ahead: same.
12. **Clock health.** Create a post for 1 minute ahead and do not touch it: if it is
    still Scheduled 6+ minutes after its time, the Posts screen should warn that the
    scheduled clock may be stopped. Report whether it does, and whether the tick is
    actually running.

## If something fails (what to check first)
- Assistant asks for a post id, page, or image URL it should not: the Orchestrator rule 17
  / rule 15 was not followed (it is a prompt). Quote the exact exchange.
- Scheduling returns `incomplete`: a declared input was empty; list which.
- Post stays Scheduled past its time: the tick is not running (`/api/schedules/tick` with
  header `x-schedule-token`) or the run was blocked (plan limit, connection needs attention).
- Failed with a Graph API message: quote it. Common causes: token lacks
  `pages_manage_posts`; the Page has no linked Instagram Business account; the image URL
  is not reachable from the internet (`PUBLIC_URL`).
- Image URL does not open signed out: `PUBLIC_URL` is wrong or the link expired.

## Safety rules
- Use only the test Page. Delete every test post from the Page (and Instagram) when done.
- Never print, log or commit tokens, passwords, `kb_…` keys or `SECRETS_KEY`.
- If a step would spend money, change billing, or grant permissions I did not mention,
  stop and ask.
- Do not "fix" the platform by editing data in the database. Report instead.

## Report format
A table: step | expected | what happened | pass / fail. Then a short list of bugs with
exact error text and the step that produced them, and a list of anything you could not
test and why. Finish by listing what you left behind (posts, uploads) so I can clean up.
