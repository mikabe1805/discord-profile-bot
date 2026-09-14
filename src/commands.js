import {
    PermissionFlagsBits,
    SlashCommandBuilder,
    ContextMenuCommandBuilder,
    ApplicationCommandType
} from 'discord.js';

const manageGuild = PermissionFlagsBits.ManageGuild;

const interestsOption = (option, description) => option
    .setDescription(description)
    .setMaxLength(1000)
    .setAutocomplete(true)
    .setRequired(true);

const commandBuilders = [
    new SlashCommandBuilder()
        .setName('profile')
        .setDescription('Create and manage your profile')
        .addSubcommand((subcommand) => subcommand
            .setName('edit')
            .setDescription('Update your profile'))
        .addSubcommand((subcommand) => subcommand
            .setName('view')
            .setDescription('View a profile')
            .addUserOption((option) => option.setName('user').setDescription('The person to view')))
        .addSubcommand((subcommand) => subcommand
            .setName('share')
            .setDescription('Share your profile'))
        .addSubcommand((subcommand) => subcommand
            .setName('preferences')
            .setDescription('Choose how your profile is shared')
            .addBooleanOption((option) => option.setName('directory').setDescription('List me in the server directory'))
            .addBooleanOption((option) => option.setName('requests').setDescription('Allow connection requests'))
            .addBooleanOption((option) => option.setName('group_pings').setDescription('Allow group interest pings')))
        .addSubcommand((subcommand) => subcommand
            .setName('delete')
            .setDescription('Delete your profile'))
        .addSubcommandGroup((group) => group
            .setName('interests')
            .setDescription('Manage the interests on your profile')
            .addSubcommand((subcommand) => subcommand
                .setName('add')
                .setDescription('Add interests to your profile')
                .addStringOption((option) => interestsOption(option.setName('tags'), 'Interests to add, separated by commas')))
            .addSubcommand((subcommand) => subcommand
                .setName('remove')
                .setDescription('Remove interests from your profile')
                .addStringOption((option) => option
                    .setName('tags')
                    .setDescription('Interests to remove, separated by commas')
                    .setAutocomplete(true)
                    .setRequired(true)))
            .addSubcommand((subcommand) => subcommand
                .setName('list')
                .setDescription('List the interests on your profile')))
        .addSubcommandGroup((group) => group
            .setName('image')
            .setDescription('Manage your profile image')
            .addSubcommand((subcommand) => subcommand
                .setName('set')
                .setDescription('Use an image instead of your Discord avatar')
                .addAttachmentOption((option) => option
                    .setName('image')
                    .setDescription('A PNG, JPEG, GIF, or WebP image up to 5 MB')
                    .setRequired(true)))
            .addSubcommand((subcommand) => subcommand
                .setName('remove')
                .setDescription('Return to your Discord avatar'))),

    new SlashCommandBuilder()
        .setName('discover')
        .setDescription('Find people and shared interests')
        .addSubcommand((subcommand) => subcommand
            .setName('people')
            .setDescription('Find people by interest')
            .addStringOption((option) => option
                .setName('interest')
                .setDescription('An interest to look for')
                .setAutocomplete(true)))
        .addSubcommand((subcommand) => subcommand
            .setName('interests')
            .setDescription('Browse server interests')),

    new SlashCommandBuilder()
        .setName('connect')
        .setDescription('Manage connections with other members')
        .addSubcommand((subcommand) => subcommand
            .setName('request')
            .setDescription('Send a connection request')
            .addUserOption((option) => option.setName('user').setDescription('The person to connect with').setRequired(true))
            .addStringOption((option) => option.setName('message').setDescription('A short note').setMaxLength(500)))
        .addSubcommand((subcommand) => subcommand.setName('inbox').setDescription('View incoming requests'))
        .addSubcommand((subcommand) => subcommand.setName('sent').setDescription('View sent requests'))
        .addSubcommand((subcommand) => subcommand
            .setName('block')
            .setDescription('Block a member')
            .addUserOption((option) => option.setName('user').setDescription('The person to block').setRequired(true)))
        .addSubcommand((subcommand) => subcommand
            .setName('unblock')
            .setDescription('Unblock a member')
            .addUserOption((option) => option.setName('user').setDescription('The person to unblock').setRequired(true))),

    new SlashCommandBuilder()
        .setName('gather')
        .setDescription('Invite people with a shared interest to talk')
        .addStringOption((option) => interestsOption(option.setName('interests'), 'Interests to gather around, separated by commas'))
        .addStringOption((option) => option
            .setName('message')
            .setDescription('A short invitation')
            .setMaxLength(500)
            .setRequired(true)),

    new SlashCommandBuilder()
        .setName('boundaries')
        .setDescription('Manage your boundaries')
        .addSubcommand((subcommand) => subcommand.setName('edit').setDescription('Edit your boundaries'))
        .addSubcommand((subcommand) => subcommand
            .setName('view')
            .setDescription('View a member’s boundaries')
            .addUserOption((option) => option.setName('user').setDescription('The person to view')))
        .addSubcommand((subcommand) => subcommand
            .setName('privacy')
            .setDescription('Choose who can view your boundaries')
            .addStringOption((option) => option
                .setName('visibility')
                .setDescription('Who can view them')
                .setRequired(true)
                .addChoices(
                    { name: 'Private', value: 'private' },
                    { name: 'Server members', value: 'members' },
                    { name: 'A role', value: 'role' }
                ))
            .addRoleOption((option) => option.setName('role').setDescription('The role that can view them')))
        .addSubcommand((subcommand) => subcommand.setName('remove').setDescription('Remove your boundaries')),

    new SlashCommandBuilder()
        .setName('tags')
        .setDescription('Manage the server interest dictionary')
        .setDefaultMemberPermissions(manageGuild)
        .addSubcommand((subcommand) => subcommand
            .setName('add')
            .setDescription('Add an interest to the dictionary')
            .addStringOption((option) => option.setName('name').setDescription('The interest name').setMaxLength(64).setRequired(true))
            .addStringOption((option) => option.setName('display').setDescription('The name members will see').setMaxLength(80).setRequired(true))
            .addStringOption((option) => option.setName('category').setDescription('The interest category').setMaxLength(32)))
        .addSubcommand((subcommand) => subcommand
            .setName('remove')
            .setDescription('Remove an interest from the dictionary')
            .addStringOption((option) => option.setName('name').setDescription('The interest to remove').setAutocomplete(true).setRequired(true))),

    new SlashCommandBuilder()
        .setName('settings')
        .setDescription('Manage server settings')
        .setDefaultMemberPermissions(manageGuild)
        .addSubcommand((subcommand) => subcommand.setName('view').setDescription('View server settings'))
        .addSubcommand((subcommand) => subcommand
            .setName('update')
            .setDescription('Update server settings')
            .addBooleanOption((option) => option.setName('allow_member_tags').setDescription('Let members suggest interests'))
            .addIntegerOption((option) => option
                .setName('max_interests')
                .setDescription('Maximum interests per profile')
                .setMinValue(1)
                .setMaxValue(30))
            .addBooleanOption((option) => option.setName('allow_gathers').setDescription('Allow group interest calls'))),

    new SlashCommandBuilder()
        .setName('help')
        .setDescription('Learn how to use the bot'),

    new ContextMenuCommandBuilder()
        .setName('View profile')
        .setType(ApplicationCommandType.User)
        .setDMPermission(false),
    new ContextMenuCommandBuilder()
        .setName('Connect')
        .setType(ApplicationCommandType.User)
        .setDMPermission(false)
];

for (const command of commandBuilders) command.setDMPermission(false);

const commandData = commandBuilders.map((command) => command.toJSON());

export { commandBuilders, commandData };
