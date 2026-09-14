import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import Database from 'better-sqlite3';
import { restoreDatabaseBootstrap } from '../src/bootstrap-database.js';

test('restores a verified database only when the data directory is empty', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bio-bootstrap-'));
  const sourcePath = path.join(root, 'source.db');
  const dataDir = path.join(root, 'data');
  const source = new Database(sourcePath);
  source.exec('CREATE TABLE marker (value TEXT NOT NULL); INSERT INTO marker VALUES (\'preserved\')');
  source.close();

  const encoded = gzipSync(fs.readFileSync(sourcePath)).toString('base64');
  const messages = [];
  const restored = restoreDatabaseBootstrap({ dataDir, encoded, logger: { info: (message) => messages.push(message) } });
  assert.equal(restored.restored, true);
  assert.equal(messages.length, 1);

  const databasePath = path.join(dataDir, 'bot.db');
  const saved = new Database(databasePath, { readonly: true });
  assert.equal(saved.prepare('SELECT value FROM marker').get().value, 'preserved');
  saved.close();
  const original = fs.readFileSync(databasePath);

  const skipped = restoreDatabaseBootstrap({ dataDir, encoded: 'malformed' });
  assert.deepEqual(skipped, { restored: false, reason: 'database-exists', databasePath });
  assert.deepEqual(fs.readFileSync(databasePath), original);
});

test('rejects malformed bootstrap data without leaving a database behind', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bio-bootstrap-invalid-'));
  assert.throws(() => restoreDatabaseBootstrap({ dataDir, encoded: 'not-base64!' }), /valid base64/);
  assert.equal(fs.existsSync(path.join(dataDir, 'bot.db')), false);
});

test('does not replace a database that appears while the bootstrap is being validated', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bio-bootstrap-race-'));
  const sourcePath = path.join(root, 'source.db');
  const dataDir = path.join(root, 'data');
  const source = new Database(sourcePath);
  source.exec('CREATE TABLE marker (value TEXT NOT NULL)');
  source.close();
  const encoded = gzipSync(fs.readFileSync(sourcePath)).toString('base64');

  const originalLinkSync = fs.linkSync;
  fs.linkSync = (temporaryPath, databasePath) => {
    fs.writeFileSync(databasePath, 'created-by-another-start');
    return originalLinkSync(temporaryPath, databasePath);
  };
  try {
    const result = restoreDatabaseBootstrap({ dataDir, encoded });
    assert.equal(result.reason, 'database-appeared');
    assert.equal(fs.readFileSync(path.join(dataDir, 'bot.db'), 'utf8'), 'created-by-another-start');
  } finally {
    fs.linkSync = originalLinkSync;
  }
});
