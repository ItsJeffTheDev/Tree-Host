'use strict';
// The lag doctor: the crash doctor's sibling for a server that runs but lags. It asks the live server for its TPS and
// tick times, counts entities, dropped items and mobs, and reads memory, CPU, "Can't keep up!" warnings and the view
// distance, then explains what it found in plain words, with the fix. Rules, no guessing.

const WINDOW_MS = 7000; // how long to collect the server's answers

function stripCodes(s) {
  return String(s).replace(/§[0-9a-fk-or]/gi, '');
}

/** Sends the checks to the console and collects the answers. */
function collect(inst, commands) {
  return new Promise((resolve) => {
    const lines = [];
    const onLine = (i, line) => {
      if (i === inst) lines.push(stripCodes(line));
    };
    inst.manager.on('line', onLine);
    for (const c of commands) inst.command(c);
    setTimeout(() => {
      inst.manager.off('line', onLine);
      resolve(lines);
    }, WINDOW_MS);
  });
}

function parse(lines, family) {
  const out = { tps: null, mspt: null, counts: [] };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m = /TPS from last 1m, 5m, 15m: \*?([\d.]+)/i.exec(l);
    if (m) out.tps = Number(m[1]);
    if (/Server tick times/i.test(l)) {
      // Paper prints the numbers on the next line: "◴ 1.4/0.9/4.2, 1.3/0.8/5.0, 1.5/0.7/22.1" (avg/min/max for 5s, 10s, 1m)
      const next = lines[i + 1] || '';
      m = /([\d.]+)\/([\d.]+)\/([\d.]+)/.exec(next);
      if (m) out.mspt = { avg: Number(m[1]), max: Number(m[3]) };
    }
    m = /Test passed, count: (\d+)/.exec(l);
    if (m) out.counts.push(Number(m[1]));
    if (/Test failed/i.test(l)) out.counts.push(0);
  }
  return out;
}

/** Runs the checks on a running server and returns { at, numbers, findings }. */
async function examine(inst) {
  if (inst.kind === 'proxy') throw Object.assign(new Error('Proxies don\'t run worlds: check the servers behind it instead.'), { status: 400 });
  if (!inst.proc || inst.status !== 'running') throw Object.assign(new Error('Start the server first: the lag doctor checks it while it runs.'), { status: 400 });
  const bukkit = inst.provider.family === 'bukkit';
  const commands = [
    ...(bukkit ? ['tps', 'mspt'] : []),
    'execute if entity @e',
    'execute if entity @e[type=item]',
    'execute if entity @e[type=!player,type=!item]',
  ];
  const lines = await collect(inst, commands);
  const r = parse(lines, inst.provider.family);
  const [entities = null, items = null, mobs = null] = r.counts;
  const props = await inst.getProperties();
  const view = Number(props['view-distance']) || 10;
  const sim = Number(props['simulation-distance']) || 10;
  const memMax = Number(inst.cfg.memoryMb) || null;
  const memUsed = inst.memUsedMb || null;
  const cpu = inst.cpuPct == null ? null : inst.cpuPct;
  const plan = inst.manager.planInfo ? inst.manager.planInfo(inst) : null;
  const cpuLimit = (plan && plan.cpus) || null; // cores the plan gives (100% per core)
  const hourAgo = Date.now() - 3600 * 1000;
  const recent = inst.logs.filter((l) => !l.at || l.at > hourAgo).map((l) => stripCodes(l.t));
  const behind = recent.map((l) => /Can't keep up!.*Running (\d+)ms or (\d+) ticks behind/.exec(l)).filter(Boolean);
  const chunky = recent.slice(-300).some((l) => /\[Chunky\].*(Task running|Started|progress|\d+\.\d+%)/i.test(l));
  const players = inst.players.size;

  const findings = [];
  const add = (severity, title, detail, fix, action) => findings.push({ severity, title, detail, fix, ...(action ? { action } : {}) });

  if (r.tps != null && r.tps < 18) add('bad', `The server is running slow (${r.tps.toFixed(1)} TPS)`, 'A healthy server runs 20 ticks a second. Below 18, players see blocks and mobs stutter.', 'See the other findings below for what is using the time.');
  else if (r.tps != null && r.tps < 19.5) add('warn', `Slightly behind (${r.tps.toFixed(1)} TPS)`, 'Close to the 20 it should be; players may notice small hitches.', 'Keep an eye on it, and check the findings below.');
  if (r.mspt && r.mspt.avg > 45) add('bad', `Each tick takes ${r.mspt.avg.toFixed(0)} ms`, 'A tick has to finish in 50 ms to keep 20 TPS. This server is right at the limit, so any extra work makes it lag.', 'Lower the view distance, clear dropped items, and pre-generate the world.');
  else if (r.mspt && r.mspt.max > 150) add('warn', `Lag spikes (a tick took ${r.mspt.max.toFixed(0)} ms)`, 'Most ticks are fine, but some take far too long: usually chunk loading, a big explosion, or a plugin doing heavy work.', 'Pre-generating the world removes most chunk-loading spikes.');
  if (behind.length >= 3) {
    const worst = Math.max(...behind.map((m) => Number(m[1])));
    add('warn', `"Can't keep up!" ${behind.length} times in the last hour`, `Minecraft fell behind by up to ${(worst / 1000).toFixed(1)} seconds.`, 'Usually new chunks being generated or too many entities. Pre-generate the world and lower the view distance.');
  }
  if (memMax && memUsed && memUsed / memMax > 0.9) add('bad', `Memory is almost full (${Math.round(memUsed)} of ${memMax} MB)`, 'Java slows right down when it runs out of room, then the server can crash.', 'Remove heavy plugins or mods, lower the view distance, or move to a bigger plan.', { type: 'billing' });
  if (cpu != null && cpuLimit && cpu >= cpuLimit * 95) add('bad', 'The server is using all of its CPU', `It's at the limit of the ${cpuLimit} CPU core${cpuLimit === 1 ? '' : 's'} its plan has.`, 'Lower the simulation distance and entity counts, or move to a plan with more CPU.', { type: 'billing' });
  if (items != null && items > 400) add('warn', `${items} dropped items on the ground`, 'Every dropped item is checked every tick. Farms that drop items onto the floor are a common cause of lag.', 'Clear them now (button below), and collect farm drops with hoppers.', { type: 'command', command: 'kill @e[type=item]', label: 'Clear dropped items' });
  if (mobs != null && mobs > 1500) add('warn', `${mobs} mobs and other entities`, 'Big mob farms and animal pens make every tick slower.', 'Thin out animal pens and limit mob farms. On Paper, mob caps are in config/paper-world-defaults.yml.');
  if (view > 10) add('warn', `View distance is ${view} chunks`, `Each extra chunk of view distance loads many more chunks per player (${players || 'every'} player${players === 1 ? '' : 's'} online).`, 'Set it to 8 to 10 in Settings → Game settings. Players barely notice the difference.', { type: 'settings' });
  if (sim > 8) add('warn', `Simulation distance is ${sim} chunks`, 'This is how far away mobs, crops and redstone keep running. It costs far more than view distance.', 'Set it to 6 to 8 in Settings → Game settings.', { type: 'settings' });
  if (chunky) add('info', 'The world is being pre-generated', 'Chunky is generating new chunks in the background, which uses a lot of CPU. Some lag while it runs is expected.', 'It goes away when Chunky finishes. Run it while nobody is playing.');
  if (!findings.some((f) => f.severity !== 'info')) add('good', 'No lag found', r.tps != null ? `The server is running at ${r.tps.toFixed(1)} TPS${r.mspt ? `, ${r.mspt.avg.toFixed(0)} ms a tick` : ''}.` : 'Nothing in the checks points at lag right now.', 'If players still report lag, it may be their connection or their own computer: ask them to check their ping.');

  const report = {
    at: Date.now(),
    numbers: { tps: r.tps, mspt: r.mspt, entities, items, mobs, memUsedMb: memUsed, memMaxMb: memMax, cpuPct: cpu, viewDistance: view, simulationDistance: sim, players, cantKeepUp: behind.length },
    findings,
  };
  inst.lagReport = report;
  return report;
}

module.exports = { examine, parse };
