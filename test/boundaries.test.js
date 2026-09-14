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
