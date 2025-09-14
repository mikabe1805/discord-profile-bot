import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

const commands = [
    new SlashCommandBuilder()
    .setName('profile_set')
    .setDescription('Set your bio')
    .addStringOption(o => o.setName('bio').setDescription('Your bio (up to ~1000 chars)').setMaxLength(1000).setRequired(true)),

    new SlashCommandBuilder()
    .setName('profile_image')
    .setDescription('Set or update your profile image')
    .addAttachmentOption(o => o.setName('image').setDescription('Your profile image').setRequired(true)),

    new SlashCommandBuilder()
    .setName('profile_showp')
    .setDescription('Show a profile privately')
    .addUserOption(o => o.setName('user').setDescription('User to view')),

    new SlashCommandBuilder()
    .setName('profile_showv')
    .setDescription('Show a profile publicly')
    .addUserOption(o => o.setName('user').setDescription('User to view')),

    new SlashCommandBuilder()
    .setName('findp')
    .setDescription('Find users by tag (private)')
    .addStringOption(o => o.setName('tag').setDescription('Tag to search').setAutocomplete(true).setRequired(true)),

    new SlashCommandBuilder()
    .setName('findv')
    .setDescription('Find users by tag (public)')
    .addStringOption(o => o.setName('tag').setDescription('Tag to search').setAutocomplete(true).setRequired(true)),

    new SlashCommandBuilder()
    .setName('config_get')
    .setDescription('Show bot config (mod-only)'),

    new SlashCommandBuilder()
    .setName('config_set')
    .setDescription('Set config (mod-only)')
    .addBooleanOption(o => o.setName('allow_ugc_tags').setDescription('Allow members to create new tags'))
    .addIntegerOption(o => o.setName('max_tags_per_user').setDescription('Limit tags per user (e.g., 30)')),

    new SlashCommandBuilder()
    .setName('theme_set')
    .setDescription('Set profile theme (mod-only)')
    .addStringOption(o => o.setName('theme').setDescription('Profile theme').setRequired(true)
        .addChoices({ name: '🌟 Default', value: 'default' }, { name: '🌸 Blossom', value: 'blossom' }, { name: '🌊 Ocean', value: 'ocean' }, { name: '🌇 Sunset', value: 'sunset' }, { name: '🌙 Midnight', value: 'midnight' })),

    new SlashCommandBuilder()
    .setName('theme_preview')
    .setDescription('Preview a profile theme')
    .addStringOption(o => o.setName('theme').setDescription('Theme to preview').setRequired(true)
        .addChoices({ name: '🌟 Default', value: 'default' }, { name: '🌸 Blossom', value: 'blossom' }, { name: '🌊 Ocean', value: 'ocean' }, { name: '🌇 Sunset', value: 'sunset' }, { name: '🌙 Midnight', value: 'midnight' })),


    new SlashCommandBuilder()
    .setName('profile_addtag')
    .setDescription('Add tag(s) to your profile')
    .addStringOption(o => o.setName('tags').setDescription('Tags to add (separate multiple with commas)').setAutocomplete(true).setRequired(true)),

    new SlashCommandBuilder()
    .setName('profile_removetag')
    .setDescription('Remove tag(s) from your profile')
    .addStringOption(o => o.setName('tags').setDescription('Tags to remove (separate multiple with commas)').setAutocomplete(true).setRequired(true)),

    new SlashCommandBuilder()
    .setName('tags_add')
    .setDescription('Add/update a dictionary tag (mod-only)')
    .addStringOption(o => o.setName('name').setDescription('slug e.g. pcb-design').setRequired(true))
    .addStringOption(o => o.setName('display').setDescription('Display name e.g. PCB Design').setRequired(true))
    .addStringOption(o => o.setName('category').setDescription('Tag category').setRequired(false)
        .addChoices({ name: '🏷️ General', value: 'general' }, { name: '⚡ Skills', value: 'skills' }, { name: '❤️ Interests', value: 'interests' }, { name: '🎯 Hobbies', value: 'hobbies' }, { name: '💼 Profession', value: 'profession' }, { name: '🎮 Gaming', value: 'gaming' }, { name: '🎨 Creative', value: 'creative' }, { name: '⚽ Sports', value: 'sports' }, { name: '🎵 Music', value: 'music' }, { name: '💻 Tech', value: 'tech' }, { name: '📚 Education', value: 'education' }, { name: '🌍 Languages', value: 'languages' })),

    new SlashCommandBuilder()
    .setName('tags_remove')
    .setDescription('Remove a dictionary tag (mod-only)')
    .addStringOption(o => o.setName('name').setDescription('slug to remove').setAutocomplete(true).setRequired(true)),

    new SlashCommandBuilder()
    .setName('tags_list')
    .setDescription('List all dictionary tags'),

    new SlashCommandBuilder()
    .setName('help')
    .setDescription('Get help with the bot')
    .addStringOption(o => o.setName('category').setDescription('Help category').setRequired(false)
        .addChoices({ name: '🚀 Getting Started', value: 'getting-started' }, { name: '👤 Profile Commands', value: 'profile' }, { name: '🏷️ Tag Commands', value: 'tags' }, { name: '🎨 Theme Commands', value: 'themes' }, { name: '⚙️ Admin Commands', value: 'admin' }, { name: '🔍 Search Commands', value: 'search' })),

    new SlashCommandBuilder()
    .setName('quickstart')
    .setDescription('Quick setup guide for new users'),

    new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Ping users with specific tags and create a discussion thread')
    .addStringOption(o => o.setName('tags').setDescription('Comma-separated tags to ping users for').setRequired(true).setAutocomplete(true))
    .addStringOption(o => o.setName('message').setDescription('Message to include with the ping').setRequired(false).setMaxLength(500))
    .addStringOption(o => o.setName('thread_name').setDescription('Name for the discussion thread').setRequired(false).setMaxLength(100)),

    new SlashCommandBuilder()
    .setName('profile_theme')
    .setDescription('Customize your personal profile theme and colors')
    .addStringOption(o => o.setName('theme').setDescription('Base theme to use').setRequired(false)
        .addChoices({ name: '🌟 Default', value: 'default' }, { name: '🌸 Blossom', value: 'blossom' }, { name: '🌊 Ocean', value: 'ocean' }, { name: '🌇 Sunset', value: 'sunset' }, { name: '🌙 Midnight', value: 'midnight' }, { name: '👤 User-based', value: 'user-based' }))
    .addStringOption(o => o.setName('primary_color').setDescription('Primary color (hex code, e.g., #FF5733)').setRequired(false))
    .addStringOption(o => o.setName('secondary_color').setDescription('Secondary color (hex code, e.g., #33FF57)').setRequired(false))
    .addStringOption(o => o.setName('title').setDescription('Custom profile title (e.g., "🌟 My Profile")').setRequired(false).setMaxLength(50))
    .addStringOption(o => o.setName('tags_emoji').setDescription('Custom emoji for tags section').setRequired(false).setMaxLength(10)),

    new SlashCommandBuilder()
    .setName('features_set')
    .setDescription('Configure bot features (moderator only)')
    .addBooleanOption(o => o.setName('ping_threads').setDescription('Allow users to create ping threads').setRequired(false))
    .addBooleanOption(o => o.setName('user_customization').setDescription('Allow users to customize their profiles').setRequired(false)),

    new SlashCommandBuilder()
    .setName('features_get')
    .setDescription('View current feature settings (moderator only)')
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

const mode = process.argv[2] || 'guild';

(async() => {
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