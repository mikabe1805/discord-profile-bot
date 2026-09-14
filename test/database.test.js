import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createStore } from '../src/database.js';

function temporaryDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-bot-'));
  return { directory, databasePath: path.join(directory, 'bot.db') };
}

function cleanupStore(t, directory, store) {
  t.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
}

function makeLegacyDatabase(databasePath) {
  const db = new Database(databasePath);
  db.exec(`
    CREATE TABLE guilds (guild_id TEXT PRIMARY KEY, created_at TEXT, allow_ugc_tags INTEGER, max_tags_per_user INTEGER, profile_theme TEXT, custom_colors TEXT, updated_at TEXT);
    CREATE TABLE profiles (guild_id TEXT, user_id TEXT, bio TEXT, profile_image TEXT, tags TEXT, updated_at TEXT, PRIMARY KEY (guild_id,user_id));
    CREATE TABLE tags (guild_id TEXT, tag_slug TEXT, display_name TEXT, created_by TEXT, category TEXT, created_at TEXT, updated_at TEXT, PRIMARY KEY (guild_id,tag_slug));
    CREATE TABLE tag_members (guild_id TEXT, tag_slug TEXT, user_id TEXT, added_at TEXT, PRIMARY KEY (guild_id,tag_slug,user_id));
    CREATE TABLE user_themes (guild_id TEXT, user_id TEXT, theme TEXT, primary_color TEXT, secondary_color TEXT, title TEXT, tags_emoji TEXT, updated_at TEXT, PRIMARY KEY (guild_id,user_id));
    CREATE TABLE feature_configs (guild_id TEXT PRIMARY KEY, ping_threads INTEGER, user_customization INTEGER, updated_at TEXT);
    CREATE TABLE boundaries (guild_id TEXT, user_id TEXT, data TEXT, privacy_level TEXT, privacy_role_id TEXT, created_at TEXT, updated_at TEXT, PRIMARY KEY (guild_id,user_id));
  `);
  db.prepare('INSERT INTO guilds VALUES (?,?,?,?,?,?,?)').run('guild', '2025-01-01', 1, 2, 'old', '{"ink":"blue"}', '2025-01-01');
  db.prepare('INSERT INTO profiles VALUES (?,?,?,?,?,?)').run('guild', 'alice', 'legacy bio', 'image', '["games","art"]', '2025-01-02');
  db.prepare('INSERT INTO tags VALUES (?,?,?,?,?,?,?)').run('guild', 'games', 'Games', 'alice', 'interest', '2025-01-01', '2025-01-01');
  db.prepare('INSERT INTO tag_members VALUES (?,?,?,?)').run('guild', 'games', 'alice', '2025-01-02');
  db.prepare('INSERT INTO user_themes VALUES (?,?,?,?,?,?,?,?)').run('guild', 'alice', 'night', '#111', '#222', 'Original', '🎮', '2025-01-02');
  db.prepare('INSERT INTO feature_configs VALUES (?,?,?,?)').run('guild', 1, 1, '2025-01-02');
  db.prepare('INSERT INTO boundaries VALUES (?,?,?,?,?,?,?)').run('guild', 'alice', '{"no":"spam"}', 'members', null, '2025-01-02', '2025-01-02');
  db.close();
}

test('migrates a legacy bot database without losing existing data', (t) => {
  const { directory, databasePath } = temporaryDatabase();
  makeLegacyDatabase(databasePath);
  const store = createStore({ databasePath }); cleanupStore(t, directory, store);
  assert.equal(store.getProfile('guild', 'alice').bio, 'legacy bio');
  assert.equal(store.getProfile('guild', 'alice').discoverable, false);
  assert.deepEqual(store.listUserTags('guild', 'alice').map((tag) => tag.tag_slug), ['art', 'games']);
  assert.equal(store.getTheme('guild', 'alice').title, 'Original');
  assert.deepEqual(store.getBoundaries('guild', 'alice').data, { no: 'spam' });
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count, 6);
  assert.equal(fs.readdirSync(path.join(directory, 'backups')).length, 1);
});

test('patches settings and themes without clobbering fields', (t) => {
  const { directory, databasePath } = temporaryDatabase();
  const store = createStore({ databasePath }); cleanupStore(t, directory, store);
  store.ensureGuild('guild');
  store.updateGuildSettings('guild', { max_tags_per_user: 2 });
  assert.equal(store.getGuildSettings('guild').profile_theme, 'default');
  store.saveProfile('guild', 'alice', { bio: 'hello', discoverable: false });
  store.saveProfile('guild', 'alice', { pronouns: 'they/them' });
  assert.equal(store.getProfile('guild', 'alice').bio, 'hello');
  assert.equal(store.getProfile('guild', 'alice').discoverable, false);
  store.updateTheme('guild', 'alice', { theme: 'night', title: 'Before' });
  store.updateTheme('guild', 'alice', { title: 'After' });
  assert.deepEqual(store.getTheme('guild', 'alice').theme, 'night');
  assert.deepEqual(store.getTheme('guild', 'alice').title, 'After');
});

test('enforces tag policy and shows only discoverable profiles', (t) => {
  const { directory, databasePath } = temporaryDatabase();
  const store = createStore({ databasePath }); cleanupStore(t, directory, store);
  store.updateGuildSettings('guild', { max_tags_per_user: 1, allow_ugc_tags: true });
  store.addTag('guild', 'games', 'Games', 'alice');
  store.addTag('guild', 'art', 'Art', 'alice');
  store.addUserTag('guild', 'alice', 'games');
  assert.throws(() => store.addUserTag('guild', 'alice', 'art'), /Tag limit/);
  store.saveProfile('guild', 'alice', { bio: 'visible', discoverable: true });
  store.saveProfile('guild', 'bob', { bio: 'hidden', discoverable: false });
  store.addUserTag('guild', 'bob', 'games');
  assert.deepEqual(store.discoverProfiles('guild', { tag: 'games' }).map((profile) => profile.user_id), ['alice']);
  store.updatePrivacy('guild', 'alice', { allow_group_pings: true });
  assert.deepEqual(store.findGatherCandidates('guild', ['games']).map((profile) => profile.user_id), ['alice']);
  assert.equal(store.recordGather('guild', 'alice', 1).recipient_count, 1);
  assert.equal(store.getLastGather('guild', 'alice').sender_id, 'alice');
  store.updateGuildSettings('guild', { allow_ugc_tags: false });
  assert.throws(() => store.addTag('guild', 'music', 'Music', 'alice'), /does not allow/);
});

test('tracks consented connection requests, blocks, and deletion', (t) => {
  const { directory, databasePath } = temporaryDatabase();
  const store = createStore({ databasePath }); cleanupStore(t, directory, store);
  store.saveProfile('guild', 'alice', { allow_requests: true, discoverable: true });
  store.saveProfile('guild', 'bob', { allow_requests: true });
  const request = store.createConnectionRequest('guild', 'bob', 'alice', 'want to talk games?');
  assert.equal(request.status, 'pending');
  assert.equal(store.countConnectionRequests('guild', 'bob'), 1);
  store.db.prepare("UPDATE connection_requests SET created_at='2026-09-14 15:30:00' WHERE id=?").run(request.id);
  assert.equal(store.countConnectionRequests('guild', 'bob', { since: '2026-09-14T15:00:00.000Z', status: null }), 1);
  assert.throws(() => store.createConnectionRequest('guild', 'bob', 'alice'), /pending/);
  assert.equal(store.setConnectionRequestStatus(request.id, 'accepted', { actorId: 'alice' }).status, 'accepted');
  store.blockUser('guild', 'alice', 'bob');
  assert.equal(store.isBlocked('guild', 'alice', 'bob'), true);
  assert.throws(() => store.createConnectionRequest('guild', 'bob', 'alice'), /blocked/);
  assert.equal(store.deleteUserData('guild', 'bob'), true);
  assert.equal(store.getProfile('guild', 'bob'), null);
  assert.equal(store.stats('guild').connection_requests, 0);
  assert.deepEqual(store.integrityCheck(), [{ integrity_check: 'ok' }]);
});
