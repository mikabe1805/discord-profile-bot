import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_GUILD = Object.freeze({
  allow_ugc_tags: true, max_tags_per_user: 30, profile_theme: 'default', custom_colors: null, allow_gathers: true,
});
const PROFILE_FIELDS = new Set(['bio', 'profile_image', 'pronouns', 'open_to', 'discoverable', 'allow_requests', 'allow_group_pings']);
const GUILD_FIELDS = new Set(['allow_ugc_tags', 'max_tags_per_user', 'profile_theme', 'custom_colors', 'allow_gathers']);
const THEME_FIELDS = new Set(['theme', 'primary_color', 'secondary_color', 'title', 'tags_emoji']);
const REQUEST_STATUSES = new Set(['pending', 'accepted', 'declined', 'cancelled']);
const PRIVACY_LEVELS = new Set(['members', 'role', 'private']);
const CURRENT_SCHEMA_VERSION = 6;

function requiredId(value, name) {
  if (typeof value !== 'string' || !/^[0-9A-Za-z:_-]{1,128}$/.test(value)) throw new TypeError(`Invalid ${name}`);
  return value;
}
function optionalText(value, name, max = 2000) {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length > max) throw new TypeError(`Invalid ${name}`);
  return value.trim();
}
function bool(value, name) {
  if (typeof value !== 'boolean' && value !== 0 && value !== 1) throw new TypeError(`Invalid ${name}`);
  return Number(Boolean(value));
}
function tagSlug(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)) throw new TypeError('Invalid tag slug');
  return value;
}
function rowBool(row, keys) {
  for (const key of keys) if (row[key] !== undefined) row[key] = Boolean(row[key]);
  return row;
}
function columnExists(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((entry) => entry.name === column);
}
function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

/**
 * Opens the bot's SQLite database and returns a synchronous repository.  All inputs are
 * bound parameters; schema identifiers are fixed in this module.
 */
export function createStore({ databasePath, backupDir = null } = {}) {
  if (typeof databasePath !== 'string' || databasePath.length === 0) throw new TypeError('databasePath is required');
  const isMemory = databasePath === ':memory:';
  if (!isMemory) fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
  const db = new Database(databasePath);
  const needsMigration = !isMemory && fs.statSync(databasePath).size > 0 && (
    !tableExists(db, 'schema_migrations')
    || (db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get().version < CURRENT_SCHEMA_VERSION)
  );
  if (needsMigration) {
    const migrationBackupDir = backupDir || path.join(path.dirname(path.resolve(databasePath)), 'backups');
    fs.mkdirSync(migrationBackupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(databasePath, path.join(migrationBackupDir, `${path.basename(databasePath)}.${stamp}.pre-migration.bak`));
  }
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  if (!isMemory) db.pragma('journal_mode = WAL');

  const migrate = db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version));
    const apply = (version, fn) => { if (!applied.has(version)) { fn(); db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(version); } };
    apply(1, () => db.exec(`
      CREATE TABLE IF NOT EXISTS guilds (guild_id TEXT PRIMARY KEY, created_at TEXT DEFAULT CURRENT_TIMESTAMP, allow_ugc_tags INTEGER DEFAULT 1, max_tags_per_user INTEGER DEFAULT 30, profile_theme TEXT DEFAULT 'default', custom_colors TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS profiles (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, bio TEXT DEFAULT '', profile_image TEXT, tags TEXT DEFAULT '[]', updated_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (guild_id,user_id), FOREIGN KEY (guild_id) REFERENCES guilds(guild_id));
      CREATE TABLE IF NOT EXISTS tags (guild_id TEXT NOT NULL, tag_slug TEXT NOT NULL, display_name TEXT NOT NULL, created_by TEXT, category TEXT DEFAULT 'general', created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (guild_id,tag_slug), FOREIGN KEY (guild_id) REFERENCES guilds(guild_id));
      CREATE TABLE IF NOT EXISTS tag_members (guild_id TEXT NOT NULL, tag_slug TEXT NOT NULL, user_id TEXT NOT NULL, added_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (guild_id,tag_slug,user_id), FOREIGN KEY (guild_id,tag_slug) REFERENCES tags(guild_id,tag_slug), FOREIGN KEY (guild_id,user_id) REFERENCES profiles(guild_id,user_id));
      CREATE TABLE IF NOT EXISTS user_themes (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, theme TEXT, primary_color TEXT, secondary_color TEXT, title TEXT, tags_emoji TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (guild_id,user_id), FOREIGN KEY (guild_id,user_id) REFERENCES profiles(guild_id,user_id));
      CREATE TABLE IF NOT EXISTS feature_configs (guild_id TEXT PRIMARY KEY, ping_threads INTEGER DEFAULT 1, user_customization INTEGER DEFAULT 1, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (guild_id) REFERENCES guilds(guild_id));
      CREATE TABLE IF NOT EXISTS boundaries (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, data TEXT, privacy_level TEXT DEFAULT 'members', privacy_role_id TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (guild_id,user_id), FOREIGN KEY (guild_id) REFERENCES guilds(guild_id));
    `));
    apply(2, () => {
      const additions = [['pronouns', 'TEXT'], ['open_to', 'TEXT'], ['discoverable', 'INTEGER NOT NULL DEFAULT 0'], ['allow_requests', 'INTEGER NOT NULL DEFAULT 0'], ['allow_group_pings', 'INTEGER NOT NULL DEFAULT 0'], ['created_at', 'TEXT']];
      for (const [name, definition] of additions) if (!columnExists(db, 'profiles', name)) db.exec(`ALTER TABLE profiles ADD COLUMN ${name} ${definition}`);
      db.exec("UPDATE profiles SET discoverable = 0 WHERE discoverable IS NULL; UPDATE profiles SET allow_requests = 0 WHERE allow_requests IS NULL; UPDATE profiles SET allow_group_pings = 0 WHERE allow_group_pings IS NULL; UPDATE profiles SET created_at = COALESCE(created_at, updated_at, CURRENT_TIMESTAMP) WHERE created_at IS NULL");
    });
    apply(3, () => db.exec(`
      CREATE TABLE IF NOT EXISTS connection_requests (id INTEGER PRIMARY KEY, guild_id TEXT NOT NULL, sender_id TEXT NOT NULL, recipient_id TEXT NOT NULL, message TEXT, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','declined','cancelled')), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, responded_at TEXT, FOREIGN KEY (guild_id) REFERENCES guilds(guild_id));
      CREATE TABLE IF NOT EXISTS connection_blocks (guild_id TEXT NOT NULL, blocker_id TEXT NOT NULL, blocked_id TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (guild_id,blocker_id,blocked_id), FOREIGN KEY (guild_id) REFERENCES guilds(guild_id));
      CREATE INDEX IF NOT EXISTS idx_profiles_discovery ON profiles(guild_id, discoverable, user_id);
      CREATE INDEX IF NOT EXISTS idx_tags_guild ON tags(guild_id, tag_slug);
      CREATE INDEX IF NOT EXISTS idx_tag_members_user ON tag_members(guild_id, user_id, tag_slug);
      CREATE INDEX IF NOT EXISTS idx_requests_recipient_status ON connection_requests(guild_id, recipient_id, status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_requests_sender_created ON connection_requests(guild_id, sender_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_requests_pair_pending ON connection_requests(guild_id, sender_id, recipient_id, status);
      CREATE INDEX IF NOT EXISTS idx_blocks_blocked ON connection_blocks(guild_id, blocked_id, blocker_id);
    `));
    apply(4, () => {
      // Earlier builds also cached memberships in profiles.tags. Import it once, then leave
      // tag_members as the only source of truth so deleted tags cannot return on restart.
      if (!tableExists(db, 'profiles') || !columnExists(db, 'profiles', 'tags')) return;
      const profiles = db.prepare('SELECT guild_id, user_id, tags FROM profiles').all();
      const ensureTag = db.prepare("INSERT INTO tags (guild_id, tag_slug, display_name, created_by, category) VALUES (?, ?, ?, ?, 'legacy') ON CONFLICT(guild_id, tag_slug) DO NOTHING");
      const join = db.prepare('INSERT INTO tag_members (guild_id, tag_slug, user_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING');
      for (const profile of profiles) {
        let saved = [];
        try {
          const parsed = JSON.parse(profile.tags || '[]');
          saved = Array.isArray(parsed) ? parsed : [];
        } catch {
          saved = [];
        }
        for (const raw of saved) {
          if (typeof raw !== 'string') continue;
          const slug = raw.toLowerCase().trim().replace(/\s+/g, '-');
          if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(slug)) continue;
          ensureTag.run(profile.guild_id, slug, raw.trim().slice(0, 80) || slug, profile.user_id);
          join.run(profile.guild_id, slug, profile.user_id);
        }
      }
    });
    apply(5, () => {
      if (!columnExists(db, 'guilds', 'allow_gathers')) {
        db.exec('ALTER TABLE guilds ADD COLUMN allow_gathers INTEGER NOT NULL DEFAULT 1');
      }
      db.exec("UPDATE boundaries SET privacy_level = 'private' WHERE privacy_level = 'friends'; UPDATE boundaries SET privacy_level = 'members' WHERE privacy_level = 'everyone'");
    });
    apply(6, () => db.exec(`
      CREATE TABLE IF NOT EXISTS gather_events (
        id INTEGER PRIMARY KEY,
        guild_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        recipient_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (guild_id) REFERENCES guilds(guild_id)
      );
      CREATE INDEX IF NOT EXISTS idx_gathers_sender_created
        ON gather_events(guild_id, sender_id, created_at DESC);
    `));
  });
  migrate();

  const ensureGuild = (guildId) => {
    requiredId(guildId, 'guild id');
    db.prepare(`INSERT INTO guilds (guild_id) VALUES (?) ON CONFLICT(guild_id) DO NOTHING`).run(guildId);
    return getGuildSettings(guildId);
  };
  const getGuildSettings = (guildId) => {
    requiredId(guildId, 'guild id');
    const row = db.prepare('SELECT allow_ugc_tags,max_tags_per_user,profile_theme,custom_colors,allow_gathers FROM guilds WHERE guild_id=?').get(guildId);
    if (!row) return { ...DEFAULT_GUILD };
    let customColors = null;
    try { customColors = row.custom_colors ? JSON.parse(row.custom_colors) : null; } catch { customColors = null; }
    return { ...row, allow_ugc_tags: Boolean(row.allow_ugc_tags), allow_gathers: Boolean(row.allow_gathers), custom_colors: customColors };
  };
  const updateGuildSettings = (guildId, patch = {}) => {
    ensureGuild(guildId); const entries = Object.entries(patch).filter(([key, value]) => value !== undefined && GUILD_FIELDS.has(key));
    if (entries.length !== Object.keys(patch).filter((key) => patch[key] !== undefined).length) throw new TypeError('Unknown guild setting');
    if (!entries.length) return getGuildSettings(guildId);
    const values = entries.map(([key, value]) => {
      if (key === 'allow_ugc_tags' || key === 'allow_gathers') return bool(value, key);
      if (key === 'max_tags_per_user' && (!Number.isInteger(value) || value < 1 || value > 100)) throw new TypeError('Invalid max_tags_per_user');
      if (key === 'profile_theme') return optionalText(value, key, 64);
      if (key === 'custom_colors') return value == null ? null : JSON.stringify(value);
      return value;
    });
    db.prepare(`UPDATE guilds SET ${entries.map(([key]) => `${key}=?`).join(',')},updated_at=CURRENT_TIMESTAMP WHERE guild_id=?`).run(...values, guildId);
    return getGuildSettings(guildId);
  };
  const getProfile = (guildId, userId) => {
    requiredId(guildId, 'guild id'); requiredId(userId, 'user id');
    const row = db.prepare('SELECT guild_id,user_id,bio,profile_image,pronouns,open_to,discoverable,allow_requests,allow_group_pings,created_at,updated_at FROM profiles WHERE guild_id=? AND user_id=?').get(guildId, userId);
    return row ? rowBool(row, ['discoverable', 'allow_requests', 'allow_group_pings']) : null;
  };
  const saveProfile = (guildId, userId, patch = {}) => {
    ensureGuild(guildId); requiredId(userId, 'user id');
    const entries = Object.entries(patch).filter(([key, value]) => value !== undefined && PROFILE_FIELDS.has(key));
    if (entries.length !== Object.keys(patch).filter((key) => patch[key] !== undefined).length) throw new TypeError('Unknown profile field');
    db.prepare("INSERT INTO profiles (guild_id,user_id,created_at,updated_at) VALUES (?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT(guild_id,user_id) DO NOTHING").run(guildId,userId);
    if (entries.length) {
      const values = entries.map(([key,value]) => ['discoverable','allow_requests','allow_group_pings'].includes(key) ? bool(value,key) : optionalText(value,key,key === 'bio' ? 2000 : 200));
      db.prepare(`UPDATE profiles SET ${entries.map(([key]) => `${key}=?`).join(',')},updated_at=CURRENT_TIMESTAMP WHERE guild_id=? AND user_id=?`).run(...values,guildId,userId);
    }
    return getProfile(guildId,userId);
  };
  const updatePrivacy = (guildId,userId,patch = {}) => {
    const allowed = new Set(['discoverable', 'allow_requests', 'allow_group_pings']);
    for (const key of Object.keys(patch)) if (!allowed.has(key)) throw new TypeError('Unknown privacy field');
    return saveProfile(guildId,userId,patch);
  };

  const listUserTags = (guildId,userId) => db.prepare('SELECT t.guild_id,t.tag_slug,t.display_name,t.category,t.created_by,tm.added_at FROM tag_members tm JOIN tags t ON t.guild_id=tm.guild_id AND t.tag_slug=tm.tag_slug WHERE tm.guild_id=? AND tm.user_id=? ORDER BY lower(t.display_name),t.tag_slug').all(requiredId(guildId,'guild id'),requiredId(userId,'user id'));
  const addTag = (guildId, slug, displayName, createdBy, category='general', { bypassUgc = false } = {}) => { ensureGuild(guildId); if (!getGuildSettings(guildId).allow_ugc_tags && !bypassUgc) throw new RangeError('This server does not allow member-created tags'); tagSlug(slug); requiredId(createdBy,'creator id'); displayName=optionalText(displayName,'display name',80); category=optionalText(category,'category',32); if (!displayName || !category) throw new TypeError('Tag display name and category are required'); db.prepare("INSERT INTO tags (guild_id,tag_slug,display_name,created_by,category) VALUES (?,?,?,?,?) ON CONFLICT(guild_id,tag_slug) DO UPDATE SET display_name=excluded.display_name,category=excluded.category,updated_at=CURRENT_TIMESTAMP").run(guildId,slug,displayName,createdBy,category); return getTag(guildId,slug); };
  const getTag = (guildId,slug) => db.prepare('SELECT * FROM tags WHERE guild_id=? AND tag_slug=?').get(requiredId(guildId,'guild id'),tagSlug(slug)) || null;
  const removeTag = (guildId,slug) => db.transaction(() => { requiredId(guildId,'guild id'); tagSlug(slug); db.prepare('DELETE FROM tag_members WHERE guild_id=? AND tag_slug=?').run(guildId,slug); return db.prepare('DELETE FROM tags WHERE guild_id=? AND tag_slug=?').run(guildId,slug).changes > 0; })();
  const listTags = (guildId, limit=100) => db.prepare('SELECT t.*,COUNT(tm.user_id) AS member_count FROM tags t LEFT JOIN tag_members tm ON tm.guild_id=t.guild_id AND tm.tag_slug=t.tag_slug WHERE t.guild_id=? GROUP BY t.guild_id,t.tag_slug ORDER BY lower(t.display_name),t.tag_slug LIMIT ?').all(requiredId(guildId,'guild id'),Math.max(1,Math.min(Number(limit)||100,500)));
  const searchTags = (guildId, query, limit=25) => { query=optionalText(query,'tag query',80); return db.prepare('SELECT * FROM tags WHERE guild_id=? AND (tag_slug LIKE ? ESCAPE \'\\\' OR display_name LIKE ? ESCAPE \'\\\') ORDER BY lower(display_name),tag_slug LIMIT ?').all(requiredId(guildId,'guild id'),`%${query.replace(/[\\%_]/g,'\\$&')}%`,`%${query.replace(/[\\%_]/g,'\\$&')}%`,Math.max(1,Math.min(Number(limit)||25,100))); };
  const addUserTag = db.transaction((guildId,userId,slug) => { ensureGuild(guildId); requiredId(userId,'user id'); tagSlug(slug); if (!getTag(guildId,slug)) throw new RangeError('Tag does not exist'); saveProfile(guildId,userId,{}); const max=getGuildSettings(guildId).max_tags_per_user; const count=db.prepare('SELECT COUNT(*) AS count FROM tag_members WHERE guild_id=? AND user_id=?').get(guildId,userId).count; const exists=db.prepare('SELECT 1 FROM tag_members WHERE guild_id=? AND tag_slug=? AND user_id=?').get(guildId,slug,userId); if (!exists && count>=max) throw new RangeError(`Tag limit of ${max} reached`); db.prepare('INSERT INTO tag_members (guild_id,tag_slug,user_id) VALUES (?,?,?) ON CONFLICT DO NOTHING').run(guildId,slug,userId); return listUserTags(guildId,userId); });
  const removeUserTag = (guildId,userId,slug) => db.prepare('DELETE FROM tag_members WHERE guild_id=? AND user_id=? AND tag_slug=?').run(requiredId(guildId,'guild id'),requiredId(userId,'user id'),tagSlug(slug)).changes>0;
  const setUserTags = db.transaction((guildId,userId,slugs) => { if (!Array.isArray(slugs)) throw new TypeError('tags must be an array'); const unique=[...new Set(slugs.map(tagSlug))]; const max=getGuildSettings(guildId).max_tags_per_user; if(unique.length>max) throw new RangeError(`Tag limit of ${max} reached`); for(const slug of unique) if(!getTag(guildId,slug)) throw new RangeError(`Unknown tag: ${slug}`); saveProfile(guildId,userId,{}); db.prepare('DELETE FROM tag_members WHERE guild_id=? AND user_id=?').run(guildId,userId); const add=db.prepare('INSERT INTO tag_members (guild_id,tag_slug,user_id) VALUES (?,?,?)'); for(const slug of unique) add.run(guildId,slug,userId); return listUserTags(guildId,userId); });
  const discoverProfiles = (guildId,{tag=null,limit=25,offset=0}={}) => { requiredId(guildId,'guild id'); if(tag!=null) tagSlug(tag); const rows=tag ? db.prepare('SELECT p.guild_id,p.user_id,p.bio,p.profile_image,p.pronouns,p.open_to,p.created_at FROM profiles p JOIN tag_members tm ON tm.guild_id=p.guild_id AND tm.user_id=p.user_id WHERE p.guild_id=? AND p.discoverable=1 AND tm.tag_slug=? ORDER BY p.updated_at DESC LIMIT ? OFFSET ?').all(guildId,tag,Math.max(1,Math.min(Number(limit)||25,100)),Math.max(0,Number(offset)||0)) : db.prepare('SELECT guild_id,user_id,bio,profile_image,pronouns,open_to,created_at FROM profiles WHERE guild_id=? AND discoverable=1 ORDER BY updated_at DESC LIMIT ? OFFSET ?').all(guildId,Math.max(1,Math.min(Number(limit)||25,100)),Math.max(0,Number(offset)||0)); return rows; };
  const findGatherCandidates = (guildId, slugs, limit = 25) => {
    requiredId(guildId, 'guild id');
    if (!Array.isArray(slugs) || slugs.length === 0) return [];
    const interests = [...new Set(slugs.map(tagSlug))];
    const cappedLimit = Math.max(1, Math.min(Number(limit) || 25, 100));
    const placeholders = interests.map(() => '?').join(',');
    return db.prepare(`
      SELECT p.user_id, COUNT(DISTINCT tm.tag_slug) AS match_count
      FROM profiles p
      JOIN tag_members tm ON tm.guild_id = p.guild_id AND tm.user_id = p.user_id
      WHERE p.guild_id = ? AND p.allow_group_pings = 1 AND tm.tag_slug IN (${placeholders})
      GROUP BY p.user_id
      ORDER BY match_count DESC, p.updated_at DESC
      LIMIT ?
    `).all(guildId, ...interests, cappedLimit);
  };

  const recordGather = (guildId, senderId, recipientCount) => {
    ensureGuild(guildId); requiredId(senderId, 'sender id');
    if (!Number.isInteger(recipientCount) || recipientCount < 0 || recipientCount > 100) throw new TypeError('Invalid recipient count');
    const result = db.prepare('INSERT INTO gather_events (guild_id,sender_id,recipient_count) VALUES (?,?,?)').run(guildId, senderId, recipientCount);
    return db.prepare('SELECT * FROM gather_events WHERE id=?').get(result.lastInsertRowid);
  };
  const getLastGather = (guildId, senderId) => db.prepare('SELECT * FROM gather_events WHERE guild_id=? AND sender_id=? ORDER BY created_at DESC,id DESC LIMIT 1').get(requiredId(guildId,'guild id'),requiredId(senderId,'sender id')) || null;
  const deleteGatherEvent = (id, senderId) => db.prepare('DELETE FROM gather_events WHERE id=? AND sender_id=?').run(Number(id), requiredId(senderId, 'sender id')).changes > 0;

  const getTheme=(guildId,userId)=>db.prepare('SELECT theme,primary_color,secondary_color,title,tags_emoji,updated_at FROM user_themes WHERE guild_id=? AND user_id=?').get(requiredId(guildId,'guild id'),requiredId(userId,'user id'))||null;
  const updateTheme=(guildId,userId,patch={})=>{ saveProfile(guildId,userId,{}); const entries=Object.entries(patch).filter(([key,value])=>value!==undefined&&THEME_FIELDS.has(key)); if(entries.length!==Object.keys(patch).filter(key=>patch[key]!==undefined).length)throw new TypeError('Unknown theme field'); if(!entries.length)return getTheme(guildId,userId); db.prepare(`INSERT INTO user_themes (guild_id,user_id,${entries.map(([key])=>key).join(',')},updated_at) VALUES (?,?,${entries.map(()=>'?').join(',')},CURRENT_TIMESTAMP) ON CONFLICT(guild_id,user_id) DO UPDATE SET ${entries.map(([key])=>`${key}=excluded.${key}`).join(',')},updated_at=CURRENT_TIMESTAMP`).run(guildId,userId,...entries.map(([key,value])=>optionalText(value,key,128))); return getTheme(guildId,userId);};
  const getBoundaries=(guildId,userId)=>{const row=db.prepare('SELECT guild_id,user_id,data,privacy_level,privacy_role_id,created_at,updated_at FROM boundaries WHERE guild_id=? AND user_id=?').get(requiredId(guildId,'guild id'),requiredId(userId,'user id'));if(!row)return null;try{row.data=row.data?JSON.parse(row.data):{};}catch{row.data={};}return row;};
  const saveBoundaries=(guildId,userId,data={},privacy={})=>{ensureGuild(guildId);requiredId(userId,'user id');const existing=getBoundaries(guildId,userId);const privacy_level=privacy?.level||privacy?.privacy_level||existing?.privacy_level||'private';const privacy_role_id=privacy?.roleId!==undefined?privacy.roleId:(privacy?.privacy_role_id!==undefined?privacy.privacy_role_id:(existing?.privacy_role_id||null));if(!PRIVACY_LEVELS.has(privacy_level))throw new TypeError('Invalid boundaries privacy level');if(privacy_level==='role'&&privacy_role_id==null)throw new TypeError('A role is required for role privacy');if(privacy_role_id!=null)requiredId(privacy_role_id,'privacy role id');const encoded=JSON.stringify(data||{});if(encoded.length>10000)throw new RangeError('Boundary data is too large');db.prepare('INSERT INTO boundaries (guild_id,user_id,data,privacy_level,privacy_role_id) VALUES (?,?,?,?,?) ON CONFLICT(guild_id,user_id) DO UPDATE SET data=excluded.data,privacy_level=excluded.privacy_level,privacy_role_id=excluded.privacy_role_id,updated_at=CURRENT_TIMESTAMP').run(guildId,userId,encoded,privacy_level,privacy_level==='role'?privacy_role_id:null);return getBoundaries(guildId,userId);};
  const updateBoundariesPrivacy=(guildId,userId,privacy_level,privacy_role_id=null)=>{if(!PRIVACY_LEVELS.has(privacy_level))throw new TypeError('Invalid boundaries privacy level');const existing=getBoundaries(guildId,userId);return saveBoundaries(guildId,userId,existing?.data||{},{level:privacy_level,roleId:privacy_role_id});};
  const deleteBoundaries=(guildId,userId)=>db.prepare('DELETE FROM boundaries WHERE guild_id=? AND user_id=?').run(requiredId(guildId,'guild id'),requiredId(userId,'user id')).changes>0;

  const createConnectionRequest=db.transaction((guildId,senderId,recipientId,message=null)=>{ensureGuild(guildId);requiredId(senderId,'sender id');requiredId(recipientId,'recipient id');if(senderId===recipientId)throw new TypeError('Cannot request yourself');message=optionalText(message,'request message',1000);if(isBlocked(guildId,senderId,recipientId))throw new RangeError('Connection is blocked');const recipient=getProfile(guildId,recipientId);if(!recipient?.allow_requests)throw new RangeError('Recipient does not accept requests');const prior=getPendingConnectionRequest(guildId,senderId,recipientId);if(prior)throw new RangeError('A pending request already exists');const result=db.prepare("INSERT INTO connection_requests (guild_id,sender_id,recipient_id,message,status) VALUES (?,?,?,?, 'pending')").run(guildId,senderId,recipientId,message);return getConnectionRequest(result.lastInsertRowid);});
  const getConnectionRequest=(id)=>db.prepare('SELECT * FROM connection_requests WHERE id=?').get(Number(id))||null;
  const getPendingConnectionRequest=(guildId,senderId,recipientId)=>db.prepare("SELECT * FROM connection_requests WHERE guild_id=? AND sender_id=? AND recipient_id=? AND status='pending' ORDER BY id DESC LIMIT 1").get(requiredId(guildId,'guild id'),requiredId(senderId,'sender id'),requiredId(recipientId,'recipient id'))||null;
  const setConnectionRequestStatus=(id,status,{actorId=null}={})=>{if(!REQUEST_STATUSES.has(status))throw new TypeError('Invalid request status');const request=getConnectionRequest(id);if(!request) return null;if(actorId!=null)requiredId(actorId,'actor id');if(actorId&&actorId!==request.recipient_id&&actorId!==request.sender_id)throw new RangeError('Not a participant');if(request.status!=='pending')throw new RangeError('Request is already resolved');if(status==='accepted'||status==='declined')if(actorId&&actorId!==request.recipient_id)throw new RangeError('Only recipient may respond');if(status==='cancelled')if(actorId&&actorId!==request.sender_id)throw new RangeError('Only sender may cancel');db.prepare('UPDATE connection_requests SET status=?,responded_at=CURRENT_TIMESTAMP WHERE id=?').run(status,Number(id));return getConnectionRequest(id);};
  const listConnectionRequests=(guildId,userId,{direction='incoming',status='pending',limit=25,offset=0}={})=>{if(!['incoming','outgoing','all'].includes(direction))throw new TypeError('Invalid request direction');if(status!=null&&!REQUEST_STATUSES.has(status))throw new TypeError('Invalid request status');const where=['guild_id=?'];const values=[requiredId(guildId,'guild id')];if(direction==='incoming'){where.push('recipient_id=?');values.push(requiredId(userId,'user id'));}else if(direction==='outgoing'){where.push('sender_id=?');values.push(requiredId(userId,'user id'));}else{where.push('(sender_id=? OR recipient_id=?)');values.push(requiredId(userId,'user id'),userId);}if(status){where.push('status=?');values.push(status);}values.push(Math.max(1,Math.min(Number(limit)||25,100)),Math.max(0,Number(offset)||0));return db.prepare(`SELECT * FROM connection_requests WHERE ${where.join(' AND ')} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`).all(...values);};
  const countConnectionRequests=(guildId,senderId,{since=null,status='pending'}={})=>{if(status!=null&&!REQUEST_STATUSES.has(status))throw new TypeError('Invalid request status');let sql='SELECT COUNT(*) AS count FROM connection_requests WHERE guild_id=? AND sender_id=?';const values=[requiredId(guildId,'guild id'),requiredId(senderId,'sender id')];if(status){sql+=' AND status=?';values.push(status);}if(since){sql+=' AND datetime(created_at)>=datetime(?)';values.push(String(since));}return db.prepare(sql).get(...values).count;};
  const getRequestCooldown=(guildId,senderId,recipientId)=>db.prepare('SELECT * FROM connection_requests WHERE guild_id=? AND sender_id=? AND recipient_id=? ORDER BY created_at DESC,id DESC LIMIT 1').get(requiredId(guildId,'guild id'),requiredId(senderId,'sender id'),requiredId(recipientId,'recipient id'))||null;
  const blockUser=(guildId,blockerId,blockedId)=>{ensureGuild(guildId);requiredId(blockerId,'blocker id');requiredId(blockedId,'blocked id');if(blockerId===blockedId)throw new TypeError('Cannot block yourself');db.prepare('INSERT INTO connection_blocks (guild_id,blocker_id,blocked_id) VALUES (?,?,?) ON CONFLICT DO NOTHING').run(guildId,blockerId,blockedId);db.prepare("UPDATE connection_requests SET status='cancelled',responded_at=CURRENT_TIMESTAMP WHERE guild_id=? AND status='pending' AND ((sender_id=? AND recipient_id=?) OR (sender_id=? AND recipient_id=?))").run(guildId,blockerId,blockedId,blockedId,blockerId);return true;};
  const unblockUser=(guildId,blockerId,blockedId)=>db.prepare('DELETE FROM connection_blocks WHERE guild_id=? AND blocker_id=? AND blocked_id=?').run(requiredId(guildId,'guild id'),requiredId(blockerId,'blocker id'),requiredId(blockedId,'blocked id')).changes>0;
  const isBlocked=(guildId,a,b)=>Boolean(db.prepare('SELECT 1 FROM connection_blocks WHERE guild_id=? AND ((blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?))').get(requiredId(guildId,'guild id'),requiredId(a,'user id'),requiredId(b,'user id'),b,a));
  const deleteUserData=db.transaction((guildId,userId)=>{requiredId(guildId,'guild id');requiredId(userId,'user id');db.prepare('DELETE FROM gather_events WHERE guild_id=? AND sender_id=?').run(guildId,userId);db.prepare('DELETE FROM connection_blocks WHERE guild_id=? AND (blocker_id=? OR blocked_id=?)').run(guildId,userId,userId);db.prepare('DELETE FROM connection_requests WHERE guild_id=? AND (sender_id=? OR recipient_id=?)').run(guildId,userId,userId);db.prepare('DELETE FROM tag_members WHERE guild_id=? AND user_id=?').run(guildId,userId);db.prepare('DELETE FROM user_themes WHERE guild_id=? AND user_id=?').run(guildId,userId);db.prepare('DELETE FROM boundaries WHERE guild_id=? AND user_id=?').run(guildId,userId);return db.prepare('DELETE FROM profiles WHERE guild_id=? AND user_id=?').run(guildId,userId).changes>0;});
  const stats=(guildId=null)=>{const suffix=guildId?' WHERE guild_id=?':'';const arg=guildId?[requiredId(guildId,'guild id')]:[];const count=(table)=>db.prepare(`SELECT COUNT(*) AS count FROM ${table}${suffix}`).get(...arg).count;return {guilds:count('guilds'),profiles:count('profiles'),tags:count('tags'),tag_members:count('tag_members'),user_themes:count('user_themes'),boundaries:count('boundaries'),connection_requests:count('connection_requests'),connection_blocks:count('connection_blocks'),gather_events:count('gather_events')};};
  const integrityCheck=()=>db.pragma('integrity_check');
  const backup=(destination=null)=>{if(isMemory)throw new Error('Cannot back up an in-memory database');const target=destination||path.join(backupDir||path.dirname(path.resolve(databasePath)),'backups',`${path.basename(databasePath)}.${new Date().toISOString().replace(/[:.]/g,'-')}.bak`);fs.mkdirSync(path.dirname(path.resolve(target)),{recursive:true});db.pragma('wal_checkpoint(TRUNCATE)');fs.copyFileSync(databasePath,target);return target;};
  const close=()=>db.close();
  const transaction=(work)=>{if(typeof work!=='function')throw new TypeError('transaction work must be a function');return db.transaction(work)();};
  return {db,transaction,ensureGuild,getGuildSettings,updateGuildSettings,getProfile,saveProfile,updatePrivacy,listUserTags,addTag,getTag,removeTag,listTags,searchTags,addUserTag,removeUserTag,setUserTags,discoverProfiles,findGatherCandidates,recordGather,getLastGather,deleteGatherEvent,getTheme,updateTheme,getBoundaries,saveBoundaries,updateBoundariesPrivacy,deleteBoundaries,createConnectionRequest,getConnectionRequest,getPendingConnectionRequest,setConnectionRequestStatus,listConnectionRequests,countConnectionRequests,getRequestCooldown,blockUser,unblockUser,isBlocked,deleteUserData,stats,integrityCheck,backup,close};
}
