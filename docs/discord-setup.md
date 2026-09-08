# Discord setup — the parts only you can do

Everything here needs your browser and your accounts. None of it can be
automated, and none of it should be done twice, so it is written as a checklist.

Set aside about twenty minutes.

---

## Before you start: the bootstrap problem

The Discord bot (`t-002`) is what makes tasks claimable. It therefore **cannot
be claimed through the system it builds** — and neither can `t-001`, which it
depends on. Both have to be built outside the loop, by hand.

That is a one-time cost. Once the bot is running, `t-003` onwards and everything
in the sibling project repos go through `/task` normally. Do not wait for the
routine to hand you `t-002`; it never will.

---

## 1. The server

1. Create a Discord server (or pick an existing one you control).
2. Create three text channels:
   - `#start` — where `/task` is run and the daily report lands
   - `#code` — claim threads open here
   - `#merged` — merge announcements
3. Turn on Developer Mode: **User Settings → Advanced → Developer Mode**.
   You need it to copy IDs. Right-click anything → *Copy ID*.
4. Right-click the **server name** → *Copy Server ID*. That is the guild id.
5. Right-click each of the three channels → *Copy Channel ID*.

## 2. The application and bot

1. Go to https://discord.com/developers/applications → **New Application**.
2. Copy the **Application ID** from the General Information page.
3. **Bot** tab → **Reset Token** → copy it. It is shown exactly once; if you
   lose it, reset again.
4. **Leave every Privileged Gateway Intent off.** In particular do *not* enable
   Message Content Intent — slash commands do not need it, and enabling it drags
   you into Discord's verification process for no benefit.
5. Invite the bot. Either build the URL under **OAuth2 → URL Generator**, or use
   this directly with your Application ID substituted in:

   ```
   https://discord.com/api/oauth2/authorize?client_id=YOUR_APPLICATION_ID&scope=bot%20applications.commands&permissions=309237713920
   ```

   Scopes: `bot` and `applications.commands`.
   Permissions (`309237713920`): View Channels, Send Messages, Read Message
   History, Create Public Threads, Send Messages in Threads. Nothing more — the
   bot never needs to kick, ban, manage messages, or read message content.

## 3. The GitHub token

The bot writes `state/claims.json` through the GitHub API, so it needs its own
fine-grained PAT. This is separate from the routines' access — routines use the
Claude GitHub App, the bot uses this token.

1. https://github.com/settings/personal-access-tokens/new
2. **Repository access → Only select repositories**, and select all three:
   `darwin-model`, `wildplaces`, `nostia-landing-redesign`.
3. **Repository permissions:**
   - Contents: **Read and write**
   - Issues: **Read and write**
   - Metadata: Read-only (granted automatically)
   - Everything else: No access
4. Set an expiry you will actually notice — 90 days is reasonable. Put a
   reminder somewhere, because the bot dies silently when it lapses.

## 4. Your own Discord id

Already recorded in `state/users.json`: `779050350534590475`.

For each additional person, right-click them in the member list → *Copy User ID*,
and add them with their GitHub login. Five maximum — that limit is enforced by
`state/schema/users.json`, deliberately.

---

## Where the values go

Copy `.env.example` to `.env` and fill it in. `.env` is gitignored.

**Do not paste the bot token or the PAT into a chat, an issue, a commit, or a
routine prompt.** Chat transcripts and git history both persist, and a leaked
bot token lets anyone act as your bot in your server. If one does leak: reset it
in the Developer Portal (bot) or revoke it in GitHub settings (PAT). Resetting
is cheap; cleaning up after a leak is not.

For deployment (`P8`) these move into Azure Key Vault and nothing lives on disk.

---

## Checklist

Collect these six values before the bot can run:

- [ ] `DISCORD_TOKEN` — Bot tab, shown once
- [ ] `DISCORD_APPLICATION_ID` — General Information
- [ ] `DISCORD_GUILD_ID` — right-click server name
- [ ] `DISCORD_CHANNEL_START` / `_CODE` / `_MERGED` — right-click each channel
- [ ] `GITHUB_TOKEN` — the fine-grained PAT
- [ ] Bot visible in the member list of your server

---

## One design decision still open

The original plan assumed **one** project repo. There are now three
(`darwin-model`, `wildplaces`, `nostia-landing-redesign`), so `/task` has to
know which task table to read from. That is not yet settled, and it changes
`t-002`'s contract.

The realistic options:

1. **`/task project:<name>`** — an explicit required choice on the command.
   Unambiguous, works with the `#start`/`#code`/`#merged` channel layout as it
   stands, and `/board` can show all three at once.
2. **Channel-per-project** — the bot infers the project from where the command
   was run. Less typing, but it means restructuring the channels around projects
   rather than lifecycle.
3. **One bot process per repo** — simplest code, three tokens, three deploys,
   and `/board` can never show you everything at once.

Option 1 is the recommendation: least structural change, and the only one where
a single `/board` answers "what is there to do".
