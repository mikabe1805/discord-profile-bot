# Bio

Bio is a small-server member directory for Discord. It helps people say a little about themselves, find others by shared interests, and make a clear choice before a new connection or group mention happens.

The current product surface is intentionally small:

- `/profile` edits, views, shares, preferences, interests, images, and deletion.
- `/discover` finds opted-in people or interests without sending notifications.
- `/connect` sends private, consent-based requests with accept, decline, and block actions.
- `/gather` sends a capped, opt-in group invitation around selected interests.
- `/boundaries` stores interaction preferences and privacy choices.
- `/tags`, `/settings`, and `/help` support moderation and setup.
- `View profile` and `Connect` are available from a member's context menu.

Profiles are private until the member opts into directory visibility. Search and ordinary replies suppress mentions. The bot stores its SQLite database and uploaded profile images under `DATA_DIR`; no image-hosting account is required.

## Local development

Use Node 22.12 or newer. Copy `.env.example` to `.env`, fill in the Discord values, then run:

```powershell
npm ci
npm test
npm run commands:guild
npm start
```

Guild command registration is the quickest feedback loop. Global registration is available with `npm run commands:global`, but Discord can take time to propagate global commands.

The checked-in `data/.gitkeep` preserves the directory while database files remain ignored. The old tip's tracked database and `node_modules` have been removed from the current branch; removing sensitive material from all earlier Git history is a separate history rewrite and is not part of a normal deploy.

## Production

Railway is the supported deployment target. Before the first deploy, attach a persistent Railway volume mounted at `/data`, set `DATA_DIR=/data`, and configure the required environment variables. A container filesystem is disposable; the volume is the part that keeps member data across deploys and restarts. See [DEPLOYMENT.md](DEPLOYMENT.md) for the exact runbook.
