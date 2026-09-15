import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMediaStore, MAX_IMAGE_BYTES } from '../src/media.js';
import { markerForCardArt } from '../src/profile-presets.js';

const guildId = '1311683455020564500';
const userId = '1416081968537538640';
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0, 0, 0, 0]);

async function temporaryStore(fetchImpl) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-media-'));
  return { dataDir, store: createMediaStore({ dataDir, fetchImpl, timeoutMs: 20 }) };
}

function response(bytes, { type = 'image/png', length = bytes.length } = {}) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => name === 'content-type' ? type : name === 'content-length' ? String(length) : null },
    body: (async function* () { yield bytes; })(),
  };
}

test('stores a verified image atomically and resolves it as a Discord attachment', async (t) => {
  const { dataDir, store } = await temporaryStore(async () => response(png));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));

  const marker = await store.save(guildId, userId, { url: 'https://cdn.discordapp.com/image.png', contentType: 'image/png', size: png.length });
  assert.equal(marker, `local:profile-images/${guildId}/${userId}.png`);
  const resolved = await store.resolve(marker, guildId, userId);
  assert.equal(resolved.url, `attachment://profile-${guildId}-${userId}.png`);
  assert.equal(resolved.file.name, `profile-${guildId}-${userId}.png`);
  assert.deepEqual(await fs.readFile(resolved.file.attachment), png);
});

test('replaces previous variants and deletes only its own profile image', async (t) => {
  let bytes = png;
  const { dataDir, store } = await temporaryStore(async () => response(bytes, { type: bytes === png ? 'image/png' : 'image/jpeg' }));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await store.save(guildId, userId, { url: 'https://cdn.discordapp.com/one', contentType: 'image/png', size: png.length });
  bytes = jpeg;
  const marker = await store.save(guildId, userId, { url: 'https://cdn.discordapp.com/two', contentType: 'image/jpeg', size: jpeg.length });
  assert.match(marker, /\.jpg$/);
  await assert.rejects(fs.access(path.join(dataDir, 'profile-images', guildId, `${userId}.png`)));
  await store.remove(guildId, userId);
  assert.equal(await store.resolve(marker, guildId, userId), null);
});

test('rejects unsupported, oversized, malformed, and unsafe inputs', async (t) => {
  const { dataDir, store } = await temporaryStore(async () => response(Buffer.from('not an image'), { type: 'image/png' }));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await assert.rejects(store.save(guildId, userId, { url: 'https://cdn.discordapp.com/file', contentType: 'image/png' }), /supported image/);
  await assert.rejects(store.save('../escape', userId, { url: 'https://cdn.discordapp.com/file', contentType: 'image/png' }), /snowflake/);
  await assert.rejects(store.save(guildId, userId, { url: 'http://cdn.discordapp.com/file', contentType: 'image/png' }), /secure HTTPS/);
  await assert.rejects(store.save(guildId, userId, { url: 'https://cdn.discordapp.com/file', contentType: 'image/png', size: MAX_IMAGE_BYTES + 1 }), /larger than 5 MB/);
});

test('enforces the streamed byte limit and treats legacy URLs as read-only', async (t) => {
  const { dataDir, store } = await temporaryStore(async () => response(Buffer.alloc(32), { length: 32 }));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const limited = createMediaStore({ dataDir, fetchImpl: async () => response(Buffer.alloc(9), { length: 1 }), maxBytes: 8 });
  await assert.rejects(limited.save(guildId, userId, { url: 'https://cdn.discordapp.com/file', contentType: 'image/png', size: 1 }), /larger than 5 MB/);
  assert.deepEqual(await store.resolve('https://example.com/legacy-image.png', guildId, userId), { file: null, url: 'https://example.com/legacy-image.png' });
});

test('resolves a strict bundled photo marker without creating guild storage', async (t) => {
  const dataDir = path.join(os.tmpdir(), `profile-media-unused-${Date.now()}-${Math.random()}`);
  const store = createMediaStore({ dataDir, fetchImpl: async () => response(png) });
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));

  const resolved = await store.resolve(markerForCardArt('windowseat'), 'not-a-guild', 'not-a-user');
  assert.equal(resolved.url, 'attachment://profile-preset-windowseat.jpg');
  assert.equal(resolved.file.name, 'profile-preset-windowseat.jpg');
  assert.match(resolved.file.attachment, /assets[\\/]profile-presets[\\/]still-water\.jpg$/);
  assert.equal((await fs.stat(resolved.file.attachment)).isFile(), true);
  await assert.rejects(fs.access(dataDir));
  assert.equal(await store.resolve('preset:windowseat.png', guildId, userId), null);
  assert.equal(await store.resolve('preset:windowseat/../night-walk', guildId, userId), null);
});

test('does not follow local-marker traversal or symlinked image files', async (t) => {
  const { dataDir, store } = await temporaryStore(async () => response(png));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await store.save(guildId, userId, { url: 'https://cdn.discordapp.com/image.png', contentType: 'image/png', size: png.length });
  assert.equal(await store.resolve(`local:profile-images/${guildId}/../${userId}.png`, guildId, userId), null);
  const image = path.join(dataDir, 'profile-images', guildId, `${userId}.png`);
  await fs.unlink(image);
  await fs.symlink(path.join(dataDir, 'outside.png'), image);
  assert.equal(await store.resolve(`local:profile-images/${guildId}/${userId}.png`, guildId, userId), null);
});
