import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import Database from 'better-sqlite3';

const SQLITE_HEADER = Buffer.from('SQLite format 3\0');
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;

export function restoreDatabaseBootstrap({
  dataDir,
  encoded = process.env.BOOTSTRAP_DB_GZIP_BASE64,
  maxBytes = DEFAULT_MAX_BYTES,
  logger = console,
} = {}) {
  if (typeof dataDir !== 'string' || dataDir.length === 0) throw new TypeError('dataDir is required');
  const databasePath = path.join(path.resolve(dataDir), 'bot.db');
  if (fs.existsSync(databasePath)) return { restored: false, reason: 'database-exists', databasePath };

  const payload = encoded?.trim();
  if (!payload) return { restored: false, reason: 'bootstrap-absent', databasePath };
  if (!Number.isInteger(maxBytes) || maxBytes < SQLITE_HEADER.length) throw new TypeError('maxBytes is invalid');
  if (payload.length > maxBytes * 2 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) {
    throw new Error('Database bootstrap is not valid base64');
  }

  let bytes;
  try {
    bytes = gunzipSync(Buffer.from(payload, 'base64'), { maxOutputLength: maxBytes });
  } catch (error) {
    throw new Error('Database bootstrap could not be decompressed', { cause: error });
  }
  if (bytes.length > maxBytes || !bytes.subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER)) {
    throw new Error('Database bootstrap is not a supported SQLite database');
  }

  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const temporaryPath = path.join(path.dirname(databasePath), `.bot.db.bootstrap-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(temporaryPath, bytes, { flag: 'wx', mode: 0o600 });
    const candidate = new Database(temporaryPath, { readonly: true, fileMustExist: true });
    try {
      if (candidate.pragma('integrity_check', { simple: true }) !== 'ok') {
        throw new Error('Database bootstrap failed its SQLite integrity check');
      }
    } finally {
      candidate.close();
    }
    try {
      fs.linkSync(temporaryPath, databasePath);
    } catch (error) {
      if (error?.code === 'EEXIST') return { restored: false, reason: 'database-appeared', databasePath };
      throw error;
    }
    logger.info?.('Restored the verified database bootstrap into the empty data directory.');
    return { restored: true, reason: 'restored', databasePath, bytes: bytes.length };
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
}

export { DEFAULT_MAX_BYTES };
