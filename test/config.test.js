import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config.js';

test('config requires a bot token and resolves the data directory', () => {
  assert.throws(() => loadConfig({}), /DISCORD_TOKEN/);
  const config = loadConfig({ DISCORD_TOKEN: 'token', DATA_DIR: './persistent' });
  assert.equal(config.token, 'token');
  assert.equal(config.databasePath, path.join(path.resolve('./persistent'), 'bot.db'));
});
