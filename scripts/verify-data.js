import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const dataDir = path.resolve(process.env.DATA_DIR || './data');
const databasePath = path.join(dataDir, 'bot.db');

if (!fs.existsSync(databasePath)) {
  console.error(`Database not found: ${databasePath}`);
  process.exitCode = 1;
} else {
  const db = new Database(databasePath, { readonly: true });
  try {
    const integrity = db.pragma('integrity_check', { simple: true });
    const hasTable = (name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
    const migrations = hasTable('schema_migrations') ? db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count : 0;
    const profiles = hasTable('profiles') ? db.prepare('SELECT COUNT(*) AS count FROM profiles').get().count : 0;
    console.log(JSON.stringify({ databasePath, bytes: fs.statSync(databasePath).size, integrity, migrations, profiles }));
    if (integrity !== 'ok') process.exitCode = 1;
  } finally {
    db.close();
  }
}
