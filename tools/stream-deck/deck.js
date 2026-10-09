'use strict';
// Tree Host Stream Deck: one window that gets this PC ready to stream Tree Host and runs the stream.
//   Live tab:     "Get ready" starts everything in order (Docker, playit, Tree Host, the bot, keep alive, music,
//                 Discord, OBS, stream tabs, Minecraft), then Start stream, OBS scenes and mutes, Boost PC, Wrap up.
//   PC setup tab: checks that make this PC stream better, each with a fix button.
// Run Stream-Deck.bat in the Tree Host folder. Only this PC can open it: http://127.0.0.1:8790
const http = require('http');
const fs = require('fs');
const path = require('path');
const sys = require('./system');
const { ROOT, config, saveConfig, state, log, logLines } = require('./settings');
const { services, service, refresh, checkDocker, obs, obsControlOn, testerLink } = require('./services');
const tune = require('./tune');

const PORT = Number(process.env.DECK_PORT) || 8790;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const httpError = (status, message) => Object.assign(new Error(message), { status });

// ---------- Get ready / Wrap up ----------

/** The running job, with a line per step so the deck can show its progress. */
let job = null;

function runJob(name, steps) {
  if (job && job.running) throw httpError(409, `Wait for "${job.name}" to finish.`);
  job = { name, running: true, steps: steps.map((s) => ({ id: s.id, name: s.name, state: 'wait', note: '' })) };
  (async () => {
    for (const [i, s] of steps.entries()) {
      const row = job.steps[i];
      row.state = 'doing';
      try {
        const r = (await s.run()) || {};
        row.state = r.state || 'done';
        row.note = r.note || '';
      } catch (e) {
        row.state = 'warn';
        row.note = e.message;
        log(`${s.name}: ${e.message}`, 'error');
      }
    }
  })()
    .catch((e) => log(`${name} stopped: ${e.message}`, 'error'))
    .finally(() => {
      job.running = false;
      job.endedAt = Date.now();
    });
}

/** Waits until the service is on; Docker and Tree Host can take a couple of minutes. */
async function waitUntilOn(s) {
  for (let waited = 0; waited < s.wait; waited += 2) {
    if (s.id === 'docker') await checkDocker();
    await refresh(waited % 10 === 0);
    if (s.state() === 'on') return true;
    await sleep(2000);
  }
  return false;
}

/** One "Get ready" step: start the service if it's off (restart it if it's stuck), then wait for it if needed. */
function prepare(s) {
  return {
    id: s.id,
    name: s.name,
    async run() {
      if (s.id === 'docker') await checkDocker();
      const before = s.state();
      if (before === 'on' || (s.id === 'obs' && before === 'starting')) return { state: 'skip', note: 'Already running' };
      if (before === 'stuck' && s.restart) await s.restart();
      else if (before === 'off') {
        log(`Starting ${s.name}...`);
        await s.start();
      }
      if (s.wait && !(await waitUntilOn(s))) {
        log(`${s.name} is taking longer than usual: carrying on. Check it on the list.`, 'warn');
        return { state: 'warn', note: 'Still starting' };
      }
      return { state: 'done' };
    },
  };
}

function getReady() {
  runJob('Get ready', [
    { id: 'boost', name: 'Boost PC', run: () => tune.boost() },
    ...services.map(prepare),
    {
      id: 'check',
      name: 'Final check',
      async run() {
        await sleep(3000);
        await refresh(true);
        await tune.applyPriorities();
        if (obs.ready && config.obs.startScene && obs.state.scene !== config.obs.startScene && !obs.state.streaming)
          await obs.request('SetCurrentProgramScene', { sceneName: config.obs.startScene }).catch(() => {});
        const off = services.filter((s) => s.state() !== 'on').map((s) => s.name);
        if (off.length) {
          log(`Ready, but check: ${off.join(', ')}.`, 'warn');
          return { state: 'warn', note: `Check ${off.join(', ')}` };
        }
        log('Everything is running. Start the stream when you are ready.', 'good');
      },
    },
  ]);
}

function wrapUp() {
  runJob('Wrap up', [
    {
      id: 'scene',
      name: 'End scene',
      async run() {
        if (!obs.ready || !config.obs.endScene) return { state: 'skip' };
        await obs.request('SetCurrentProgramScene', { sceneName: config.obs.endScene });
        log(`OBS is on "${config.obs.endScene}". Stop the stream when the outro is done.`);
      },
    },
    { id: 'music', name: 'Stop the music', run: () => service('music').stop() },
    { id: 'power', name: 'Normal power', run: () => tune.unboost() },
    {
      id: 'done',
      name: 'Done',
      run: async () => log('Wrapped up. Tree Host, the bot and keep alive keep running; stop them on the list if you want.', 'good'),
    },
  ]);
}

// ---------- the deck's buttons ----------

async function obsAction(id, value) {
  if (id === 'scene') await obs.request('SetCurrentProgramScene', { sceneName: value });
  else if (id === 'mute') await obs.request('ToggleInputMute', { inputName: value });
  else if (id === 'start') {
    await obs.request('StartStream');
    log("You're live!", 'good');
    if (obs.state.scene === config.obs.startScene && config.obs.liveScene) log(`Switch to "${config.obs.liveScene}" when the countdown is done.`);
  } else if (id === 'stop') {
    await obs.request('StopStream');
    log('Stream stopped.', 'good');
  } else throw httpError(400, 'Unknown OBS button.');
  await obs.refresh().catch(() => {});
}

/** Runs a button press. Returns a message to show, or null. */
async function action({ kind, id, value }) {
  switch (kind) {
    case 'get-ready':
      getReady();
      return null;
    case 'wrap-up':
      wrapUp();
      return null;
    case 'boost':
      await (value ? tune.boost() : tune.unboost());
      return null;
    case 'obs':
      await obsAction(id, value);
      return null;
    case 'service': {
      const s = service(id);
      if (!s || !['start', 'stop', 'restart', 'open'].includes(value) || !s[value]) throw httpError(400, 'Unknown button.');
      log(`${s.name}: ${value}`);
      await s[value]();
      setTimeout(() => refresh(true).catch(() => {}), 1500);
      return null;
    }
    case 'fix': {
      if (!tune.fixes[id]) throw httpError(400, 'Unknown fix.');
      const msg = await tune.fixes[id]();
      log(msg, 'good');
      return msg;
    }
    case 'close-app': {
      const app = config.closeWhenLive.find((a) => a.name === id);
      if (!app) throw httpError(400, 'Unknown app.');
      app.on = !!value;
      saveConfig();
      return null;
    }
    case 'ubuntu':
      config.stopUbuntuWhenLive = !!value;
      saveConfig();
      return null;
    case 'tester-link':
      return testerLink() || '';
    default:
      throw httpError(400, 'Unknown button.');
  }
}

function snapshot() {
  return {
    health: sys.health,
    boosted: !!state.boosted,
    services: services.map((s) => ({
      id: s.id,
      name: s.name,
      icon: s.icon,
      about: s.about,
      state: s.state(),
      detail: s.detail(),
      can: ['stop', 'restart', 'open'].filter((k) => s[k]),
    })),
    obs: { ...obs.snapshot(), controlOn: obsControlOn(), favorites: [config.obs.startScene, config.obs.liveScene, config.obs.endScene].filter(Boolean) },
    job,
    checks: tune.checks(obsControlOn()),
    closeWhenLive: config.closeWhenLive.map((a) => ({ name: a.name, on: a.on, running: sys.isRunning(...a.images) })),
    stopUbuntuWhenLive: config.stopUbuntuWhenLive,
    log: logLines.slice(-150),
  };
}

// ---------- background refresh (only while the deck is open) ----------

let lastAsked = 0;
setInterval(async () => {
  if (Date.now() - lastAsked > 20000) return;
  await refresh().catch(() => {});
  await tune.applyPriorities().catch(() => {});
  await tune.readGameMode().catch(() => {});
}, 3000);
sys.readDockerDisk();
setInterval(sys.readDockerDisk, 60000);

// ---------- HTTP ----------

const FILES = {
  '/': [path.join(__dirname, 'deck.html'), 'text/html; charset=utf-8'],
  '/logo.svg': [path.join(ROOT, 'public', 'brand', 'tree-host-icon.svg'), 'image/svg+xml'],
  '/icons.svg': [path.join(ROOT, 'public', 'icons.svg'), 'image/svg+xml'],
};

const server = http.createServer(async (req, res) => {
  const json = (code, body) => res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));
  // Only the deck's own page may use it: no other website can reach it through this PC's browser.
  if (!/^(127\.0\.0\.1|localhost):\d+$/.test(String(req.headers.host || ''))) return res.writeHead(403).end();
  try {
    const { pathname } = new URL(req.url, 'http://deck');
    if (req.method === 'GET' && FILES[pathname]) {
      const [file, type] = FILES[pathname];
      return res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }).end(fs.readFileSync(file));
    }
    if (req.method === 'GET' && pathname === '/api/status') {
      lastAsked = Date.now();
      await refresh();
      return json(200, snapshot());
    }
    if (req.method === 'POST' && pathname === '/api/action') {
      if (req.headers['x-deck'] !== '1') return json(403, { error: 'Forbidden' });
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 10000) return json(413, { error: 'Too big' });
      }
      return json(200, { message: await action(JSON.parse(raw || '{}')) });
    }
    json(404, { error: 'Not found' });
  } catch (e) {
    json(e.status || 400, { error: e.message });
  }
});

server.on('error', (e) => {
  if (e.code !== 'EADDRINUSE') throw e;
  console.log(`The Stream Deck is already running: http://127.0.0.1:${PORT}`);
  process.exit(0);
});
server.listen(PORT, '127.0.0.1', () => {
  log(`Stream Deck ready on http://127.0.0.1:${PORT}`);
  refresh(true).catch(() => {});
});
