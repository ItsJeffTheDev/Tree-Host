'use strict';
// Runs the playit.gg agent inside Honey Host on Linux cloud hosts (e.g. Render), where only the dashboard's
// web port is reachable from the internet. Minecraft players then join through playit tunnels instead.
// Enabled by setting the PLAYIT_SECRET environment variable to a playit agent's secret key.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const { DATA } = require('./paths');
const { download, exists } = require('./util');

const ARCH = { x64: 'amd64', arm64: 'aarch64' }[process.arch];
const URL = `https://github.com/playit-cloud/playit-agent/releases/latest/download/playit-linux-${ARCH}`;

async function startPlayitAgent(secret) {
  if (process.platform !== 'linux' || !ARCH) {
    console.log('  PLAYIT_SECRET is set, but the built-in playit agent only runs on Linux. Install the playit app instead.');
    return null;
  }
  const bin = path.join(DATA, 'bin', 'playit');
  if (!(await exists(bin))) {
    console.log('  Downloading the playit.gg agent...');
    await fsp.mkdir(path.dirname(bin), { recursive: true });
    await download(URL, bin);
    await fsp.chmod(bin, 0o755);
  }
  // Where Honey Host's playit integration looks for the key (so Team → Public game addresses finds it).
  const conf = path.join(process.env.HOME || DATA, '.config', 'playit_gg', 'playit.toml');
  await fsp.mkdir(path.dirname(conf), { recursive: true });
  await fsp.writeFile(conf, `secret_key = "${secret}"\n`, { mode: 0o600 });

  let restarts = 0;
  let child = null;
  process.on('exit', () => child && child.kill());
  const run = () => {
    child = spawn(bin, ['--secret_path', conf, 'start'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const log = (d) => {
      for (const line of String(d).split(/\r?\n/)) if (line.trim()) console.log(`  [playit] ${line.trim()}`);
    };
    child.stdout.on('data', log);
    child.stderr.on('data', log);
    child.on('error', (e) => console.log(`  [playit] could not start: ${e.message}`));
    child.on('exit', (code) => {
      restarts++;
      const delay = Math.min(60, 5 * restarts);
      console.log(`  [playit] agent stopped (exit code ${code}); restarting in ${delay}s`);
      setTimeout(run, delay * 1000);
    });
  };
  run();
}

module.exports = { startPlayitAgent };
