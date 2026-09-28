# Bio

Bio is a small-server member directory for Discord. It helps people say a little about themselves, find others by shared interests, and choose before a new connection or group invitation happens.

The public surface is intentionally small:

- `/bio [picture]` opens your private Bio home. Upload your own PNG, JPEG, GIF, or WebP in the **Photo, vibe & title** panel, choose a general vibe, and give the card a title. The optional `picture` command field is a quicker upload path.
- `/view [member] [visible]` shows a Bio card. With no options, it posts your own card in the channel. Choose an opted-in member to show their card, or set `visible:false` to keep the result private.
- `/find [interest]` quietly finds opted-in members and server interests. It does not notify the people returned.
- `/connect [member] [message]` sends a private connection request, or opens your request list when no member is supplied. The recipient can accept, decline, or block it.
- `/invite <interests> <message> [activity] [when]` previews a capped, opt-in group invitation before it notifies matching members. Invitees can RSVP in the channel; the host can open a private conversation for the people who chose **I’m in**.
- `/setup` is admin-only and opens the server setup panel. It can create or select a public Bio channel, configure the directory and group invites, and review starter tags before adding them.
- `/help` explains the flow in Discord.
- The member context menu provides **View Bio** and **Request connection**.

If a member does not have an aesthetic photo ready, **Preselected photos** opens six original photographs supplied by the bot owner: **Canopy**, **Still Water**, **Shoreline**, **Lantern Sky**, **Olive Dusk**, and **Hillside Weather**. They are backups and stay separate from the member's chosen vibe and title. Their source mapping is recorded in [`src/assets/profile-presets/SOURCES.md`](src/assets/profile-presets/SOURCES.md); Bio does not bundle generated or stock artwork.

Bio starts private. The first screen offers **Start with one line**, a required answer to “What could someone talk to you about?” Members can add a short bio, interests, photo, vibe, and title later. **Open full editor** remains available for people who want to write everything now. Interaction notes are optional and intentionally last in the Bio flow; they can be left blank and have their own visibility choice.

## Public Bio channel

Run `/setup` in the channel where you want the welcome card, then choose **Create Bio channel** to make `#member-bios`, or **Use this channel** to use the current regular text channel. Bio posts a small welcome card there so people have a visible way back into the flow.

A member’s card only appears after they choose **Publish & open to hellos** or **Publish & open to groups**, or turn on **Show in Bio channel** in **Sharing**. This also requires directory visibility, so members always make an explicit decision before a public card exists. Existing directory profiles do not get published just because an administrator enables the channel.

Bio keeps one card per opted-in member. Changing their Bio, photo, vibe, title, or sharing choice updates that same message. Turning off **Show in Bio channel**, choosing **Private for now**, deleting the profile, or leaving the server removes the card. **Turn off Bio channel** removes Bio’s public cards, clears their publishing choices, and leaves the Discord channel itself for the server to keep or repurpose. If a moderator enables a Bio channel again, members choose to publish again.

For a quick start, install [Bio to Discord](https://discord.com/oauth2/authorize?client_id=1416081968537538640&permissions=360777370640&scope=bot%20applications.commands). A server administrator can then run `/setup` to review starter tag suggestions, add custom interests, configure limits, member suggestions and group invites, post the start card, and enable the Bio channel.

Profiles stay out of discovery until the member opts into directory visibility. A member can intentionally post their own card with `/view` without changing that setting; other members' cards can only be viewed after they opt in. Public Bio-channel cards omit interaction notes and sharing-status details. Search, previews, and ordinary replies suppress mentions. The bot stores its SQLite database and uploaded profile images under `DATA_DIR`; no image-hosting account is required.

## Server owner checklist

1. Run `/setup`, choose only the interests that fit the server, and post the welcome card where new members will see it.
2. Enable a Bio channel only if a visible, member-controlled directory fits the community. Keep its topic and permissions clear: it is for bot-managed Bio cards, not discussion.
3. Give the bot **View Channel**, **Send Messages**, **Embed Links**, **Attach Files**, and **Read Message History** in channels where it posts or updates cards. **Create Bio channel** additionally needs **Manage Channels**. RSVP conversations need **Create Private Threads**, **Send Messages in Threads**, and **Manage Threads** in the invite channel.
4. When there is a real reason to meet people, choose **Post Bio prompt** in `/setup`. Write one question, and Bio posts it to the configured Bio channel with **Make or update my Bio** and **Find people** buttons. Members can update their cards at any time from that prompt, the welcome card, or `/bio`.

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
