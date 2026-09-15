# Deployment runbook

Railway is the supported production target. The bot uses native SQLite through `better-sqlite3`, so the service must run on Node 22.12 or newer and its data directory must be a persistent volume.

## Required Railway configuration

Use one service from this repository and attach one persistent volume at `/data`. Set:

```text
DISCORD_TOKEN=<bot token; secret>
CLIENT_ID=1416081968537538640
GUILD_ID=<server where commands should appear immediately>
DATA_DIR=/data
```

`CLIENT_ID` and `GUILD_ID` let `npm run start:production` refresh the command set after the gateway connects. When `GUILD_ID` is configured, startup registers both that guild's commands for immediate availability and the global application commands for general availability. The multi-stage `Dockerfile` uses Node 22, installs the native `better-sqlite3` dependency in an isolated build stage, and leaves Python and the C/C++ toolchain out of the runtime image. It does not declare Railway variables as build arguments. `.dockerignore` keeps local credentials and database files out of the uploaded build context. Keep the token in Railway's variable store; do not commit `.env` or print it in logs.

The repository's `.railway/railway.ts` preserves the production variables, declares the `/data` volume and one US East replica, selects the Dockerfile builder, and waits for the GitHub check suite. The container starts `npm run start:production`: startup runs migrations, connects the bot, then refreshes both the configured guild and global command sets. A command-registration outage is logged without taking the connected bot back down. The service should have one replica while it owns this SQLite file.

Enable **Server Members Intent** for Bio in the Discord Developer Portal. The bot uses it to discard a member's saved data when they leave the server; the current application is enabled for the limited, unverified-app form of that intent.

## First deploy and migration

1. In Railway, open the existing Bio service and verify the project/environment/service are the intended ones.
2. Export a copy of any existing `/app/data/bot.db` from the old service filesystem before attaching the volume. If SQLite WAL sidecars or `/app/data/profile-images` exist, export those too. Keep every copy outside Git.
3. Record the active region and replica count, then stop the active deployment after the backup so the worker cannot write during cutover. Confirm the service has zero running replicas. For a single-region service, do not rely on removing its region override as a scale-to-zero operation; Railway can fall back to one replica in its default region. Take a second database copy after the worker has stopped when Railway still permits access, and verify the copy with SQLite's integrity check.
4. Attach the volume at `/data`, set `DATA_DIR=/data`, and upload the backed-up database before restarting the worker. Railway CLI volume-file paths start at the volume root, so upload the database to `/bot.db`; it appears inside the service as `/data/bot.db`. Select the volume by its exact ID when using non-interactive file commands.
5. Produce one consistent SQLite snapshot before migration. If the source uses WAL, checkpoint it while stopped or use SQLite's backup API; copying only `bot.db` can omit committed WAL pages. Put the snapshot at `<staging-directory>/bot.db`, then point the migration command at that exact directory. In PowerShell, run `$env:DATA_DIR = '<staging-directory>'; npm run data:migrate`; in a POSIX shell, run `DATA_DIR='<staging-directory>' npm run data:migrate`. The command applies the same numbered migrations used at startup, writes a pre-migration backup, and reports aggregate row counts plus the SQLite integrity result. Legacy profiles and tags are retained, while profiles that never made an explicit visibility choice migrate hidden.
6. Deploy the release and restore one replica. Startup safely rechecks the numbered migrations.
7. Check the deploy logs for successful command registration, migrations, and `ready` status. Run `scripts/verify-data.js` against the mounted database if Railway shell access is available.

Do not deploy while the volume is absent and assume the local filesystem will survive. Railway volumes persist across deploys and restarts, but they are a separate resource that must be attached to the service first. A volume is also a single-service resource, so this bot should not be scaled to multiple replicas.

## Backups

Take a database backup before schema changes, before restoring an old copy, and before any rollback. A safe backup is a byte-for-byte copy of `/data/bot.db` made while the service is stopped or quiesced. Keep several dated copies outside the repository. Also back up `/data/profile-images` when it contains member uploads.

For a one-time restore into a completely empty volume, `BOOTSTRAP_DB_GZIP_BASE64` may contain a gzip-compressed, base64-encoded SQLite database. Startup validates its SQLite header and integrity before installing it. It is ignored whenever `/data/bot.db` already exists, so it cannot replace live data. Remove the variable after the first verified start.

After a deploy, verify both `PRAGMA integrity_check` and the expected database file size. A successful process start alone does not prove that member data is present.

## Rollback

First use Railway's dashboard deployment history to restore the last known-good commit, or deploy a checkout of that commit with the CLI. Railway CLI 5.54 cannot select an arbitrary historical deployment with `deployment redeploy`. Keep the current volume attached and do not replace the database during a code-only rollback. If a migration has already changed the schema, restore the pre-deploy database backup only after stopping the service and preserving the current copy. With the CLI, upload that copy to the volume-root path `/bot.db`. Then deploy the compatible commit, restore one replica, and inspect logs before allowing normal use.

## Logs and smoke checks

Look for: process start, migration completion, both guild and global command registration, Discord `ready`, and the absence of repeated reconnect or database errors. In Discord, check `/help`, run `/bio`, complete the first-run flow, confirm the card stays private until a sharing preset is chosen, try a built-in mood photo and optional `/bio picture`, search with `/find` from a second account, use **View Bio**, send one `/connect` request or use **Request connection**, and verify the recipient can accept or decline it. With a small test group, preview and send one `/invite` using opted-in members, then confirm the notification and mention behavior. Confirm `/setup` is unavailable to a member without server-management permission and that an administrator can post the start card.

Discord account, DM delivery, permission, and notification behavior still need an owner-operated smoke test in the actual server. CI and Railway logs cannot certify those interactions.
