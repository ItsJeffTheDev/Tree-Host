'use strict';
// Making this PC stream as well as it can: Boost PC while live, and the one-time checks on the PC setup tab.
const fs = require('fs');
const path = require('path');
const os = require('os');
const sys = require('./system');
const { config, state, saveState, log } = require('./settings');
const { enableServer } = require('./obs');

const HIGH_PERFORMANCE = '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c';
const BALANCED = '381b4222-f694-41f0-9685-ff5bb260df2e';
const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const WSLCONFIG = path.join(os.homedir(), '.wslconfig');
const obsIni = () => path.join(APPDATA, 'obs-studio', 'basic', 'profiles', config.obs.profile, 'basic.ini');

// ---------- Boost PC ----------

// While boosted: OBS and the game get the CPU first, browsers and chat wait.
const PRIORITY = { 'obs64.exe': 'AboveNormal', 'javaw.exe': 'AboveNormal', 'chrome.exe': 'BelowNormal', 'Discord.exe': 'BelowNormal' };
const prioritized = new Set();

/** Gives new OBS/Minecraft/Chrome/Discord processes their priority (called on every refresh while boosted). */
async function applyPriorities() {
  if (!state.boosted) return;
  const jobs = [];
  for (const [image, level] of Object.entries(PRIORITY)) for (const pid of sys.pids(image)) if (!prioritized.has(pid)) jobs.push([pid, level]);
  if (!jobs.length) return;
  jobs.forEach(([pid]) => prioritized.add(pid));
  await sys.powershell(jobs.map(([pid, level]) => `try { (Get-Process -Id ${pid} -EA Stop).PriorityClass = '${level}' } catch {}`).join('; '));
}

async function boost() {
  const current = (await sys.run('powercfg.exe', ['/getactivescheme'])).stdout.match(/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/i);
  if (current && current[0].toLowerCase() !== HIGH_PERFORMANCE) state.powerScheme = current[0];
  const set = await sys.run('powercfg.exe', ['/setactive', HIGH_PERFORMANCE]);
  log(set.ok ? 'Power plan: High performance.' : "This PC has no High performance power plan; left it as it was.", set.ok ? 'info' : 'warn');

  const closed = [];
  for (const app of config.closeWhenLive.filter((a) => a.on && sys.isRunning(...a.images))) {
    for (const image of app.images) await sys.killImage(image);
    closed.push(app.name);
  }
  if (closed.length) log(`Closed ${closed.join(', ')} to free memory and CPU.`);
  if (config.stopUbuntuWhenLive) {
    await sys.run('wsl.exe', ['--terminate', 'Ubuntu'], 30000);
    log('Stopped the Ubuntu WSL distro (Docker keeps running).');
  }

  state.boosted = true;
  saveState();
  prioritized.clear();
  await sys.readImages();
  await applyPriorities();
  log('Boosted: OBS and Minecraft come first.', 'good');
}

async function unboost() {
  await sys.run('powercfg.exe', ['/setactive', state.powerScheme || BALANCED]);
  state.boosted = false;
  saveState();
  log('Back to the normal power plan.');
}

// ---------- PC setup: checks with a fix button each ----------

const fixes = {
  async quickSync() {
    if (sys.isRunning('obs64.exe')) throw new Error('Close OBS first (it saves its settings when it closes), then press this again.');
    const ini = obsIni();
    if (!fs.existsSync(ini)) throw new Error(`OBS profile "${config.obs.profile}" wasn't found.`);
    fs.copyFileSync(ini, `${ini}.before-stream-deck`);
    let text = fs.readFileSync(ini, 'utf8');
    for (const [k, v] of [['StreamEncoder', 'qsv'], ['RecEncoder', 'qsv'], ['QSVPreset', 'speed']]) text = sys.setIni(text, 'SimpleOutput', k, v);
    fs.writeFileSync(ini, text);
    return 'OBS now encodes on the Intel graphics chip. Your old settings are in basic.ini.before-stream-deck.';
  },
  async obsControl() {
    if (sys.isRunning('obs64.exe')) throw new Error('Close OBS first, then press this again.');
    enableServer();
    return 'OBS control is on: start OBS from the deck and its scenes appear on the Live tab.';
  },
  async wslLimits() {
    if (fs.existsSync(WSLCONFIG)) fs.copyFileSync(WSLCONFIG, `${WSLCONFIG}.before-stream-deck`);
    fs.mkdirSync('D:\\wsl', { recursive: true });
    fs.writeFileSync(
      WSLCONFIG,
      [
        '# Written by the Tree Host Stream Deck: Docker (WSL 2) may use 10 GB of memory and 3 CPU threads at most.',
        '# Your previous file, if any, is .wslconfig.before-stream-deck. Applies after "wsl --shutdown".',
        '[wsl2]',
        'memory=10GB',
        'processors=3',
        'swap=4GB',
        'swapFile=D:\\\\wsl\\\\swap.vhdx',
        '',
        '[experimental]',
        'autoMemoryReclaim=gradual',
        'sparseVhd=true',
        '',
      ].join('\r\n'),
    );
    state.wslPending = true;
    saveState();
    return 'Saved. Press "Restart WSL" when you are not live to apply it.';
  },
  async applyWsl() {
    if (require('./services').obs.state.streaming) throw new Error('Not while you are live: this restarts Docker and its Minecraft servers.');
    log('Restarting WSL with the new limits (Docker restarts too)...');
    await sys.killImage('Docker Desktop.exe');
    await sys.run('wsl.exe', ['--shutdown'], 60000);
    state.wslPending = false;
    saveState();
    require('./services').service('docker').start();
    return 'WSL restarted with the new limits. Docker is starting again.';
  },
  async dockerSettings() {
    sys.launch(config.docker.exe);
    return 'In Docker Desktop: Settings → Resources → Advanced → Disk image location → pick a folder on D:, then Apply & restart.';
  },
  async gameMode() {
    sys.openSettings('gaming-gamemode');
    return 'Turn Game Mode on.';
  },
  async startupApps() {
    sys.openSettings('startupapps');
    return 'Turn off apps you don\'t need when Windows starts (Steam, Roblox, Opera, Edge...).';
  },
};

let gameModeOn = null;
let gameModeAt = 0;
async function readGameMode() {
  if (Date.now() - gameModeAt < 60000) return;
  gameModeAt = Date.now();
  const r = await sys.run('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\GameBar', '/v', 'AutoGameModeEnabled']);
  gameModeOn = !/AutoGameModeEnabled\s+REG_DWORD\s+0x0\b/.test(r.stdout); // on unless explicitly turned off
}

/** The PC setup checklist. ok: true (done), false (needs fixing), null (a tip to check yourself). */
function checks(obsControlOn) {
  const h = sys.health;
  let encoder = 'unknown';
  try {
    const m = fs.readFileSync(obsIni(), 'utf8').match(/^StreamEncoder=(.*)$/m);
    if (m) encoder = m[1].trim();
  } catch {}
  const wsl = fs.existsSync(WSLCONFIG) && /^\s*memory\s*=/m.test(fs.readFileSync(WSLCONFIG, 'utf8'));
  const cpu = os.cpus()[0];
  const i7 = cpu && cpu.model.match(/i7-[4-9]\d{3}\w*/);

  return [
    {
      id: 'encoder',
      ok: encoder !== 'x264' && encoder !== 'unknown',
      title: 'OBS encodes on the graphics chip',
      detail: encoder === 'x264' ? 'OBS uses the CPU (x264), the same 4 threads Minecraft and Docker need. Quick Sync uses the Intel graphics chip instead.' : `Stream encoder: ${encoder}.`,
      fix: { id: 'quickSync', label: 'Use Quick Sync' },
    },
    {
      id: 'obs',
      ok: obsControlOn,
      title: 'The deck can control OBS',
      detail: obsControlOn ? 'Scenes, mutes and Start stream work from the Live tab.' : 'Turns on OBS\'s built-in WebSocket server so the deck can switch scenes and start the stream.',
      fix: { id: 'obsControl', label: 'Turn on' },
    },
    {
      id: 'wsl',
      ok: wsl && !state.wslPending,
      title: 'Docker has a memory limit',
      detail: state.wslPending ? 'The limits are saved but not applied yet. Restart WSL when you are not live.' : wsl ? 'Docker (WSL 2) is capped, so it can\'t starve OBS and Minecraft.' : 'Without a limit Docker can take up to half the RAM (16 GB). This caps it at 10 GB and 3 threads, swap on D:.',
      fix: state.wslPending
        ? { id: 'applyWsl', label: 'Restart WSL', confirm: 'This restarts Docker and WSL (Ubuntu too). Minecraft servers running in Docker stop. Only do it when you are not live.' }
        : { id: 'wslLimits', label: 'Set limits' },
    },
    {
      id: 'disk',
      ok: h.cFreeGb === null ? null : h.cFreeGb >= 15,
      title: 'Enough space on C:',
      detail: h.cFreeGb === null ? 'Couldn\'t read C:.' : `${h.cFreeGb} GB free${h.dockerDiskGb ? `; Docker's disk is ${h.dockerDiskGb} GB of it` : ''}. ${h.cFreeGb < 15 ? 'Move Docker\'s disk to D: so C: doesn\'t fill up mid-stream.' : ''}`,
      fix: { id: 'dockerSettings', label: 'Open Docker' },
    },
    {
      id: 'ht',
      ok: i7 && h.threads === 4 ? false : h.threads > 4 ? true : null,
      title: 'All CPU threads are on',
      detail:
        i7 && h.threads === 4
          ? `Windows sees 4 threads, but this ${i7[0]} has 8. Turn on Hyper-Threading in the BIOS: F2 at startup → Performance → Hyper-Thread Control. The biggest free speed-up for this PC.`
          : `${h.threads} threads.`,
    },
    {
      id: 'gamemode',
      ok: gameModeOn,
      title: 'Game Mode is on',
      detail: gameModeOn === false ? 'Windows Game Mode is off.' : 'Windows gives the game and OBS priority over background work.',
      fix: { id: 'gameMode', label: 'Open settings' },
    },
    {
      id: 'startup',
      ok: null,
      title: 'Only what you need starts with Windows',
      detail: 'Steam, Roblox, Opera, Edge and others start with Windows and use memory all stream long.',
      fix: { id: 'startupApps', label: 'Startup apps' },
    },
  ];
}

module.exports = { boost, unboost, applyPriorities, fixes, checks, readGameMode };
