'use strict';
// Zip files without dependencies: write one to a stream (world downloads) and safely unpack one (world uploads).
// Plain zip (no ZIP64), so up to 4 GB and 65,535 files, which covers Minecraft worlds.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  if (zlib.crc32) return zlib.crc32(buf) >>> 0;
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** Every file under each folder (relative names use forward slashes). Skips links and the session lock. */
async function listFiles(root, folders) {
  const out = [];
  const walk = async (abs, rel) => {
    for (const e of await fsp.readdir(abs, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue;
      const a = path.join(abs, e.name);
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) await walk(a, r);
      else if (e.isFile() && e.name !== 'session.lock') out.push({ abs: a, name: r });
    }
  };
  for (const f of folders) await walk(path.join(root, f), f);
  return out;
}

/** Writes a zip of the given folders (inside root) to a writable stream. */
async function writeZip(stream, root, folders) {
  const files = await listFiles(root, folders);
  if (files.length > 65000) throw new Error('Too many files to zip (65,000 at most).');
  const central = [];
  let offset = 0;
  const write = (buf) => new Promise((resolve, reject) => {
    offset += buf.length;
    if (stream.write(buf)) resolve();
    else stream.once('drain', resolve);
    stream.once('error', reject);
  });
  for (const f of files) {
    const st = await fsp.stat(f.abs);
    const data = await fsp.readFile(f.abs);
    const comp = zlib.deflateRawSync(data, { level: 6 });
    const useComp = comp.length < data.length;
    const body = useComp ? comp : data;
    const crc = crc32(data);
    const name = Buffer.from(f.name, 'utf8');
    const { time, date } = dosTime(st.mtime);
    if (offset + body.length > 0xfffffff0) throw new Error('The world is too big to download as one zip (over 4 GB).');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(useComp ? 8 : 0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const at = offset;
    await write(Buffer.concat([local, name, body]));
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(useComp ? 8 : 0, 10);
    c.writeUInt16LE(time, 12);
    c.writeUInt16LE(date, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(at, 42);
    central.push(Buffer.concat([c, name]));
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  await write(Buffer.concat([cd, end]));
  return files.length;
}

/**
 * Unpacks a zip into dest. Refuses paths that try to leave dest ("zip slip"), links, and more than maxBytes in total.
 * Returns the list of extracted relative names.
 */
async function extractZip(zipPath, dest, { maxBytes = 8 * 1024 ** 3 } = {}) {
  const fh = await fsp.open(zipPath, 'r');
  const names = [];
  try {
    const { size } = await fh.stat();
    const tailLen = Math.min(size, 65557);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw Object.assign(new Error("That file isn't a zip."), { status: 400 });
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdOffset === 0xffffffff || count === 0xffff) throw Object.assign(new Error('That zip is too big (over 4 GB). Zip less, or contact support.'), { status: 400 });
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);
    const root = path.resolve(dest);
    let total = 0;
    let p = 0;
    for (let n = 0; n < count && p + 46 <= cd.length; n++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) break;
      const method = cd.readUInt16LE(p + 10);
      const compSize = cd.readUInt32LE(p + 20);
      const rawSize = cd.readUInt32LE(p + 24);
      const nLen = cd.readUInt16LE(p + 28);
      const xLen = cd.readUInt16LE(p + 30);
      const cLen = cd.readUInt16LE(p + 32);
      const extAttr = cd.readUInt32LE(p + 38);
      const lho = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nLen).replace(/\\/g, '/');
      p += 46 + nLen + xLen + cLen;
      if (((extAttr >>> 16) & 0o170000) === 0o120000) continue; // a symlink entry: skip
      const target = path.resolve(root, name);
      if (target !== root && !target.startsWith(root + path.sep)) throw Object.assign(new Error('That zip contains unsafe paths.'), { status: 400 });
      if (name.endsWith('/')) {
        await fsp.mkdir(target, { recursive: true });
        continue;
      }
      total += rawSize;
      if (total > maxBytes) throw Object.assign(new Error('That zip unpacks to more than is allowed.'), { status: 400 });
      const lh = Buffer.alloc(30);
      await fh.read(lh, 0, 30, lho);
      const start = lho + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
      const data = Buffer.alloc(compSize);
      await fh.read(data, 0, compSize, start);
      let out;
      if (method === 0) out = data;
      else if (method === 8) out = zlib.inflateRawSync(data);
      else throw Object.assign(new Error(`That zip uses a compression method we can't read (${method}). Zip it again with the standard tool.`), { status: 400 });
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, out);
      names.push(name);
    }
  } finally {
    await fh.close();
  }
  return names;
}

module.exports = { writeZip, extractZip, crc32 };
