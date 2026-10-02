'use strict';
// Runs each Minecraft server in its own Docker container, so customers' plugins and mods can only touch
// their own server folder: no access to the host, other customers' files, or Tree Host's data.
const { spawn } = require('child_process');
const { run } = require('./util');

const NETWORK = 'treehost-net';
// Java images that exist for every major we need (others use the next newer one).
const IMAGES = [8, 11, 17, 21, 25];

const containerName = (id) => `th-${id}`;

function imageFor(major) {
  const m = IMAGES.find((v) => v >= Number(major)) || IMAGES[IMAGES.length - 1];
  return { major: m, image: `eclipse-temurin:${m}-jre` };
}

let availability = null;
/**
 * True when the Docker engine answers. A "yes" is cached; after a "no" you can ask again with fresh=true
 * (Docker Desktop often finishes starting after Tree Host does).
 */
async function available(fresh = false) {
  if (fresh && availability && !(await availability)) availability = null;
  if (!availability) {
    availability = run('docker', ['version', '--format', '{{.Server.Version}}'])
      .then((r) => !!r.stdout.trim())
      .catch(() => false);
  }
  return availability;
}

/** Downloads the Java image the first time it's needed. */
async function ensureImage(image, log) {
  const has = await run('docker', ['image', 'inspect', image]).then(() => true, () => false);
  if (has) return;
  log('Downloading Java for this server (one time only)...');
  await new Promise((resolve, reject) => {
    const p = spawn('docker', ['pull', '-q', image], { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`docker pull ${image} failed: ${err.trim().slice(0, 300)}`))));
  });
}

/** A private network where containers can reach the internet but not each other. */
async function ensureNetwork() {
  const has = await run('docker', ['network', 'inspect', NETWORK]).then(() => true, () => false);
  if (has) return;
  await run('docker', ['network', 'create', '--driver', 'bridge', '-o', 'com.docker.network.bridge.enable_icc=false', NETWORK]).catch(() => {});
}

/**
 * Arguments for `docker run`. The server folder is the only thing mounted; the container's own filesystem
 * is read-only, all Linux capabilities are dropped, and memory, CPU and process count are capped.
 */
function runArgs({ id, dir, port, memLimitMb, cpus, image }) {
  const args = [
    'run', '-i', '--rm', '--init',
    '--name', containerName(id),
    '--label', 'treehost=1',
    '--label', `treehost.server=${id}`,
    '--network', NETWORK,
    // A proxy reaches its owner's servers through the ports they publish on this machine (servers can't reach each other directly).
    '--add-host', 'host.docker.internal:host-gateway',
    '-p', `${port}:${port}/tcp`,
    // Bedrock players (Geyser) use the same port number over UDP.
    '-p', `${port}:${port}/udp`,
    '-m', `${memLimitMb}m`, '--memory-swap', `${memLimitMb}m`,
    '--pids-limit', '1024',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--read-only',
    '--tmpfs', '/tmp:rw,exec,nosuid,size=512m',
    '--log-opt', 'max-size=5m', '--log-opt', 'max-file=1',
    '-e', 'HOME=/tmp',
    '-v', `${dir}:/data`,
    '-w', '/data',
  ];
  if (cpus) args.push('--cpus', String(cpus));
  // Never run as root inside the container. On Linux, files then belong to the same user as Tree Host;
  // Docker Desktop (Windows/macOS) maps file ownership itself, so any normal user works.
  const uid = process.platform === 'linux' && process.getuid ? process.getuid() : 1000;
  const gid = process.platform === 'linux' && process.getgid ? process.getgid() : 1000;
  args.push('--user', `${uid === 0 ? 1000 : uid}:${gid === 0 ? 1000 : gid}`);
  args.push(image);
  return args;
}

function kill(id) {
  return run('docker', ['kill', containerName(id)]).catch(() => {});
}

/** Stops containers left over from a previous run (e.g. after a crash of Tree Host itself). */
async function removeLeftovers(log) {
  const { stdout } = await run('docker', ['ps', '-aq', '--filter', 'label=treehost=1']).catch(() => ({ stdout: '' }));
  const ids = stdout.split(/\s+/).filter(Boolean);
  if (!ids.length) return;
  log(`Stopping ${ids.length} server container(s) left over from the last run...`);
  await run('docker', ['stop', '-t', '30', ...ids]).catch(() => {});
  await run('docker', ['rm', '-f', ...ids]).catch(() => {});
}

/** Memory in MB used by each running server container, keyed by server id. */
async function memoryByServer() {
  const { stdout } = await run('docker', ['stats', '--no-stream', '--format', '{{.Name}}|{{.MemUsage}}|{{.CPUPerc}}']);
  const out = new Map();
  out.cpu = new Map(); // server id -> CPU % (100 = one full core)
  const units = { B: 1 / 1048576, KiB: 1 / 1024, KB: 1 / 1024, MiB: 1, MB: 1, GiB: 1024, GB: 1024 };
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^th-(.+?)\|\s*([\d.]+)\s*([A-Za-z]+)[^|]*\|\s*([\d.]+)%/.exec(line.trim());
    if (m) {
      out.set(m[1], Math.round(Number(m[2]) * (units[m[3]] || 1)));
      out.cpu.set(m[1], Math.round(Number(m[4]) * 10) / 10);
    }
  }
  return out;
}

module.exports = { available, imageFor, ensureImage, ensureNetwork, runArgs, kill, removeLeftovers, memoryByServer, containerName };
