'use strict';
// Free public HTTPS address for the dashboard via a Cloudflare "quick tunnel" (no account needed).
const fsp = require('fs').promises;
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const EventEmitter = require('events');
const { DATA } = require('./paths');
const { download, exists } = require('./util');

const RELEASES = 'https://github.com/cloudflare/cloudflared/releases/latest/download/';

function assetName() {
  if (process.platform === 'win32') return 'cloudflared-windows-amd64.exe';
  if (process.platform === 'linux') return process.arch === 'arm64' ? 'cloudflared-linux-arm64' : 'cloudflared-linux-amd64';
  return null;
}

class Tunnel extends EventEmitter {
  constructor() {
    super();
    this.url = null;
    this.proc = null;
    this.stopped = false;
  }

  async ensureBinary() {
    const asset = assetName();
    if (!asset) throw new Error(`The automatic tunnel is not supported on ${process.platform}. Install cloudflared yourself.`);
    const bin = path.join(DATA, 'bin', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
    if (!(await exists(bin))) {
      console.log('  Downloading cloudflared (Cloudflare tunnel)...');
      await download(RELEASES + asset, bin);
      if (process.platform !== 'win32') await fsp.chmod(bin, 0o755);
    }
    return bin;
  }

  async start(port) {
    this.stopped = false;
    const bin = await this.ensureBinary();
    const run = () => {
      const proc = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { windowsHide: true });
      this.proc = proc;
      const onLine = (line) => {
        const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(line);
        if (m && m[0] !== this.url) {
          this.url = m[0];
          this.emit('url', this.url);
        }
      };
      readline.createInterface({ input: proc.stdout }).on('line', onLine);
      readline.createInterface({ input: proc.stderr }).on('line', onLine);
      proc.on('error', (e) => console.error(`  Tunnel error: ${e.message}`));
      proc.on('exit', () => {
        this.proc = null;
        this.url = null;
        this.emit('url', null);
        if (!this.stopped) {
          console.log('  Tunnel stopped; restarting in 5 seconds...');
          setTimeout(run, 5000);
        }
      });
    };
    run();
  }

  stop() {
    this.stopped = true;
    if (this.proc) this.proc.kill();
  }
}

module.exports = { Tunnel };
