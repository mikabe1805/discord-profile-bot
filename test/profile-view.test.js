import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProfilePayload } from '../src/profile-view.js';

test('builds a calm compact profile card from saved profile data', () => {
  const payload = buildProfilePayload({
    profile: { bio: 'hi @everyone', pronouns: 'they/them', open_to: 'games', discoverable: true, allow_requests: true },
    tags: [{ display_name: 'Board games' }, { display_name: 'Art' }],
    theme: { primary_color: '#6f8060', title: 'Field Notes', tags_emoji: '✎' },
    boundaries: { privacy_level: 'members', data: { new_dms: 'ask_first', notes: 'please ping first @everyone' } },
    displayName: 'Mika',
    avatarUrl: 'https://cdn.example/avatar.png',
  });
  const embed = payload.embeds[0].toJSON();
  assert.equal(embed.color, 0x6f8060);
  assert.equal(embed.author.name, 'Mika’s profile');
  assert.equal(embed.title, 'Field Notes');
  assert.equal(embed.fields[0].value, 'hi @\u200beveryone');
  assert.equal(embed.fields.find((field) => field.name === '✎ Interests').value, 'Board games · Art');
  assert.equal(embed.fields.at(-1).name, 'Interaction notes (optional)');
  assert.match(embed.fields.at(-1).value, /New DMs: .*Ask first/);
  assert.match(embed.fields.at(-1).value, /@\u200beveryone/);
  assert.match(embed.footer.text, /Directory: visible/);
  assert.equal(embed.thumbnail.url, 'https://cdn.example/avatar.png');
});

test('uses a local image descriptor as a Discord attachment and limits long text', () => {
  const payload = buildProfilePayload({
    profile: { bio: 'x'.repeat(5_000), discoverable: false, allow_requests: false },
    profileImage: { path: '/data/profile-images/a.png', name: 'mika.png' },
    displayName: 'Mika',
  });
  const embed = payload.embeds[0].toJSON();
  assert.equal(payload.files[0].attachment, '/data/profile-images/a.png');
  assert.equal(embed.image.url, 'attachment://mika.png');
  assert.ok(embed.fields[0].value.length <= 4096);
  assert.ok(embed.fields[0].value.endsWith('…'));
});

test('a persisted photo marker uses the current bundled theme metadata', () => {
  const payload = buildProfilePayload({
    profile: { profile_image: 'preset:moss-room' },
    tags: ['hiking'],
    theme: { primary_color: '#000000', title: 'Old preset title', tags_emoji: 'x' },
    displayName: 'Mika',
    profileImage: { attachment: 'canopy.jpg', name: 'profile-preset-moss-room.jpg' },
  });
  const embed = payload.embeds[0].toJSON();
  assert.equal(embed.title, 'Canopy');
  assert.equal(embed.color, 0x58704C);
  assert.equal(embed.fields.at(-1).name, '🌿 Interests');
});
