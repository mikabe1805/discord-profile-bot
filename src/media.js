import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { presetForCardArtMarker } from './profile-presets.js';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
]);
const EXTENSIONS = new Set(IMAGE_TYPES.values());
const bundledCardArtDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets', 'profile-presets');

function assertSnowflake(value, label) {
  if (!/^\d{1,24}$/.test(String(value))) {
    throw new Error(`${label} must be a Discord snowflake.`);
  }
  return String(value);
}

function contentType(headers) {
  return headers?.get?.('content-type')?.split(';', 1)[0]?.trim().toLowerCase() || '';
}

function extensionForBytes(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes.length >= 6 && (bytes.subarray(0, 6).equals(Buffer.from('GIF87a')) || bytes.subarray(0, 6).equals(Buffer.from('GIF89a')))) return 'gif';
  if (bytes.length >= 12 && bytes.subarray(0, 4).equals(Buffer.from('RIFF')) && bytes.subarray(8, 12).equals(Buffer.from('WEBP'))) return 'webp';
  return null;
}

async function readBody(response, maxBytes) {
  const chunks = [];
  let size = 0;
  const add = (chunk) => {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new Error('Image is larger than 5 MB.');
    chunks.push(buffer);
  };

  if (response.body?.getReader) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        add(value);
      }
    } finally {
      reader.releaseLock?.();
    }
  } else if (response.body?.[Symbol.asyncIterator]) {
    for await (const chunk of response.body) add(chunk);
  } else if (response.arrayBuffer) {
    add(await response.arrayBuffer());
  } else {
    throw new Error('Image download returned no readable body.');
  }
  return Buffer.concat(chunks);
}

async function realDirectory(directory) {
  await fs.mkdir(directory, { recursive: true });
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Profile image directory is not a safe directory.');
  return fs.realpath(directory);
}

async function removeIfPresent(file) {
  try {
    const stat = await fs.lstat(file);
    if (stat.isDirectory()) throw new Error('Refusing to remove a directory as a profile image.');
    await fs.unlink(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

/**
 * Store profile pictures below a mounted data directory. Stored markers are
 * portable between deploys; Discord receives a freshly attached local file.
 */
export function createMediaStore({ dataDir, fetchImpl = globalThis.fetch, maxBytes = MAX_IMAGE_BYTES, timeoutMs = 15_000 } = {}) {
  if (!dataDir) throw new Error('dataDir is required for profile image storage.');
  if (typeof fetchImpl !== 'function') throw new Error('fetchImpl must be a function.');

  const imageRoot = path.resolve(dataDir, 'profile-images');

  async function guildDirectory(guildId) {
    const guild = assertSnowflake(guildId, 'Guild ID');
    const root = await realDirectory(imageRoot);
    const directory = path.join(root, guild);
    await fs.mkdir(directory, { recursive: true });
    const real = await fs.realpath(directory);
    if (real !== root && !real.startsWith(`${root}${path.sep}`)) throw new Error('Profile image path escapes its storage root.');
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Profile image guild directory is not safe.');
    return { guild, root, directory: real };
  }

  async function save(guildId, userId, attachment) {
    const guild = assertSnowflake(guildId, 'Guild ID');
    const user = assertSnowflake(userId, 'User ID');
    if (!attachment?.url) throw new Error('Choose an image attachment first.');
    const url = new URL(attachment.url);
    if (url.protocol !== 'https:') throw new Error('Profile images must use a secure HTTPS URL.');
    const declaredSize = Number(attachment.size);
    if (Number.isFinite(declaredSize) && declaredSize > maxBytes) throw new Error('Image is larger than 5 MB.');
    const declaredType = String(attachment.contentType || attachment.content_type || '').toLowerCase();
    if (declaredType && !IMAGE_TYPES.has(declaredType)) throw new Error('Use a PNG, JPEG, GIF, or WebP image.');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let bytes;
    try {
      const response = await fetchImpl(url, { signal: controller.signal });
      if (!response?.ok) throw new Error(`Image download failed (${response?.status || 'unknown status'}).`);

      const responseType = contentType(response.headers);
      if (responseType && !IMAGE_TYPES.has(responseType)) throw new Error('Use a PNG, JPEG, GIF, or WebP image.');
      const responseLength = Number(response.headers?.get?.('content-length'));
      if (Number.isFinite(responseLength) && responseLength > maxBytes) throw new Error('Image is larger than 5 MB.');
      bytes = await readBody(response, maxBytes);
    } catch (error) {
      if (controller.signal.aborted) throw new Error('Image download timed out.');
      if (/^Image download failed|^Use a PNG|^Image is larger/.test(error.message)) throw error;
      throw new Error(`Could not download that image: ${error.message}`);
    } finally {
      clearTimeout(timeout);
    }
    const extension = extensionForBytes(bytes);
    if (!extension) throw new Error('That file does not contain a supported image.');

    const { directory } = await guildDirectory(guild);
    const destination = path.join(directory, `${user}.${extension}`);
    const temporary = path.join(directory, `.${user}.${process.pid}.${Date.now()}.upload`);
    try {
      await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, destination);
      await Promise.all([...EXTENSIONS]
        .filter((oldExtension) => oldExtension !== extension)
        .map((oldExtension) => removeIfPresent(path.join(directory, `${user}.${oldExtension}`))));
    } finally {
      await removeIfPresent(temporary);
    }
    return `local:profile-images/${guild}/${user}.${extension}`;
  }

  async function resolve(marker, guildId, userId) {
    if (!marker) return null;
    if (/^https?:\/\//i.test(marker)) return { file: null, url: marker };

    const preset = presetForCardArtMarker(marker);
    if (preset) {
      const file = path.resolve(bundledCardArtDirectory, preset.assetFilename);
      if (!file.startsWith(`${bundledCardArtDirectory}${path.sep}`)) return null;
      try {
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink()) return null;
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
      const extension = path.extname(preset.assetFilename).toLowerCase();
      if (!['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(extension)) return null;
      const name = `profile-preset-${preset.id}${extension}`;
      return { file: { attachment: file, name }, url: `attachment://${name}` };
    }

    const user = assertSnowflake(userId, 'User ID');
    const { guild, root } = await guildDirectory(guildId);
    const match = /^local:profile-images\/(\d{1,24})\/(\d{1,24})\.(png|jpg|gif|webp)$/.exec(marker);
    if (!match || match[1] !== guild || match[2] !== user || !EXTENSIONS.has(match[3])) return null;
    const file = path.resolve(root, match[1], `${match[2]}.${match[3]}`);
    if (!file.startsWith(`${root}${path.sep}`)) return null;
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) return null;
      const real = await fs.realpath(file);
      if (!real.startsWith(`${root}${path.sep}`)) return null;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    const name = `profile-${guild}-${user}.${match[3]}`;
    return { file: { attachment: file, name }, url: `attachment://${name}` };
  }

  async function remove(guildId, userId) {
    const user = assertSnowflake(userId, 'User ID');
    const { directory } = await guildDirectory(guildId);
    await Promise.all([...EXTENSIONS].map((extension) => removeIfPresent(path.join(directory, `${user}.${extension}`))));
  }

  return { save, resolve, remove, imageRoot };
}

export { MAX_IMAGE_BYTES };
