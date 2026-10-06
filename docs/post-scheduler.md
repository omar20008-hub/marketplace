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
