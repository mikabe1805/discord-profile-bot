import {
    PermissionFlagsBits,
    SlashCommandBuilder,
    ContextMenuCommandBuilder,
    ApplicationCommandType
} from 'discord.js';

const manageGuild = PermissionFlagsBits.ManageGuild;

const commandBuilders = [
    new SlashCommandBuilder()
        .setName('bio')
        .setDescription('Open your Bio and make it your own')
        .addAttachmentOption((option) => option
            .setName('picture')
            .setDescription('Upload your own profile photo (PNG, JPEG, GIF, or WebP)')),

    new SlashCommandBuilder()
        .setName('find')
        .setDescription('Find people by a shared interest')
        .addStringOption((option) => option
            .setName('interest')
            .setDescription('An interest to look for')
            .setAutocomplete(true)),

    new SlashCommandBuilder()
        .setName('connect')
        .setDescription('Request a connection or view your requests')
        .addUserOption((option) => option
            .setName('member')
            .setDescription('The person to connect with'))
        .addStringOption((option) => option
            .setName('message')
            .setDescription('An optional note')
            .setMaxLength(500)),

    new SlashCommandBuilder()
        .setName('invite')
        .setDescription('Invite interested people to a small conversation')
        .addStringOption((option) => option
            .setName('interests')
            .setDescription('Interests to invite, separated by commas')
            .setAutocomplete(true)
            .setRequired(true))
        .addStringOption((option) => option
            .setName('message')
            .setDescription('Your invitation')
            .setMaxLength(500)
            .setRequired(true)),

    new SlashCommandBuilder()
        .setName('setup')
        .setDescription('Set up Bio for this server')
        .setDefaultMemberPermissions(manageGuild),

    new SlashCommandBuilder()
        .setName('help')
        .setDescription('Learn how Bio works'),

    new ContextMenuCommandBuilder()
        .setName('View Bio')
        .setType(ApplicationCommandType.User)
        .setDMPermission(false),
    new ContextMenuCommandBuilder()
        .setName('Request connection')
        .setType(ApplicationCommandType.User)
        .setDMPermission(false)
];

for (const command of commandBuilders) command.setDMPermission(false);

const commandData = commandBuilders.map((command) => command.toJSON());

export { commandBuilders, commandData };
