# Post scheduler

A product that publishes a post to the user's Facebook Page and/or Instagram
Business account at a date and time they choose. Template:
`templates/post-scheduler.json`. Upload it in Creator studio like any product.

## How it works

1. The user asks in the main chat. The Orchestrator collects the template's
   inputs (`caption`, `networks`, `scheduledAt`, `mediaUrl`, `postId`) and asks for
   whatever is missing before it runs anything. See *Why every input is required*.
2. The workflow's schedule path calls `POST /api/posts` on the platform with the
   installation's own `kb_…` key (the placeholders `__MP_PLATFORM_URL__` and
   `__MP_KNOWLEDGE_KEY__`, filled in at install). The platform validates and
   stores the post in `ScheduledPost` — the queue lives in the platform, which is
   the default storage destination.
3. The same clock that drives schedules and indexing (`/api/schedules/tick`,
   `/api/knowledge/tick`, or the in-process `KNOWLEDGE_TICK_INTERVAL_SECONDS`
   scheduler) calls `runDuePosts()`. Each due post is claimed with a
   compare-and-swap and handed back to the same installation through
   `executeRun()`, with `postId` set to the post's id.
4. With a real `postId` (anything but `new`) the workflow takes its publishing
   path: it lists the user's Pages with their `facebookGraphApi` connection and
   uses the first one, posts to Facebook
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

## Why every input is required

MP · Dispatcher treats every declared input as required: a missing or empty one
comes back as `incomplete`, and MP · Upload & Provision has no way to mark one
optional. So the template declares only inputs that always carry a value, and the
two that are sometimes meaningless carry a word instead:

- `mediaUrl` is the image link, or `none` for a text-only Facebook post.
- `postId` is `new` when the user is scheduling (the Orchestrator always passes
  it, and never asks), and the post's id when the platform publishes it.

MP · Orchestrator's rule 17 tells the assistant this. The platform sends the same
two words back when it publishes, and `POST /api/posts` reads `mediaUrl: none` as
no image.

## Rules the platform enforces (`parsePostInput`)

Caption 1–2200 characters; networks `facebook` and/or `instagram`; `mediaUrl`
must be https and is required for Instagram; `scheduledAt` ISO 8601, between one
minute and 75 days ahead. Times are UTC, as everywhere else.

## Behaviour worth knowing

- **A post is tried once.** If the workflow fails after Facebook accepted the
  call, retrying would post twice. A failure is recorded on the post (`result`).
  A post stuck `PUBLISHING` for 15 minutes is marked failed, not re-sent.
- Publishing goes through `executeRun()`, so it meets the readiness check and
  plan limit, and **each publish counts as a run**. Five consecutive failures
  disable the installation, as for any product.
- A failed post keeps its reason (Posts, History): what the workflow reported, with
  Facebook's own message when the failure came from the Graph API (an expired or
  invalid token reads as such). The reason comes from the dispatcher's `errorType`.
- A scheduled post can be cancelled (`DELETE /api/posts/:id`) until it starts
  publishing.

## Connecting Facebook & Instagram

**Continue with Facebook is the main way**; pasting an access token is the second.
Both end in the same place: one `facebookGraphApi` connection per user whose
secret is exactly `{ accessToken }` (n8n's credential body refuses anything else),
so installing a product does not care which way it was made.

- **Sign-in** — `GET /api/oauth/facebook/start` → Facebook's dialog →
  `GET /api/oauth/facebook/callback`. State lives in a signed httpOnly cookie
  (`fb_oauth`, path `/api/oauth/facebook`) tied to the signed-in user, like the
  Drive flow. The code is swapped for a short token and that for a long-lived one
  (about 60 days); the callback then reads `/me`, `/me/permissions` and
  `/me/accounts` and refuses, with a message, a sign-in where the posting
  permission was unticked or the account has no Page. The connection is labelled
  `<name> · <first Page>` — the Page posts go to.
- **Expiry** — Facebook gives no refresh token. `expireFacebookAccounts()` (run on
  every scheduler tick and by `POST /api/accounts/keepalive`) marks a connection
  whose token ran out `EXPIRED`, which shows **Reconnect** on Connected accounts and
  a note on the product. A pasted token has no recorded lifetime and is never
  expired by the clock.
- **Token instead** — the setup step and Connected accounts keep the access-token
  form. Either way replaces the user's one Facebook connection in place.
- **Settings** — `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`, and `PUBLIC_URL` (or
  `FACEBOOK_REDIRECT_URI`); the redirect URI, `<PUBLIC_URL>/api/oauth/facebook/callback`,
  must be listed under *Facebook Login → Valid OAuth Redirect URIs*. Without them
  the button explains what is missing and the token form still works.
- **Meta app review** — in Development mode only people with a role on the app
  (admin, developer, tester) can sign in. For everyone else the app needs App Review
  for `pages_manage_posts`, `pages_read_engagement`, `pages_show_list`,
  `instagram_basic` and `instagram_content_publish`, and usually Business
  Verification.
- **Known limit** — the token is copied into n8n's credential when a product is
  installed. After reconnecting, remove the product and add it again so the new token
  reaches n8n (there is no credential-update call yet).

## Not verified here

Nothing in this change has run against a real Facebook account. Before relying on
it: upload the template, approve it, connect Facebook (the sign-in, or a token that can manage a
Page (`pages_manage_posts`, plus `instagram_content_publish` for Instagram), and
schedule a post two minutes ahead. What *has* been checked against the live n8n
workflows (by reading them): the node types are on the whitelist (the Code nodes
are flagged for manual review), `facebookGraphApi` is a registered durable
credential type, the install key and platform URL are sent on every activation,
and the dispatcher's required-input rule above.

The publishing path posts to the **first** Page the token can manage; choosing
among several Pages is not supported.
