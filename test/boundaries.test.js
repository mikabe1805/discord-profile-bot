import test from 'node:test';
import assert from 'node:assert/strict';
import { createBoundariesController } from '../src/modules/boundaries/wizard.js';
import { buildBoundariesEmbed } from '../src/modules/boundaries/embed.js';

function interaction(customId = '', values = []) {
  const calls = [];
  return {
    guildId: 'guild', user: { id: 'owner' }, customId, values, calls,
    fields: { getTextInputValue: () => 'a note' },
    reply: async payload => calls.push(['reply', payload]),
    update: async payload => calls.push(['update', payload]),
    followUp: async payload => calls.push(['followUp', payload]),
    showModal: async payload => calls.push(['modal', payload])
  };
}

test('draft edits do not save until Save', async () => {
  let saved = 0;
  const controller = createBoundariesController({ store: { getBoundaries: () => ({ data: { new_dms: 'ask_first' } }), saveBoundaries: () => saved++ } });
  const start = interaction(); await controller.startEdit(start);
  const preset = interaction('bdry:preset', ['open']); await controller.handleComponent(preset);
  const value = interaction('bdry:value:owner:teasing', ['not_comfortable']); await controller.handleComponent(value);
  const note = interaction('bdry:notes:owner'); await controller.handleComponent(note);
  const modal = interaction('bdry:notes:owner'); await controller.handleModal(modal);
  assert.equal(saved, 0);
  const save = interaction('bdry:save:owner'); await controller.handleComponent(save);
  assert.equal(saved, 1);
});

test('privacy is private by default, preserves a saved audience, and saves a selected role', async () => {
  const defaultController = createBoundariesController({ store: { getBoundaries: () => null, saveBoundaries() {} } });
  const defaultStart = interaction(); await defaultController.startEdit(defaultStart);
  const defaultPrivacy = defaultStart.calls[0][1].components[2].components[0].toJSON();
  assert.equal(defaultPrivacy.options.find(option => option.value === 'private').default, true);

  const saved = [];
  const controller = createBoundariesController({
    store: {
      getBoundaries: () => ({ data: {}, privacy_level: 'members', privacy_role_id: null }),
      saveBoundaries: (...args) => saved.push(args)
    }
  });
  const start = interaction(); await controller.startEdit(start);
  const privacy = start.calls[0][1].components[2].components[0].toJSON();
  assert.equal(privacy.options.find(option => option.value === 'members').default, true);
  await controller.handleComponent(interaction('bdry:save:owner'));
  assert.deepEqual(saved[0].at(-1), { level: 'members', roleId: null });

  const savedRoleController = createBoundariesController({ store: { getBoundaries: () => ({ data: {}, privacy_level: 'role', privacy_role_id: 'existing-role' }), saveBoundaries() {} } });
  const savedRoleStart = interaction(); await savedRoleController.startEdit(savedRoleStart);
  assert.deepEqual(savedRoleStart.calls[0][1].components[3].components[0].toJSON().default_values, [{ id: 'existing-role', type: 'role' }]);

  const roleSaved = [];
  const roleController = createBoundariesController({ store: { getBoundaries: () => null, saveBoundaries: (...args) => roleSaved.push(args) } });
  await roleController.startEdit(interaction());
  const rolePrivacy = interaction('bdry:privacy:owner', ['role']); await roleController.handleComponent(rolePrivacy);
  assert.equal(rolePrivacy.calls[0][1].components[3].components[0].toJSON().type, 6);
  const blocked = interaction('bdry:save:owner'); await roleController.handleComponent(blocked);
  assert.equal(roleSaved.length, 0);
  assert.match(blocked.calls[0][1].content, /Choose a server role/);
  await roleController.handleComponent(interaction('bdry:privacy-role:owner', ['role-id']));
  await roleController.handleComponent(interaction('bdry:save:owner'));
  assert.deepEqual(roleSaved[0].at(-1), { level: 'role', roleId: 'role-id' });
});

test('privacy controls reject a different draft owner or guild', async () => {
  let saves = 0;
  const controller = createBoundariesController({ store: { getBoundaries: () => null, saveBoundaries: () => saves++ } });
  await controller.startEdit(interaction());
  const otherOwner = interaction('bdry:privacy:someone-else', ['members']); await controller.handleComponent(otherOwner);
  assert.match(otherOwner.calls[0][1].content, /belongs to someone else/);
  const otherGuild = interaction('bdry:save:owner'); otherGuild.guildId = 'other-guild'; await controller.handleComponent(otherGuild);
  assert.equal(saves, 0);
});

test('a member can clear one preference or remove all saved interaction notes', async () => {
  let removed = 0;
  let savedData = null;
  const controller = createBoundariesController({
    store: {
      getBoundaries: () => ({ data: { teasing: 'ask_first', notes: 'keep this' }, privacy_level: 'private' }),
      saveBoundaries: (_guild, _user, data) => { savedData = data; },
      deleteBoundaries: () => { removed += 1; return true; },
    },
  });
  const start = interaction(); await controller.startEdit(start);
  const controls = start.calls[0][1].components.at(-1).components.map((button) => button.data.custom_id);
  assert.ok(controls.includes('bdry:remove:owner'));
  await controller.handleComponent(interaction('bdry:value:owner:teasing', ['clear']));
  await controller.handleComponent(interaction('bdry:save:owner'));
  assert.equal(savedData.teasing, undefined);
  assert.equal(savedData.notes, 'keep this');

  await controller.startEdit(interaction());
  await controller.handleComponent(interaction('bdry:remove:owner'));
  assert.equal(removed, 1);
});

test('cancel and expiry do not write', async () => {
  let saved = 0; let time = 0;
  const controller = createBoundariesController({ store: { getBoundaries: () => null, saveBoundaries: () => saved++ }, now: () => time });
  await controller.startEdit(interaction());
  await controller.handleComponent(interaction('bdry:cancel:owner'));
  await controller.startEdit(interaction());
  time = 20 * 60 * 1000 + 1;
  await controller.handleComponent(interaction('bdry:save:owner'));
  assert.equal(saved, 0);
});

test('legacy rendering is readable and does not mutate stored data', () => {
  const data = { dms: { unsolicited: 'yes' }, humor: { sarcasm: 'ask' }, misc: { notes: 'please be normal' } };
  const before = JSON.stringify(data);
  const output = buildBoundariesEmbed({ ownerName: 'Mika', data });
  assert.equal(JSON.stringify(data), before);
  assert.match(output.embeds[0].data.fields.map(f => f.value).join('\n'), /Comfortable/);
  assert.match(output.embeds[0].data.fields.map(f => f.value).join('\n'), /Ask first/);
});
