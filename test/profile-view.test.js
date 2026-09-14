import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProfilePayload } from '../src/profile-view.js';

test('builds a calm compact profile card from saved profile data', () => {
  const payload = buildProfilePayload({
    profile: { bio: 'hi @everyone', pronouns: 'they/them', open_to: 'games', discoverable: true, allow_requests: true },
    tags: [{ display_name: 'Board games' }, { display_name: 'Art' }],
    theme: { primary_color: '#6f8060' },
    boundaries: { privacy_level: 'members' },
    displayName: 'Mika',
    avatarUrl: 'https://cdn.example/avatar.png',
  });
  const embed = payload.embeds[0].toJSON();
  assert.equal(embed.color, 0x6f8060);
  assert.equal(embed.author.name, 'Mika’s profile');
  assert.equal(embed.fields[0].value, 'hi @\u200beveryone');
  assert.equal(embed.fields.find((field) => field.name === 'Interests').value, 'Board games · Art');
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
