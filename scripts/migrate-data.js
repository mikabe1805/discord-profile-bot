import fs from 'node:fs';
import path from 'node:path';
import { createStore } from '../src/database.js';

const dataDir = path.resolve(process.env.DATA_DIR || './data');
const databasePath = path.join(dataDir, 'bot.db');

if (!fs.existsSync(databasePath)) {
  console.error(`Database not found: ${databasePath}`);
  process.exitCode = 1;
} else {
  const store = createStore({ databasePath, backupDir: path.join(dataDir, 'backups') });
  try {
    const migrations = store.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(({ version }) => version);
    const discoverable = store.db.prepare('SELECT COUNT(*) AS count FROM profiles WHERE discoverable = 1').get().count;
    const result = {
      databasePath,
      bytes: fs.statSync(databasePath).size,
      integrity: store.integrityCheck(),
      migrations,
      stats: store.stats(),
      discoverable,
    };
    console.log(JSON.stringify(result));
    if (!result.integrity.every(({ integrity_check: check }) => check === 'ok')) process.exitCode = 1;
  } finally {
    store.close();
  }
}
