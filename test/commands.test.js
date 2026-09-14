import test from 'node:test';
import assert from 'node:assert/strict';
import { ApplicationCommandType, PermissionFlagsBits } from 'discord.js';
import { commandBuilders, commandData } from '../src/commands.js';

const byName = (name) => commandData.find((command) => command.name === name);
const subcommand = (command, name) => command.options.find((option) => option.name === name);
const option = (command, name) => command.options.find((item) => item.name === name);

test('the complete command surface serializes and contains ten builders', () => {
    assert.equal(commandBuilders.length, 10);
    assert.doesNotThrow(() => commandBuilders.map((command) => command.toJSON()));

    const keys = commandData.map((command) => `${command.type ?? ApplicationCommandType.ChatInput}:${command.name}`);
    assert.equal(new Set(keys).size, keys.length);
});

test('legacy cryptic command names are gone', () => {
    const names = commandData.map((command) => command.name);
    for (const legacy of ['profile_set', 'profile_image', 'profile_showp', 'profile_showv', 'findp', 'findv', 'config_get', 'config_set', 'quickstart', 'ping', 'db_info']) {
        assert.equal(names.includes(legacy), false, legacy);
    }
});

test('profile, discovery, connection, and gathering commands expose the intended options', () => {
    assert.deepEqual(byName('profile').options.map((item) => item.name), ['edit', 'view', 'share', 'preferences', 'delete', 'interests', 'image']);
    assert.deepEqual(subcommand(byName('profile'), 'preferences').options.map((item) => item.name), ['directory', 'requests', 'group_pings']);
    const interests = subcommand(byName('profile'), 'interests');
    assert.deepEqual(interests.options.map((item) => item.name), ['add', 'remove', 'list']);
    assert.equal(option(subcommand(interests, 'add'), 'tags').autocomplete, true);
    const image = subcommand(byName('profile'), 'image');
    assert.deepEqual(image.options.map((item) => item.name), ['set', 'remove']);
    assert.deepEqual(byName('discover').options.map((item) => item.name), ['people', 'interests']);
    assert.deepEqual(byName('connect').options.map((item) => item.name), ['request', 'inbox', 'sent', 'block', 'unblock']);
    assert.equal(option(subcommand(byName('connect'), 'request'), 'message').max_length, 500);
    assert.equal(option(byName('gather'), 'interests').autocomplete, true);
    assert.equal(option(byName('gather'), 'interests').required, true);
    assert.equal(option(byName('gather'), 'message').required, true);
    assert.equal(option(byName('gather'), 'message').max_length, 500);
});

test('boundaries and admin settings enforce their constraints', () => {
    const boundaries = byName('boundaries');
    assert.deepEqual(boundaries.options.map((item) => item.name), ['edit', 'view', 'privacy', 'remove']);
    assert.deepEqual(option(subcommand(boundaries, 'privacy'), 'visibility').choices.map((choice) => choice.value), ['private', 'members', 'role']);

    for (const name of ['tags', 'settings']) {
        assert.equal(byName(name).default_member_permissions, String(PermissionFlagsBits.ManageGuild));
    }
    const update = subcommand(byName('settings'), 'update');
    assert.equal(option(update, 'max_interests').min_value, 1);
    assert.equal(option(update, 'max_interests').max_value, 30);
});

test('context commands are guild-only user commands', () => {
    for (const name of ['View profile', 'Connect']) {
        const command = byName(name);
        assert.equal(command.type, ApplicationCommandType.User);
        assert.equal(command.dm_permission, false);
    }
});
