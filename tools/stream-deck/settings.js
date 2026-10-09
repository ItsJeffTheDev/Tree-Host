'use strict';
// The deck's settings (deck-config.json: paths, URLs, scene names; edit it to change them) and what it remembers
// between runs (deck-state.json: the power plan to go back to, keep-alive on/off). Both stay on this PC (.gitignore).
const fs = require('fs');
const path = require('path');
const { LOCAL } = require('./system');

const ROOT = path.resolve(__dirname, '..', '..');
const CONFIG_FILE = path.join(__dirname, 'deck-config.json');
const STATE_FILE = path.join(__dirname, 'deck-state.json');

const DEFAULTS = {
  testers: { url: 'http://localhost:8770', data: 'D:\\tree-host-testers' },
  keepAlive: { url: 'https://tree-host.onrender.com/', seconds: 50 },
  obs: {
    exe: 'C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe',
    profile: 'Untitled',
    collection: 'Untitled',
    startScene: 'Starting Soon',
    liveScene: 'Tree Host Live',
    endScene: 'Stream End',
  },
  chrome: {
    exe: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    urls: ['http://localhost:8770/dashboard?streamer=1', 'https://app.restream.io/', 'https://studio.youtube.com/'],
  },
  docker: { exe: 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe' },
  playit: { exe: 'C:\\Program Files\\playit_gg\\bin\\playit.exe' },
  discord: { exe: path.join(LOCAL, 'Discord', 'Update.exe') },
  minecraft: { app: 'Microsoft.4297127D64EC6_8wekyb3d8bbwe!Minecraft' },
  // Closed by Boost PC (turn each on or off on the deck's PC setup tab).
  closeWhenLive: [
    { name: 'Steam', images: ['steam.exe', 'steamwebhelper.exe'], on: true },
    { name: 'Roblox', images: ['RobloxPlayerBeta.exe'], on: true },
    { name: 'OneDrive', images: ['OneDrive.exe'], on: true },
    { name: 'Nearby Share', images: ['nearby_share.exe'], on: true },
    { name: 'Opera', images: ['opera.exe'], on: false },
    { name: 'Microsoft Edge', images: ['msedge.exe'], on: false },
  ],
  stopUbuntuWhenLive: false,
};

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

/** Defaults, with whatever deck-config.json changes on top (one level deep, so new defaults still show up). */
function loadConfig() {
  const saved = readJson(CONFIG_FILE);
  const c = {};
  for (const [k, v] of Object.entries(DEFAULTS)) {
    if (!(k in saved)) c[k] = v;
    else if (v && typeof v === 'object' && !Array.isArray(v)) c[k] = { ...v, ...saved[k] };
    else c[k] = saved[k];
  }
  return c;
}

const config = loadConfig();
const saveConfig = () => fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
if (!fs.existsSync(CONFIG_FILE)) saveConfig();

const state = readJson(STATE_FILE);
const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

// ---------- activity log ----------

const lines = [];
/** level: info, good, warn or error */
function log(msg, level = 'info') {
  lines.push({ t: Date.now(), level, msg });
  if (lines.length > 300) lines.shift();
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

module.exports = { ROOT, config, saveConfig, state, saveState, log, logLines: lines };
