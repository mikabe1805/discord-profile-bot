# Deployment runbook

Railway is the supported production target. The bot uses native SQLite through `better-sqlite3`, so the service must run on Node 22.12 or newer and its data directory must be a persistent volume.

## Required Railway configuration

Use one service from this repository and attach one persistent volume at `/data`. Set:

```text
DISCORD_TOKEN=<bot token; secret>
CLIENT_ID=1416081968537538640
GUILD_ID=<server where commands should appear immediately>
DATA_DIR=/data
NODE_VERSION=22.12.0
```

`CLIENT_ID` and `GUILD_ID` let `npm run start:production` refresh the guild command set after the gateway connects. Keep the token in Railway's variable store; do not commit `.env` or print it in logs.

The repository's `railway.json` starts `npm run start:production`. Startup runs migrations, connects the bot, then refreshes the guild command set. A command-registration outage is logged without taking the connected bot back down. The service should have one replica while it owns this SQLite file.

Enable **Server Members Intent** for Bio in the Discord Developer Portal. The bot uses it to discard a member's saved data when they leave the server; the current application is enabled for the limited, unverified-app form of that intent.

## First deploy and migration

1. In Railway, open the existing Bio service and verify the project/environment/service are the intended ones.
2. Export a copy of any existing `/app/data/bot.db` from the old service filesystem before attaching the volume. Keep that copy outside Git.
3. Scale the worker to zero so it cannot write between the backup and cutover.
4. Attach the volume at `/data`, set `DATA_DIR=/data`, and upload the backed-up database as `/data/bot.db` before restarting the worker.
5. Deploy the release and restore one replica. Startup applies numbered migrations; legacy profiles and tags are retained, while profiles that never made an explicit visibility choice migrate hidden.
6. Check the deploy logs for successful command registration, migrations, and `ready` status. Run `scripts/verify-data.js` against the mounted database if Railway shell access is available.

Do not deploy while the volume is absent and assume the local filesystem will survive. Railway volumes persist across deploys and restarts, but they are a separate resource that must be attached to the service first. A volume is also a single-service resource, so this bot should not be scaled to multiple replicas.

## Backups

Take a database backup before schema changes, before restoring an old copy, and before any rollback. A safe backup is a byte-for-byte copy of `/data/bot.db` made while the service is stopped or quiesced. Keep several dated copies outside the repository. Also back up `/data/profile-images` when it contains member uploads.

After a deploy, verify both `PRAGMA integrity_check` and the expected database file size. A successful process start alone does not prove that member data is present.

## Rollback

First use Railway's deployment history to redeploy the last known-good commit. Keep the current volume attached and do not replace the database during a code-only rollback. If a migration has already changed the schema, restore the pre-deploy database backup only after stopping the service and preserving the current copy. Then redeploy the compatible commit and inspect logs before allowing normal use.

## Logs and smoke checks

Look for: process start, migration completion, command registration, Discord `ready`, and the absence of repeated reconnect or database errors. In Discord, check `/help`, create a test profile, confirm it stays hidden until enabled, search from a second account, send one connection request, and verify the recipient can accept or decline it. Test `/gather` only with a small opt-in group; it is capped and uses explicit user mentions.

Discord account, DM delivery, permission, and notification behavior still need an owner-operated smoke test in the actual server. CI and Railway logs cannot certify those interactions.
