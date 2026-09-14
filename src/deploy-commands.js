import 'dotenv/config';
import { registerCommands } from './register-commands.js';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required to register commands`);
  return value;
}

const mode = process.argv[2] || 'guild';
if (!['guild', 'global'].includes(mode)) {
  throw new Error('Usage: node src/deploy-commands.js [guild|global]');
}

const token = required('DISCORD_TOKEN');
const clientId = required('CLIENT_ID');
const guildId = mode === 'guild' ? required('GUILD_ID') : null;
const count = await registerCommands({ token, clientId, guildId, mode });
console.log(`Registered ${count} ${mode} commands.`);
