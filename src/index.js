import 'dotenv/config';
import { createBot } from './app.js';
import { loadConfig } from './config.js';
import { createStore } from './database.js';
import { createMediaStore } from './media.js';
import { registerCommands } from './register-commands.js';

const config = loadConfig();
const store = createStore({ databasePath: config.databasePath });
const integrity = store.integrityCheck();
if (integrity.some((row) => row.integrity_check !== 'ok')) {
  store.close();
  throw new Error(`SQLite integrity check failed: ${JSON.stringify(integrity)}`);
}

const media = createMediaStore({ dataDir: config.dataDir });
const client = createBot({ store, media });
let closing = false;

async function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`Received ${signal}; closing Bio cleanly.`);
  client.destroy();
  store.close();
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await client.login(config.token);
  if (process.argv.includes('--register-commands') && config.clientId && config.guildId) {
    try {
      const count = await registerCommands({ token: config.token, clientId: config.clientId, guildId: config.guildId });
      console.log(`Registered ${count} guild commands.`);
    } catch (error) {
      console.error('Command registration failed; Bio will stay online with the previously registered commands.', error);
    }
  } else if (process.argv.includes('--register-commands')) {
    console.warn('CLIENT_ID or GUILD_ID is missing; skipped command registration.');
  }
} catch (error) {
  store.close();
  throw error;
}
