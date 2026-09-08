# Deploying the bot

The bot has no long-lived process. Discord POSTs each interaction to an HTTPS
endpoint, so it runs as a Cloudflare Worker that is cold between commands —
which, for five people, is nearly all the time.

That is why it can't be a routine, incidentally. A routine is *scheduled and
ephemeral*: cron fires it, it allocates a sandbox, works, exits. A gateway bot
needs a websocket held open continuously. Neither fits the other. HTTP
interactions sidestep the question entirely — there is nothing to keep alive.

## What only you can do

**1. A Cloudflare account.** Free tier is far more than enough: the paid
threshold is 100,000 requests/day, and five people running slash commands will
not approach it. https://dash.cloudflare.com/sign-up

**2. An API token.** Cloudflare → My Profile → API Tokens → Create Token →
use the **Edit Cloudflare Workers** template. Two values come out of this:

- the token itself
- your **Account ID**, on the right-hand side of any domain overview page, or
  under Workers & Pages

Put both in `.env`:

```
CLOUDFLARE_API_TOKEN=...
CLOUDFLARE_ACCOUNT_ID=...
```

`.env` is gitignored. Do not paste either into a chat, an issue, or a commit.

## Deploying

```
cd packages/bot

# Secrets live in Cloudflare, never in wrangler.toml or the repo.
npx wrangler secret put DISCORD_TOKEN
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put GITHUB_TOKEN

npm run build
npm run deploy
```

`wrangler deploy` prints the worker URL, of the form
`https://darwin-bot.<subdomain>.workers.dev`.

## Point Discord at it

Developer Portal → your application → **General Information** →
**Interactions Endpoint URL** → paste the worker URL → **Save Changes**.

Discord immediately POSTs a `PING` with a valid signature, and separately probes
with deliberately **invalid** ones. It refuses to save the URL unless the bad
ones get a 401 and the good one gets `{"type": 1}`. If saving fails, that is
what to look at first — `npx wrangler tail` shows the requests live.

## Registering the commands

Only needed when a command's name, description or options change — not on every
deploy.

```
npm run -w @darwin/bot register
```

Guild-scoped, so changes appear instantly. Global commands take up to an hour.

## Checking it

```
node tools/check-credentials.mjs   # all 19 checks, including the public key
npx wrangler tail                  # live logs while you use a command in Discord
```

Then run `/board` in Discord. It reads all three repos, so it exercises the
GitHub token, the worker, and the follow-up edit in one command.

## Things that will break it

- **Rotating the bot token or the GitHub PAT** without running
  `wrangler secret put` again. The worker keeps the old value.
- **Regenerating the app's public key.** The endpoint then rejects everything
  Discord sends, which looks exactly like an outage.
- **Adding a Node-only API** to `packages/bot` or `packages/state` — `Buffer`,
  `node:crypto`, `fs`. The worker runs on the standard runtime with no
  `nodejs_compat` flag, deliberately, so that this fails at build rather than at
  2am. `packages/state` was made `Buffer`-free for exactly this reason.
- **Work that outlives the response.** The follow-up runs under `waitUntil`, so
  it must finish inside the platform's CPU limit. Reading three repos is well
  within it; a future command that walks every task in every repo might not be.
