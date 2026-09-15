import test from 'node:test';
import assert from 'node:assert/strict';
import { ApplicationCommandOptionType, ApplicationCommandType, PermissionFlagsBits } from 'discord.js';
import { commandBuilders, commandData } from '../src/commands.js';

const byName = (name) => commandData.find((command) => command.name === name);
const option = (command, name) => command.options.find((item) => item.name === name);

test('the streamlined command surface serializes and contains seven slash commands plus two member actions', () => {
    assert.equal(commandBuilders.length, 9);
    assert.doesNotThrow(() => commandBuilders.map((command) => command.toJSON()));

    const keys = commandData.map((command) => `${command.type ?? ApplicationCommandType.ChatInput}:${command.name}`);
    assert.equal(new Set(keys).size, keys.length);
    assert.deepEqual(
        commandData.filter((command) => (command.type ?? ApplicationCommandType.ChatInput) === ApplicationCommandType.ChatInput).map((command) => command.name),
        ['bio', 'view', 'find', 'connect', 'invite', 'setup', 'help']
    );
});

test('the old multi-root command surface is gone', () => {
    const names = commandData.map((command) => command.name);
    for (const oldName of [
        'profile', 'discover', 'gather', 'boundaries', 'tags', 'settings',
        'View profile', 'Connect',
        'profile_set', 'profile_image', 'profile_showp', 'profile_showv',
        'findp', 'findv', 'config_get', 'config_set', 'quickstart', 'ping', 'db_info'
    ]) {
        assert.equal(names.includes(oldName), false, oldName);
    }
});

test('bio makes the optional personal picture upload discoverable', () => {
    const picture = option(byName('bio'), 'picture');
    assert.equal(picture.required, false);
    assert.equal(picture.description, 'Upload your own profile photo (PNG, JPEG, GIF, or WebP)');
});

test('view defaults to a public self card and offers optional member and visibility inputs', () => {
    const view = byName('view');
    const member = option(view, 'member');
    const visible = option(view, 'visible');
    assert.equal(view.dm_permission, false);
    assert.equal(member.type, ApplicationCommandOptionType.User);
    assert.equal(member.required, false);
    assert.equal(visible.type, ApplicationCommandOptionType.Boolean);
    assert.equal(visible.required, false);
    assert.match(visible.description, /defaults to true/i);
});

test('find, connect, and invite expose the short direct inputs', () => {
    assert.equal(option(byName('find'), 'interest').autocomplete, true);
    assert.equal(option(byName('find'), 'interest').required, false);

    assert.equal(option(byName('connect'), 'member').required, false);
    assert.equal(option(byName('connect'), 'message').required, false);
    assert.equal(option(byName('connect'), 'message').max_length, 500);

    assert.equal(option(byName('invite'), 'interests').autocomplete, true);
    assert.equal(option(byName('invite'), 'interests').required, true);
    assert.equal(option(byName('invite'), 'message').required, true);
    assert.equal(option(byName('invite'), 'message').max_length, 500);
});

test('setup is restricted to members who can manage the server', () => {
    assert.equal(byName('setup').default_member_permissions, String(PermissionFlagsBits.ManageGuild));
    assert.deepEqual(byName('help').options ?? [], []);
});

test('context commands are renamed guild-only user commands', () => {
    for (const name of ['View Bio', 'Request connection']) {
        const command = byName(name);
        assert.equal(command.type, ApplicationCommandType.User);
        assert.equal(command.dm_permission, false);
    }
});
