import 'dotenv/config';
import {
  Client, GatewayIntentBits, Partials,
  EmbedBuilder, InteractionType, PermissionFlagsBits
} from 'discord.js';

import {
  upsertGuild, upsertProfile, getProfile,
  listUserTags, addUserTag, removeUserTag,
  addGuildTag, removeGuildTag, listGuildTags,
  searchGuildTags, getUsersByTag
} from './db_firebase.js';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.GuildMember]
});

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on('guildCreate', async (guild) => {
  try { await upsertGuild(guild.id); } catch (e) { console.error('upsertGuild error', e); }
});

process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
});

client.on('interactionCreate', async (i) => {
  try {
    // -------- Autocomplete ----------
    if (i.type === InteractionType.ApplicationCommandAutocomplete) {
      const focused = i.options.getFocused(true);
      if (['tag', 'name'].includes(focused.name)) {
        const q = focused.value;
        const rows = await searchGuildTags(i.guildId, q, 25);
        const matches = rows.map(t => ({ name: t.display_name, value: t.tag_slug }));
        await i.respond(matches);
      }
      return;
    }

    if (!i.isChatInputCommand()) return;
    const name = i.commandName;

    // -------- profile_set -----------
    if (name === 'profile_set') {
      const bio = i.options.getString('bio', true);
      await i.deferReply({ ephemeral: true });
      await upsertProfile(i.guildId, i.user.id, bio);
      await i.editReply('Saved your bio.');
      return;
    }

    // -------- profile_view ----------
    if (name === 'profile_view') {
      const user = i.options.getUser('user') || i.user;
      const ephem = i.options.getBoolean('ephemeral') ?? true;
      await i.deferReply({ ephemeral: ephem });

      const prof = await getProfile(i.guildId, user.id);
      const tags = await listUserTags(i.guildId, user.id);

      const embed = new EmbedBuilder()
        .setAuthor({ name: `${user.username}`, iconURL: user.displayAvatarURL() })
        .setTitle('Profile')
        .setDescription((prof?.bio || '*No bio set.*').slice(0, 1000))
        .addFields({ name: 'Tags', value: tags.length ? tags.map(t => `\`${t.display_name}\``).join(', ') : '*None*' })
        .setFooter({ text: `User ID: ${user.id}` });

      await i.editReply({ embeds: [embed] });
      return;
    }

    // -------- profile_addtag --------
    if (name === 'profile_addtag') {
      const raw = i.options.getString('tag', true);
      const slug = normalizeTag(raw);
      await i.deferReply({ ephemeral: true });
      await addUserTag(i.guildId, i.user.id, slug);
      await i.editReply(`Added tag \`${slug}\`.`);
      return;
    }

    // -------- profile_removetag -----
    if (name === 'profile_removetag') {
      const raw = i.options.getString('tag', true);
      const slug = normalizeTag(raw);
      await i.deferReply({ ephemeral: true });
      await removeUserTag(i.guildId, i.user.id, slug);
      await i.editReply(`Removed tag \`${slug}\`.`);
      return;
    }

    // -------- find ------------------
    if (name === 'find') {
      const raw = i.options.getString('tag', true);
      const slug = normalizeTag(raw);
      await i.deferReply({ ephemeral: true });

      const users = (await getUsersByTag(i.guildId, slug, 5000, 0)).map(r => r.user_id);
      if (!users.length) {
        await i.editReply(`No users found with \`${slug}\`.`);
        return;
      }

      const mentions = users.map(id => `<@${id}>`);
      const chunks = chunk(mentions, 30);

      await i.editReply(`Found ${users.length} user(s) for \`${slug}\`.\n${chunks[0].join(' ')}`);
      for (let c = 1; c < chunks.length; c++) {
        await i.followUp({ content: chunks[c].join(' '), flags: 64 }); // 64 = EPHEMERAL
      }
      return;
    }

    // -------- tags_add --------------
    if (name === 'tags_add') {
      if (!isMod(i)) return i.reply({ content: 'Mod-only.', flags: 64 });
      const nameOpt = i.options.getString('name', true);
      const display = i.options.getString('display', true);
      await i.deferReply({ ephemeral: true });
      await addGuildTag(i.guildId, normalizeTag(nameOpt), display, i.user.id);
      await i.editReply(`Upserted tag \`${display}\` (\`${normalizeTag(nameOpt)}\`).`);
      return;
    }

    // -------- tags_remove -----------
    if (name === 'tags_remove') {
      if (!isMod(i)) return i.reply({ content: 'Mod-only.', flags: 64 });
      const nameOpt = i.options.getString('name', true);
      await i.deferReply({ ephemeral: true });
      await removeGuildTag(i.guildId, normalizeTag(nameOpt));
      await i.editReply(`Removed tag \`${normalizeTag(nameOpt)}\`.`);
      return;
    }

    // -------- tags_list -------------
    if (name === 'tags_list') {
      await i.deferReply({ ephemeral: true });
      const tags = await listGuildTags(i.guildId);
      const s = tags.length ? tags.map(t => `• ${t.display_name} (\`${t.tag_slug}\`)`).join('\n').slice(0, 1900) : '*None*';
      await i.editReply(s);
      return;
    }

  } catch (err) {
    console.error('interaction error:', err);
    if (i.isRepliable()) {
      try {
        if (!i.deferred && !i.replied) await i.deferReply({ ephemeral: true });
        await i.editReply('Error. Check bot logs for details.');
      } catch (_) {}
    }
  }
});

client.login(process.env.DISCORD_TOKEN);

// helpers
function normalizeTag(s) {
  return String(s).trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-_]/g, '');
}
function isMod(i) {
  return i.member?.permissions?.has(PermissionFlagsBits.ManageGuild);
}
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
