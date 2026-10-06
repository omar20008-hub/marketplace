# Post scheduler

A product that publishes a post to the user's Facebook Page and/or Instagram
Business account at a date and time they choose. Template:
`templates/post-scheduler.json`. Upload it in Creator studio like any product.

## How it works

1. The user asks in the main chat. The Orchestrator collects the template's
   inputs (`caption`, `networks`, `scheduledAt`, plus optional `mediaUrl`,
   `pageId`) and asks for whatever is missing before it runs anything.
2. The workflow's schedule path calls `POST /api/posts` on the platform with the
   installation's own `kb_…` key (the placeholders `__MP_PLATFORM_URL__` and
   `__MP_KNOWLEDGE_KEY__`, filled in at install). The platform validates and
   stores the post in `ScheduledPost` — the queue lives in the platform, which is
   the default storage destination.
3. The same clock that drives schedules and indexing (`/api/schedules/tick`,
   `/api/knowledge/tick`, or the in-process `KNOWLEDGE_TICK_INTERVAL_SECONDS`
   scheduler) calls `runDuePosts()`. Each due post is claimed with a
   compare-and-swap and handed back to the same installation through
   `executeRun()`, with `postId` set.
4. With `postId` present the workflow takes its publishing path: it lists the
   user's Pages with their `facebookGraphApi` connection, posts to Facebook
   (`/feed`, or `/photos` with an image) and/or creates and publishes an
   Instagram media container using the Page token.

Several posts are several runs; each is its own row.

## Attaching an image

The chat composer (and the follow-up box in a thread) has an attach button for
JPEG and PNG images, up to 8 MB each and 4 per message. The file is uploaded to
`POST /api/media`, stored in `MediaUpload` and served from an unguessable public
link (`/api/media/<token>.jpg|png`) — Instagram and Facebook fetch the image from
a URL, and a post can be scheduled weeks ahead, so the link works for 90 days and
the tick deletes what has expired. The submitted links are re-checked against the
signed-in user before the message tells the assistant to use them as `mediaUrl`.

- The type is read from the file's first bytes, never from its name or declared type.
- Instagram publishes JPEG only: a PNG is accepted for Facebook, and a PNG link
  for an Instagram post is refused with a sentence the assistant can relay.
- The Orchestrator (an n8n workflow) has to act on the note the platform appends
  to the message (“use these exact public URLs as the post's mediaUrl”). That
  workflow is not in this repository; check it on a real run.
- The platform's own address must be reachable from the internet (`PUBLIC_URL`),
  or the networks cannot fetch the image.

## Rules the platform enforces (`parsePostInput`)

Caption 1–2200 characters; networks `facebook` and/or `instagram`; `mediaUrl`
must be https and is required for Instagram; `scheduledAt` ISO 8601, between one
minute and 75 days ahead; `pageId` numeric. Times are UTC, as everywhere else.

## Behaviour worth knowing

- **A post is tried once.** If the workflow fails after Facebook accepted the
  call, retrying would post twice. A failure is recorded on the post (`result`).
  A post stuck `PUBLISHING` for 15 minutes is marked failed, not re-sent.
- Publishing goes through `executeRun()`, so it meets the readiness check and
  plan limit, and **each publish counts as a run**. Five consecutive failures
  disable the installation, as for any product.
- A scheduled post can be cancelled (`DELETE /api/posts/:id`) until it starts
  publishing.

## Not verified here

Nothing in this change has run against a real n8n instance or Facebook. Before
relying on it: upload the template, approve it, connect a Facebook token that can
manage a Page (`pages_manage_posts`, plus `instagram_content_publish` for
Instagram), and schedule a post two minutes ahead. Specifically check that
Upload & Provision marks `mediaUrl`, `pageId` and `postId` as optional inputs —
the mock treats every declared field as required unless it says otherwise.
