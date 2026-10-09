'use strict';
// Everything the deck starts and watches, in the order "Get ready" starts them.
// Each service: state() is on / starting / stuck / off, detail() is the line under its name, and start/stop/restart/open
// are its buttons. wait = seconds "Get ready" waits for it to be on before moving on.
const fs = require('fs');
const path = require('path');
const sys = require('./system');
const { ROOT, config, state, saveState, log } = require('./settings');
const { Obs, readSettings } = require('./obs');

const obs = new Obs(log);
const obsControlOn = () => !!(readSettings() || {}).enabled;

// ---------- Docker: the app can be open while its engine is hung, so ask the engine ----------

const docker = { state: 'off', startedAt: 0 };
async function checkDocker() {
  if (!sys.isRunning('Docker Desktop.exe', 'com.docker.backend.exe')) return (docker.state = 'off');
  const r = await sys.run('docker', ['info', '--format', '{{.ServerVersion}}'], 8000);
  docker.state = r.ok ? 'on' : Date.now() - docker.startedAt < 180000 ? 'starting' : 'stuck';
}
function startDocker() {
  docker.startedAt = Date.now();
  docker.state = 'starting';
  sys.launch(config.docker.exe);
}

// ---------- keep alive: pings the Render demo so it never falls asleep ----------

const keepAlive = { on: false, timer: null, last: null, lastAt: 0, fails: 0 };
async function ping() {
  try {
    const res = await fetch(config.keepAlive.url, { signal: AbortSignal.timeout(30000) });
    keepAlive.last = res.status;
    keepAlive.fails = res.ok ? 0 : keepAlive.fails + 1;
  } catch (e) {
    keepAlive.last = e.name === 'TimeoutError' ? 'timed out' : 'offline';
    keepAlive.fails++;
  }
  keepAlive.lastAt = Date.now();
  if (keepAlive.fails === 3) log(`Keep alive: ${config.keepAlive.url} failed 3 times in a row (${keepAlive.last}).`, 'warn');
}
function setKeepAlive(on) {
  clearInterval(keepAlive.timer);
  Object.assign(keepAlive, { on, timer: on ? setInterval(ping, Math.max(20, config.keepAlive.seconds) * 1000) : null, fails: 0 });
  if (on) ping();
  state.keepAlive = on;
  saveState();
}

// ---------- small helpers ----------

let treeHostUp = false;
const testersScript = () => sys.findScripts(/Start-Testers/i);
const botProcess = () => sys.findScripts(/src[\\/]bot\.js/i, 'node.exe');
const musicProcess = () => sys.findScripts(/player\.ps1/i, 'powershell.exe');
const ago = (t) => `${Math.max(0, Math.round((Date.now() - t) / 1000))}s ago`;

function nowPlaying() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'overlay', 'now-playing.json'), 'utf8'));
    return j.title ? `${j.title}${j.playing ? '' : ' (paused)'}` : null;
  } catch {
    return null;
  }
}

async function killScripts(list) {
  for (const s of list) await sys.kill(s.pid);
}

const openChrome = (urls) => sys.launch(config.chrome.exe, ['--new-window', ...urls]);

// ---------- the services ----------

const services = [
  {
    id: 'docker',
    name: 'Docker',
    icon: 'box',
    about: 'Runs every Minecraft server in its own isolated container.',
    wait: 180,
    state: () => docker.state,
    detail: () => ({ on: 'Engine running', starting: 'Starting (can take 2 minutes)', stuck: 'Not answering: press Restart', off: 'Not running' })[docker.state],
    start: startDocker,
    async restart() {
      log('Restarting Docker Desktop...');
      await sys.killImage('Docker Desktop.exe');
      await sys.killImage('com.docker.backend.exe');
      await sys.run('wsl.exe', ['--terminate', 'docker-desktop'], 30000);
      startDocker();
    },
  },
  {
    id: 'playit',
    name: 'playit.gg',
    icon: 'link',
    about: 'Public join addresses without opening router ports, so your home IP stays off stream.',
    state: () => (sys.isRunning('playitd.exe', 'playit.exe') ? 'on' : 'off'),
    detail: () => {
      const n = sys.pids('playitd.exe').length;
      return n ? `${n} agent${n === 1 ? '' : 's'} running` : sys.isRunning('playit.exe') ? 'Tray app running' : 'Not running';
    },
    start: () => sys.launch(config.playit.exe),
  },
  {
    id: 'treehost',
    name: 'Tree Host',
    icon: 'tree',
    about: 'The stream site: tester dashboard, overlays, playit addresses and the public link (Start-Testers.bat).',
    wait: 120,
    state: () => (treeHostUp ? 'on' : testersScript().length ? 'starting' : 'off'),
    detail: () => (treeHostUp ? 'Stream site and overlays ready' : testersScript().length ? 'Starting the site and its tunnel' : 'Not running'),
    start: () => sys.launchBat(path.join(ROOT, 'Start-Testers.bat'), 'Tree Host testers'),
    open: () => openChrome([`${config.testers.url}/dashboard?streamer=1`]),
  },
  {
    id: 'bot',
    name: 'Discord bot',
    icon: 'terminal',
    about: 'Tickets, verification and go-live posts in the Tree Host Discord.',
    state: () => (botProcess().length ? 'on' : sys.findScripts(/Start-Bot\.bat/i).length ? 'starting' : 'off'),
    detail: () => (botProcess().length ? 'Online' : 'Not running'),
    start: () => sys.launchBat(path.join(ROOT, 'discord-bot', 'Start-Bot.bat'), 'Tree Host Discord bot'),
    async stop() {
      // Stop the window first: Start-Bot.bat restarts the bot if only node is stopped.
      await killScripts(sys.findScripts(/Start-Bot\.bat/i, 'cmd.exe'));
      await killScripts(botProcess());
    },
  },
  {
    id: 'keepalive',
    name: 'Keep alive',
    icon: 'pulse',
    about: `Pings the Render demo every ${config.keepAlive.seconds} seconds so it never falls asleep.`,
    state: () => (!keepAlive.on ? 'off' : keepAlive.fails >= 3 ? 'stuck' : 'on'),
    detail: () => (!keepAlive.on ? 'Off' : keepAlive.lastAt ? `Last ping ${keepAlive.last}, ${ago(keepAlive.lastAt)}` : 'Pinging'),
    start: () => setKeepAlive(true),
    stop: () => setKeepAlive(false),
  },
  {
    id: 'music',
    name: 'Stream music',
    icon: 'sparkle',
    about: 'Original Tree Host tracks (safe on Twitch and YouTube) and the now-playing overlay.',
    state: () => (musicProcess().length ? 'on' : 'off'),
    detail: () => (musicProcess().length ? nowPlaying() || 'Playing' : 'Off'),
    start: () => sys.launchBat(path.join(ROOT, 'promo', 'stream-music', 'Play-Stream-Music.bat'), 'Tree Host Stream Music'),
    async stop() {
      await killScripts(sys.findScripts(/Play-Stream-Music\.bat/i, 'cmd.exe'));
      await killScripts(musicProcess());
    },
  },
  {
    id: 'discord',
    name: 'Discord',
    icon: 'discord',
    about: 'Chat with your community and staff while you are live.',
    state: () => (sys.isRunning('Discord.exe') ? 'on' : 'off'),
    detail: () => (sys.isRunning('Discord.exe') ? 'Running' : 'Not running'),
    start: () => sys.launch(config.discord.exe, ['--processStart', 'Discord.exe']),
  },
  {
    id: 'obs',
    name: 'OBS',
    icon: 'video',
    about: 'Scenes, overlays and the stream itself.',
    wait: 60,
    state: () => {
      if (!sys.isRunning('obs64.exe')) return 'off';
      return obs.ready || !obsControlOn() ? 'on' : 'starting';
    },
    detail: () => {
      if (!sys.isRunning('obs64.exe')) return 'Not running';
      if (!obsControlOn()) return 'Running · deck control is off (see PC setup)';
      if (!obs.ready) return 'Connecting';
      const s = obs.state.stats;
      return [obs.state.scene, s && `${s.fps} fps`, s && `OBS CPU ${s.cpu}%`].filter(Boolean).join(' · ');
    },
    start() {
      const args = ['--profile', config.obs.profile, '--collection', config.obs.collection, '--disable-shutdown-check'];
      if (config.obs.startScene) args.push('--scene', config.obs.startScene);
      sys.launch(config.obs.exe, args);
    },
  },
  {
    id: 'chrome',
    name: 'Stream tabs',
    icon: 'globe',
    about: 'Opens the dashboard (streamer mode), Restream and YouTube Studio in Chrome.',
    state: () => (state.tabsOpenedAt && Date.now() - state.tabsOpenedAt < 12 * 3600000 && sys.isRunning('chrome.exe') ? 'on' : 'off'),
    detail: () => (state.tabsOpenedAt && sys.isRunning('chrome.exe') ? `Opened ${new Date(state.tabsOpenedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : `${config.chrome.urls.length} tabs`),
    start() {
      openChrome(config.chrome.urls);
      state.tabsOpenedAt = Date.now();
      saveState();
    },
  },
  {
    id: 'minecraft',
    name: 'Minecraft',
    icon: 'blocks',
    about: 'The Minecraft Launcher (Java Edition).',
    state: () => (sys.isRunning('javaw.exe') ? 'on' : sys.isRunning('Minecraft.exe', 'MinecraftLauncher.exe') ? 'starting' : 'off'),
    detail: () => (sys.isRunning('javaw.exe') ? 'In game' : sys.isRunning('Minecraft.exe', 'MinecraftLauncher.exe') ? 'Launcher open' : 'Not running'),
    start: () => sys.launch('explorer.exe', [`shell:AppsFolder\\${config.minecraft.app}`]),
  },
];
const service = (id) => services.find((s) => s.id === id);

// ---------- keeping the picture fresh ----------

let lastQuick = 0;
let lastSlow = 0;
/** Quick checks every call (program list, health, OBS); slow ones (scripts, Docker engine) every 15 s or when forced. */
async function refresh(full = false) {
  if (!full && Date.now() - lastQuick < 2500) return;
  lastQuick = Date.now();
  const slow = full || Date.now() - lastSlow > 15000;
  if (slow) lastSlow = Date.now();
  await Promise.all([sys.readImages(), sys.readHealth(), slow ? sys.readScripts() : null]);
  await Promise.all([
    slow ? checkDocker() : null,
    sys.httpOk(config.testers.url).then((ok) => (treeHostUp = ok)),
    obs.pollStats(),
  ]);
  if (sys.isRunning('obs64.exe')) obs.connect();
}

function testerLink() {
  try {
    const m = fs.readFileSync(path.join(config.testers.data, 'links.txt'), 'utf8').match(/https:\/\/\S+\?code=\S+/);
    return m ? m[0] : null;
  } catch {
    return null;
  }
}

if (state.keepAlive) setKeepAlive(true);

module.exports = { services, service, refresh, checkDocker, obs, obsControlOn, testerLink };
