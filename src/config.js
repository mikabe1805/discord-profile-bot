import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function loadConfig(env = process.env) {
  const dataDir = path.resolve(env.DATA_DIR?.trim() || path.join(projectRoot, 'data'));
  return {
    token: required(env, 'DISCORD_TOKEN'),
    clientId: env.CLIENT_ID?.trim() || null,
    guildId: env.GUILD_ID?.trim() || null,
    dataDir,
    databasePath: path.join(dataDir, 'bot.db'),
  };
}

export { projectRoot };
