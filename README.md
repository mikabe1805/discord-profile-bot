# Bio

Bio is a small-server member directory for Discord. It helps people say a little about themselves, find others by shared interests, and choose before a new connection or group invitation happens.

The public surface is intentionally small:

- `/bio [picture]` opens your private Bio home. Upload your own PNG, JPEG, GIF, or WebP in the **Photo, vibe & title** panel, choose a general vibe, and give the card a title. The optional `picture` command field is a quicker upload path.
- `/view [member] [visible]` shows a Bio card. With no options, it posts your own card in the channel. Choose an opted-in member to show their card, or set `visible:false` to keep the result private.
- `/find [interest]` quietly finds opted-in members and server interests. It does not notify the people returned.
- `/connect [member] [message]` sends a private connection request, or opens your request list when no member is supplied. The recipient can accept, decline, or block it.
- `/invite <interests> <message>` previews a capped, opt-in group invitation before it notifies matching members.
- `/setup` is admin-only and opens the server setup panel. Its starter tags are reviewable suggestions: moderators see every tag in a group, select only the useful ones, and add them with an explicit confirmation.
- `/help` explains the flow in Discord.
- The member context menu provides **View Bio** and **Request connection**.

If a member does not have an aesthetic photo ready, **Preselected photos** opens six original photographs supplied by the bot owner: **Canopy**, **Still Water**, **Shoreline**, **Lantern Sky**, **Olive Dusk**, and **Hillside Weather**. They are backups and stay separate from the member's chosen vibe and title. Their source mapping is recorded in [`src/assets/profile-presets/SOURCES.md`](src/assets/profile-presets/SOURCES.md); Bio does not bundle generated or stock artwork.

Bio starts private. On first run, choose a reason to begin or choose “Just make my card,” write your card, add your photo, vibe, and title, and then choose a sharing preset: **Private for now**, **Open to hellos** (directory visibility and private requests), or **Open to groups** (also eligible for matching `/invite` messages). Interaction notes are optional and intentionally last in the Bio flow; they can be left blank and have their own visibility choice.

For a quick start, install [Bio to Discord](https://discord.com/oauth2/authorize?client_id=1416081968537538640&permissions=52224&scope=bot%20applications.commands). A server administrator can then run `/setup` to review starter tag suggestions, add custom interests, configure limits, member suggestions and group invites, and post the start card in a channel.

Profiles stay out of discovery until the member opts into directory visibility. A member can intentionally post their own card with `/view` without changing that setting; other members' cards can only be viewed after they opt in. Public cards omit interaction notes and sharing-status details. Search, previews, and ordinary replies suppress mentions. The bot stores its SQLite database and uploaded profile images under `DATA_DIR`; no image-hosting account is required.

## Local development

Use Node 22.12 or newer. Copy `.env.example` to `.env`, fill in the Discord values, then run:

```powershell
npm ci
npm test
npm run commands:guild
npm start
```

Guild command registration is the quickest feedback loop. Global registration is available with `npm run commands:global`, but Discord can take time to propagate global commands. Production startup (`npm run start:production`) registers the commands to both `GUILD_ID` when configured and the global application command route.

The checked-in `data/.gitkeep` preserves the directory while database files remain ignored. The old tip's tracked database and `node_modules` have been removed from the current branch; removing sensitive material from all earlier Git history is a separate history rewrite and is not part of a normal deploy.

## Production

Railway is the supported deployment target. Before the first deploy, attach a persistent Railway volume mounted at `/data`, set `DATA_DIR=/data`, and configure the required environment variables. A container filesystem is disposable; the volume is the part that keeps member data across deploys and restarts. See [DEPLOYMENT.md](DEPLOYMENT.md) for the exact runbook.
