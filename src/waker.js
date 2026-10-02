'use strict';
// While a server sleeps, Tree Host listens on its port and speaks just enough of the Minecraft protocol to:
//  - answer the server list ping ("💤 Sleeping - join to wake it up", with the server's icon), and
//  - when someone tries to join, tell them it's waking up and start the real server.
const net = require('net');

function readVarInt(buf, off) {
  let value = 0;
  let shift = 0;
  for (let i = 0; i < 5; i++) {
    if (off + i >= buf.length) return null;
    const b = buf[off + i];
    value |= (b & 0x7f) << shift;
    if (!(b & 0x80)) return [value, off + i + 1];
    shift += 7;
  }
  throw new Error('VarInt too long');
}

function varInt(n) {
  const out = [];
  let v = n >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Buffer.from(out);
}

const str = (s) => {
  const b = Buffer.from(String(s), 'utf8');
  return Buffer.concat([varInt(b.length), b]);
};
const packet = (id, ...parts) => {
  const body = Buffer.concat([varInt(id), ...parts]);
  return Buffer.concat([varInt(body.length), body]);
};

class Waker {
  /**
   * opts: { port, status() -> { motd, favicon (data URL or null), maxPlayers }, onJoin(name) -> string (kick message) }
   */
  constructor(opts) {
    this.opts = opts;
    this.server = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      const server = net.createServer((sock) => this.handle(sock));
      server.on('error', reject);
      server.listen(this.opts.port, '0.0.0.0', () => {
        this.server = server;
        server.removeListener('error', reject);
        server.on('error', () => {});
        resolve();
      });
    });
  }

  close() {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      const s = this.server;
      this.server = null;
      s.close(() => resolve());
      // Let replies that are on their way (like "waking up") reach the player, then drop what's left.
      setTimeout(() => {
        for (const sock of this.sockets || []) sock.destroy();
      }, 1500);
    });
  }

  handle(sock) {
    this.sockets = this.sockets || new Set();
    this.sockets.add(sock);
    sock.setTimeout(10000, () => sock.destroy());
    sock.on('close', () => this.sockets.delete(sock));
    sock.on('error', () => {});
    let buf = Buffer.alloc(0);
    let state = 0;
    let protocol = 0;
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length > 65536) return sock.destroy();
      if (state === 0 && buf[0] === 0xfe) return sock.destroy(); // very old clients' ping
      try {
        for (;;) {
          const len = readVarInt(buf, 0);
          if (!len || buf.length < len[1] + len[0]) return;
          const body = buf.subarray(len[1], len[1] + len[0]);
          buf = buf.subarray(len[1] + len[0]);
          const [id, p] = readVarInt(body, 0);
          if (state === 0 && id === 0) {
            // Handshake: protocol version, address, port, next state (1 = status, 2 = login).
            const [proto, a1] = readVarInt(body, p);
            const [addrLen, a2] = readVarInt(body, a1);
            const [next] = readVarInt(body, a2 + addrLen + 2);
            protocol = proto;
            state = next === 1 ? 1 : 2;
          } else if (state === 1 && id === 0) {
            const st = this.opts.status();
            const json = {
              version: { name: st.versionName || 'Sleeping', protocol },
              players: { max: st.maxPlayers || 20, online: 0, sample: [] },
              description: { text: st.motd },
              ...(st.favicon ? { favicon: st.favicon } : {}),
            };
            sock.write(packet(0, str(JSON.stringify(json))));
          } else if (state === 1 && id === 1) {
            sock.end(packet(1, body.subarray(p, p + 8))); // pong with the same number
          } else if (state === 2 && id === 0) {
            const [nameLen, n1] = readVarInt(body, p);
            const name = body.subarray(n1, n1 + nameLen).toString('utf8').replace(/[^A-Za-z0-9_]/g, '').slice(0, 16);
            const message = this.opts.onJoin(name) || 'Starting the server...';
            sock.end(packet(0, str(JSON.stringify({ text: message }))));
          } else {
            return sock.destroy();
          }
        }
      } catch {
        sock.destroy();
      }
    });
  }
}

module.exports = { Waker };
