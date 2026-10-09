'use strict';
// A tiny obs-websocket v5 client (built into OBS 28+), using Node's built-in WebSocket: no npm packages.
// The deck reads the port and password from OBS's own settings file, so nothing has to be typed in.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'obs-studio', 'plugin_config', 'obs-websocket', 'config.json');
// Events we care about: scenes (1 << 2), inputs (1 << 3, mute changes) and outputs (1 << 6, streaming started/stopped).
const EVENTS = (1 << 2) | (1 << 3) | (1 << 6);

function readSettings() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    return { enabled: !!c.server_enabled, port: c.server_port || 4455, password: c.auth_required ? c.server_password || '' : '' };
  } catch {
    return null;
  }
}

/** Turns the OBS WebSocket server on (OBS must be closed: it rewrites this file when it exits). */
function enableServer() {
  let c = {};
  try {
    c = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  } catch {}
  if (!c.server_password) {
    c.server_password = crypto.randomBytes(12).toString('base64url');
    c.auth_required = true;
  }
  c.server_enabled = true;
  c.server_port = c.server_port || 4455;
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify(c, null, 4));
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('base64');

class Obs {
  constructor(log) {
    this.log = log;
    this.ws = null;
    this.ready = false;
    this.pending = new Map();
    this.nextId = 1;
    this.state = { scene: null, scenes: [], streaming: false, streamStarted: null, inputs: [], stats: null };
  }

  /** Connects if OBS is running with its WebSocket server on. Safe to call often. */
  connect() {
    if (this.ws) return;
    const s = readSettings();
    if (!s || !s.enabled) return;
    let ws;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${s.port}`, 'obswebsocket.json');
    } catch {
      return;
    }
    this.ws = ws;
    ws.onmessage = (m) => this.onMessage(JSON.parse(m.data), s.password);
    ws.onclose = () => {
      this.ws = null;
      this.ready = false;
      for (const p of this.pending.values()) p.reject(new Error('OBS closed the connection.'));
      this.pending.clear();
    };
    ws.onerror = () => {};
  }

  send(op, d) {
    this.ws.send(JSON.stringify({ op, d }));
  }

  onMessage(msg, password) {
    const { op, d } = msg;
    if (op === 0) {
      // Hello: answer with the password proof if OBS asks for one.
      const id = { rpcVersion: 1, eventSubscriptions: EVENTS };
      if (d.authentication) id.authentication = sha(sha(password + d.authentication.salt) + d.authentication.challenge);
      this.send(1, id);
    } else if (op === 2) {
      this.ready = true;
      this.log('OBS connected: the deck can switch scenes and start the stream.');
      this.refresh().catch(() => {});
    } else if (op === 5) {
      const t = d.eventType;
      if (t === 'CurrentProgramSceneChanged') this.state.scene = d.eventData.sceneName;
      else if (t === 'StreamStateChanged') {
        this.state.streaming = !!d.eventData.outputActive;
        this.state.streamStarted = this.state.streaming ? this.state.streamStarted || Date.now() : null;
      } else if (t === 'InputMuteStateChanged') {
        const i = this.state.inputs.find((x) => x.name === d.eventData.inputName);
        if (i) i.muted = d.eventData.inputMuted;
      } else if (/^Scene(Created|Removed|NameChanged)$/.test(t) || /^Input(Created|Removed|NameChanged)$/.test(t)) this.refresh().catch(() => {});
    } else if (op === 7) {
      const p = this.pending.get(d.requestId);
      if (!p) return;
      this.pending.delete(d.requestId);
      if (d.requestStatus.result) p.resolve(d.responseData || {});
      else p.reject(new Error(d.requestStatus.comment || `OBS refused ${d.requestType}.`));
    }
  }

  request(requestType, requestData) {
    if (!this.ready) return Promise.reject(new Error('OBS is not connected.'));
    const requestId = String(this.nextId++);
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.send(6, { requestType, requestId, requestData });
      setTimeout(() => {
        if (this.pending.delete(requestId)) reject(new Error(`OBS didn't answer ${requestType}.`));
      }, 8000);
    });
  }

  async refresh() {
    const [scenes, stream, inputs] = await Promise.all([this.request('GetSceneList'), this.request('GetStreamStatus'), this.request('GetInputList')]);
    // GetSceneList lists scenes bottom-to-top; the deck shows them in the order OBS's Scenes panel does.
    this.state.scenes = scenes.scenes.map((s) => s.sceneName).reverse();
    this.state.scene = scenes.currentProgramSceneName;
    this.state.streaming = !!stream.outputActive;
    this.state.streamStarted = stream.outputActive ? Date.now() - (stream.outputDuration || 0) : null;
    const audio = inputs.inputs.filter((i) => /wasapi|pulse|coreaudio|audio/i.test(i.inputKind));
    this.state.inputs = await Promise.all(
      audio.map(async (i) => ({ name: i.inputName, muted: (await this.request('GetInputMute', { inputName: i.inputName }).catch(() => ({}))).inputMuted === true })),
    );
  }

  async pollStats() {
    if (!this.ready) return;
    const s = await this.request('GetStats').catch(() => null);
    if (s) {
      this.state.stats = {
        cpu: Math.round(s.cpuUsage),
        fps: Math.round(s.activeFps),
        skippedRender: s.renderSkippedFrames,
        skippedOutput: s.outputSkippedFrames,
        totalOutput: s.outputTotalFrames,
      };
    }
  }

  snapshot() {
    const s = readSettings();
    return { connected: this.ready, serverEnabled: !!(s && s.enabled), ...this.state };
  }
}

module.exports = { Obs, enableServer, readSettings };
