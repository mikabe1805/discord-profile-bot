import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

const commands = [
  new SlashCommandBuilder()
    .setName('profile_set')
    .setDescription('Set your bio')
    .addStringOption(o => o.setName('bio').setDescription('Your bio (up to ~1000 chars)').setMaxLength(1000).setRequired(true)),

  new SlashCommandBuilder()
    .setName('profile_view')
    .setDescription('View a profile')
    .addUserOption(o => o.setName('user').setDescription('User to view'))
    .addBooleanOption(o => o.setName('ephemeral').setDescription('Show privately (default true)')),

  new SlashCommandBuilder()
    .setName('profile_addtag')
    .setDescription('Add a tag to your profile')
    .addStringOption(o => o.setName('tag').setDescription('Tag to add').setAutocomplete(true).setRequired(true)),

  new SlashCommandBuilder()
    .setName('profile_removetag')
    .setDescription('Remove a tag from your profile')
    .addStringOption(o => o.setName('tag').setDescription('Tag to remove').setAutocomplete(true).setRequired(true)),

  new SlashCommandBuilder()
    .setName('find')
    .setDescription('Find users by tag')
    .addStringOption(o => o.setName('tag').setDescription('Tag to search').setAutocomplete(true).setRequired(true)),

  new SlashCommandBuilder()
    .setName('tags_add')
    .setDescription('Add/update a dictionary tag (mod-only)')
    .addStringOption(o => o.setName('name').setDescription('slug e.g. pcb-design').setRequired(true))
    .addStringOption(o => o.setName('display').setDescription('Display name e.g. PCB Design').setRequired(true)),

  new SlashCommandBuilder()
    .setName('tags_remove')
    .setDescription('Remove a dictionary tag (mod-only)')
    .addStringOption(o => o.setName('name').setDescription('slug to remove').setAutocomplete(true).setRequired(true)),

  new SlashCommandBuilder()
    .setName('tags_list')
    .setDescription('List all dictionary tags')
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

const mode = process.argv[2] || 'guild';

(async () => {
  try {
    if (mode === 'guild') {
      await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });
      console.log('Guild commands registered.');
    } else {
      await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
      console.log('Global commands registered.');
    }
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
