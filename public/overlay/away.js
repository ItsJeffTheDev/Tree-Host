'use strict';
// The "away" scene: a Tree Host terminal typing techy jokes mixed with the real numbers, a rotating excuse, and a
// heartbeat graph. ?name= sets who is away (default Jeff).
(() => {
  const name = (Overlay.params.get('name') || 'Jeff').slice(0, 24);
  document.getElementById('who').textContent = name;

  const WHY = [
    'probably fixing something',
    'definitely not watching cat videos',
    'consulting the ancient documentation',
    'talking to the servers (they listen)',
    'arguing with a semicolon',
    'giving the creepers a stern talking-to',
    'reading chat… slowly… very slowly',
    'pressing the big green button',
    'turning it off and on again',
    'feeding the Docker whales',
  ];
  let w = 0;
  const why = document.getElementById('why');
  setInterval(() => {
    w = (w + 1) % WHY.length;
    why.classList.remove('fade');
    void why.offsetWidth;
    why.classList.add('fade');
    why.textContent = WHY[w];
  }, 6000);

  // Lines the terminal types. Functions get the live numbers (null until the first answer).
  const JOKES = [
    ['ok', 'Watering the servers (they are trees, it is fine)'],
    ['run', 'Reticulating chunks...'],
    ['ok', 'Told the creepers the server room is off-limits'],
    ['run', 'Defragmenting the Nether...'],
    ['ok', 'Converted 1 coffee into 3 hours of uptime'],
    ['warn', 'Docker whale spotted swimming in lava. Moving it.'],
    ['ok', 'Counted every block in the world: lots'],
    ['ok', 'Lag doctor says: drink water, lower your view distance'],
    ['run', 'Planting a new server: sapling... tree... done in 3.2s'],
    ['run', 'Asking playit.gg very nicely for one more address'],
    ['git', 'git commit -m "fixed it (for real this time)"'],
    ['ok', 'Restarted the restart button'],
    ['ok', 'Bribed the TPS with cookies'],
    ['run', 'Updating plugins... the plugin updater updated itself'],
    ['ok', 'Searched the logs for diamonds: found 0, found 3 warnings'],
    ['err', 'sudo make me a sandwich: permission denied (nice try)'],
    ['ok', 'Crash doctor on standby. Nobody panic.'],
    ['run', 'Teaching villagers about server-sent events...'],
    ['ok', 'Backups backed up. The backups of the backups too.'],
    ['warn', 'Enderman took a block from spawn. Filing a report.'],
    ['ok', 'Staff plugin: the STAFF badge is extra shiny today'],
    ['run', 'Compressing the End... it is already pretty empty'],
  ];
  const LIVE = [
    (d) => ['stat', `status: ${d.servers} server${d.servers === 1 ? '' : 's'}, ${d.running} online, ${d.players} player${d.players === 1 ? '' : 's'}`],
    (d) => (d.testSite ? ['stat', `next test server reset in ${Overlay.left(d.testSite.nextResetAt)}`] : null),
    (d) => ['stat', d.running === 1 ? 'the 1 running server is online and happy' : d.running ? `all ${d.running} running servers online and happy` : 'no servers running: be the first, scan the QR code'],
  ];
  const TAG = { ok: ['  OK  ', 'g'], run: ['  ..  ', 'y'], warn: [' WARN ', 'o'], err: [' FAIL ', 'r'], git: [' GIT  ', 'b'], stat: ['STATUS', 'c'] };

  const term = document.getElementById('term');
  let n = 0;
  let order = [];
  const nextLine = () => {
    const d = Overlay.last();
    if (n % 3 === 2 && d) {
      const f = LIVE[Math.floor(Math.random() * LIVE.length)](d);
      if (f) return f;
    }
    if (!order.length) order = JOKES.map((_, i) => i).sort(() => Math.random() - 0.5);
    return JOKES[order.pop()];
  };
  const stamp = () => new Date().toTimeString().slice(0, 8);

  function typeLine() {
    const [kind, text] = nextLine();
    n++;
    const row = document.createElement('div');
    row.className = 'term-line';
    const t = document.createElement('span');
    t.className = 'ts';
    t.textContent = `[${stamp()}] `;
    const tag = document.createElement('span');
    tag.className = `tag ${TAG[kind][1]}`;
    tag.textContent = `[${TAG[kind][0]}]`;
    const msg = document.createElement('span');
    msg.className = 'msg';
    const cur = document.createElement('span');
    cur.className = 'cursor';
    row.append(t, tag, document.createTextNode(' '), msg, cur);
    term.append(row);
    while (term.children.length > 16) term.firstChild.remove();
    let i = 0;
    const tick = () => {
      msg.textContent = text.slice(0, ++i);
      if (i < text.length) setTimeout(tick, 18 + Math.random() * 40);
      else {
        cur.remove();
        setTimeout(typeLine, 900 + Math.random() * 1600);
      }
    };
    tick();
  }
  typeLine();

  // Heartbeat: a calm line that blips now and then (decoration, not a measurement: the real numbers are in the boxes).
  const MOODS = ['vibes: immaculate', 'trees: happy', 'creepers nearby: 0', 'coffee: refilled', 'bugs: squashed', 'uptime: yes'];
  const c = document.getElementById('beat');
  const g = c.getContext('2d');
  const pts = new Array(160).fill(75);
  let phase = 0;
  setInterval(() => {
    phase++;
    let y = 75 + Math.sin(phase / 6) * 3 + (Math.random() - 0.5) * 4;
    const k = phase % 40;
    if (k === 0) y = 30;
    else if (k === 1) y = 122;
    else if (k === 2) y = 55;
    pts.push(y);
    pts.shift();
    g.clearRect(0, 0, c.width, c.height);
    g.strokeStyle = 'rgba(123,234,166,0.15)';
    g.lineWidth = 1;
    for (let x = 0; x < c.width; x += 40) {
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, c.height);
      g.stroke();
    }
    g.strokeStyle = '#7beaa6';
    g.lineWidth = 3;
    g.shadowColor = '#46c37b';
    g.shadowBlur = 12;
    g.beginPath();
    pts.forEach((p, i) => (i ? g.lineTo(i * (c.width / (pts.length - 1)), p) : g.moveTo(0, p)));
    g.stroke();
    g.shadowBlur = 0;
    if (phase % 80 === 0) document.getElementById('tps').textContent = MOODS[(phase / 80) % MOODS.length];
  }, 50);
})();
