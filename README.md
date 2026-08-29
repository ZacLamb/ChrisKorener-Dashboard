# Dispatch — GHL Conversation Dashboard

An organizational dashboard for one GHL sub-account, built strictly off the Conversations API: every thread across every channel, an AI one-line synopsis per thread, a one-click "what's happening" account report, reply-from-dashboard, and filters/analytics.

## What it does

- **Pulls every conversation** (SMS, Email, WhatsApp, FB, IG, GMB, Live Chat, Call logs) for your location into its own Postgres database, on a 5-minute background sync plus a manual "Sync now" button.
- **AI synopsis per thread** — one sentence on what's happening, sentiment, and whether it needs a reply. Generated on demand or in bulk.
- **"Run report" button** — summarizes anything new, then rolls every thread up into one executive overview: volume/mix, patterns worth flagging, which threads most urgently need you.
- **Reply from the dashboard** — auto-detects the channel the thread came in on (SMS thread replies as SMS, email thread replies as email, etc.) so you never have to think about it.
- **Filters** — channel, assigned rep, tag, read/unread, date range, free-text search.
- **Analytics** — volume by channel, by day, by assignee, sentiment split.

## Stack

Node/Express + Postgres, single Railway service, static frontend served from the same app (no separate frontend host, no build step — fits your GitHub-web-UI + Railway-auto-deploy workflow).

## 1. Push this to GitHub

Create a new repo on github.com (web UI), then use "Add file → Upload files" and drag in this whole folder — or, if you'd rather, tell me and I'll walk you through GitHub's "import" from a zip instead.

## 2. Deploy on Railway

1. New Project → Deploy from GitHub repo → pick the repo you just created.
2. Add a **Postgres** plugin to the project (Railway auto-sets `DATABASE_URL` on your service — you don't need to copy it manually).
3. On the app service, go to **Variables** and paste in everything from `.env.example`, filled in with real values:
   - `GHL_API_TOKEN` — your Private Integration Token (or Agency API key) with Conversations + Contacts read/write scopes
   - `GHL_LOCATION_ID` — the sub-account's location ID
   - `AI_PROVIDER` — `anthropic` (recommended) or `openai`
   - `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` (defaults to `claude-haiku-4-5`) — or `OPENAI_API_KEY` / `OPENAI_MODEL` if you go that route
   - `DASHBOARD_USER` / `DASHBOARD_PASS` — basic-auth login for the dashboard itself, since it has send access
4. Under **Settings → Deploy**, set the **Start command** to `node src/migrate.js && node server.js` — this runs the schema migration on every deploy (safe to re-run; it's all `IF NOT EXISTS`) and then boots the app.
5. Deploy. Railway gives you a public URL — that's your dashboard. Open it, log in with `DASHBOARD_USER`/`DASHBOARD_PASS`, hit **Sync now** once to pull everything in.

## 3. First run

- Click **Sync now** — pulls all conversations + message history.
- Click **Run report** — generates the AI synopsis for every thread and the executive overview. On a big account with hundreds of threads, the first report takes longer (it's summarizing everything for the first time); after that it only re-summarizes threads with new messages, so it's fast.

## Notes on the GHL API layer

Everything that talks to GHL lives in `src/ghlClient.js`. GHL has iterated on the exact query params for `/conversations/search` a few times over the past couple years — if your token comes back with a validation error on that endpoint, that file is the one place to adjust it against whatever your current API docs/Postmark collection shows. Same goes for the send-message channel `type` values in `channelToSendType()` if GHL adds a new channel.

## Using this for a client instead of yourself

Nothing in here is Fundara-specific — it's one dashboard per `GHL_LOCATION_ID` + `GHL_API_TOKEN` pair. To stand it up for a client:
1. Get a Private Integration Token scoped to their sub-account (or use your agency-level key with their location ID).
2. Deploy a **separate Railway service** from the same repo (or a new project) with that client's variables — don't share one Postgres between two locations, since the schema has no location column.
3. Rebrand `public/index.html`'s title / `.brand-name` if you want it white-labeled per client.

Cost-wise: Railway's free/hobby tier plus a Haiku or 4o-mini bill of a few dollars a month for summarization covers most single-location accounts comfortably — cheap enough that it's a rounding error next to what one recovered lead is worth.
