import { REST, Routes } from 'discord.js';
import { commandData } from './commands.js';

export async function registerCommands({ token, clientId, guildId = null, mode = 'guild' }) {
  if (!token || !clientId) throw new Error('A Discord token and client ID are required to register commands.');
  if (mode === 'guild' && !guildId) throw new Error('A guild ID is required for guild command registration.');
  if (!['guild', 'global'].includes(mode)) throw new Error('Command mode must be guild or global.');
  const route = mode === 'guild' ? Routes.applicationGuildCommands(clientId, guildId) : Routes.applicationCommands(clientId);
  const rest = new REST({ version: '10' }).setToken(token);
  await rest.put(route, { body: commandData });
  return commandData.length;
}
