'use strict';
// The crash doctor: reads the end of a server's console after a crash (or a failed start, or a plugin that broke
// while starting) and explains what went wrong in plain words, with the fix. Rules, no guessing.

const RULES = [
  {
    id: 'java-too-old',
    // The last one is Paper's own launcher check ("Minecraft 26.1 and newer requires running the server with Java 25 or above").
    re: /UnsupportedClassVersionError|class file version (\d+)\.0|Unsupported class file major version (\d+)|requires running the server with Java (\d+)/,
    find(m, text) {
      const cv = Number(m[1] || m[2]) || Number((/class file version (\d+)\.0/.exec(text) || [])[1]) || 0;
      const java = Number(m[3]) || (cv ? cv - 44 : null);
      return {
        title: 'Something needs a newer Java',
        detail: `A plugin, mod or the server itself was built for ${java ? `Java ${java}` : 'a newer Java'}, but the server runs an older one.`,
        fix: java ? `Open Settings → Server software and set Java to ${java} (or Auto).` : 'Open Settings → Server software and set Java to Auto.',
        action: { type: 'settings' },
      };
    },
  },
  {
    id: 'missing-dependency',
    re: /Could not load '(?:plugins[\\/])?([^']+?\.jar)'[\s\S]{0,300}?(?:UnknownDependencyException|Unknown\/missing dependency plugins|Unknown dependencies)[^[\n]*\[?([^\]\n]+)\]?/,
    find(m) {
      const deps = m[2].replace(/[[\]]/g, '').split(',').map((s) => s.trim()).filter(Boolean);
      return {
        title: `${m[1].replace(/\.jar$/i, '')} needs ${deps.join(', ')}`,
        detail: `The plugin ${m[1]} can't load without ${deps.length > 1 ? 'these plugins' : 'this plugin'}: ${deps.join(', ')}.`,
        fix: `Install ${deps.join(' and ')} (Plugins → Browse), or remove ${m[1]}.`,
        action: { type: 'install', names: deps, file: m[1] },
      };
    },
  },
  {
    id: 'plugin-failed',
    re: /Error occurred while enabling ([^\s(]+) (?:v?([^\s(]+))?/,
    find(m) {
      return {
        title: `${m[1]} broke while starting`,
        detail: `The plugin ${m[1]}${m[2] ? ` (${m[2]})` : ''} threw an error while the server started, so it isn't working.`,
        fix: `Update ${m[1]} to a version made for this Minecraft version, check its config, or disable it.`,
        action: { type: 'disable', plugin: m[1] },
        warning: true,
      };
    },
  },
  {
    id: 'duplicate-plugin',
    re: /Ambiguous plugin name `([^`']+)'|Ambiguous plugin name '([^']+)'/,
    find(m) {
      const name = m[1] || m[2];
      return { title: `${name} is installed twice`, detail: `Two jars contain the plugin ${name}. Only one can load.`, fix: `Delete the older copy of ${name} in Plugins.`, action: { type: 'plugins' }, warning: true };
    },
  },
  {
    id: 'out-of-memory',
    re: /OutOfMemoryError|ran out of memory|Java heap space/,
    find() {
      return { title: 'The server ran out of memory', detail: 'It needed more memory than its plan has.', fix: 'Remove heavy plugins or mods, lower the view distance, pre-generate the world, or move to a bigger plan.', action: { type: 'billing' } };
    },
  },
  {
    id: 'port-in-use',
    re: /Failed to bind to port|Address already in use|\*\*\*\* FAILED TO BIND TO PORT/,
    find() {
      return { title: "The server's port was busy", detail: 'Something else was using its port when it started (often the previous run still closing).', fix: 'Wait a few seconds and press Start again. If it keeps happening, contact support.' };
    },
  },
  {
    id: 'world-newer',
    re: /No key dimensions in MapLike|saved with a newer version|newer version of Minecraft/,
    find() {
      return { title: 'The world is from a newer Minecraft version', detail: "Minecraft can't open a world in an older version.", fix: 'Switch back to the newer version in Settings → Server software, or restore a backup from before the change.', action: { type: 'settings' } };
    },
  },
  {
    id: 'mod-missing',
    // Fabric/Quilt: "Mod 'Sodium Extra' (sodium-extra) 0.5 requires any version of sodium, which is missing!"
    re: /Mod '([^']+)' \(([\w-]+)\)[^\n]*?requires (?:any version of |version \S+ of |version \S+ or later of )?(?:mod )?'?([\w .-]+?)'?(?: \([\w-]+\))?,? which is missing/,
    find(m) {
      if (/^(fabricloader|fabric-loader|quilt_loader|minecraft|java)$/i.test(m[3])) {
        const what = /minecraft/i.test(m[3]) ? 'a different Minecraft version' : /java/i.test(m[3]) ? 'a newer Java' : 'a newer Fabric loader';
        return { title: `${m[1]} needs ${what}`, detail: `The mod ${m[1]} was made for ${what}.`, fix: /minecraft/i.test(m[3]) ? `Use a ${m[1]} build made for this Minecraft version, or remove it.` : 'Open Settings → Server software and pick the newest build, then start again.', action: { type: 'settings' } };
      }
      return { title: `${m[1]} needs ${m[3]}`, detail: `The mod ${m[1]} can't load without ${m[3]}, which isn't installed.`, fix: `Install ${m[3]} (Mods → Browse), or remove ${m[1]}.`, action: { type: 'install', names: [m[3]] } };
    },
  },
  {
    id: 'mods-incompatible',
    re: /Incompatible mods? (?:found|set)|Some of your mods are incompatible/,
    find() {
      return { title: "Some mods don't work together", detail: 'Fabric found mods that are missing what they need, or clash with each other (the lines above say which).', fix: 'Read the lines just above, then update or remove the mods they name.', action: { type: 'plugins' } };
    },
  },
  {
    id: 'mixin',
    re: /Mixin apply (?:for mod ([\w-]+) )?failed|MixinApplyError[\s\S]{0,200}?mod ([\w-]+)/,
    find(m) {
      const mod = m[1] || m[2];
      return { title: `${mod ? `The mod ${mod}` : 'A mod'} doesn't fit this version`, detail: `${mod || 'A mod'} tried to change Minecraft in a way this version doesn't allow.`, fix: `Update ${mod || 'the mod'} to a build made for this Minecraft version, or remove it.`, action: { type: 'plugins' } };
    },
  },
  {
    id: 'class-missing',
    re: /NoClassDefFoundError: ([\w/$.]+)|ClassNotFoundException: ([\w.$]+)/,
    find(m) {
      const cls = (m[1] || m[2]).replace(/\//g, '.');
      return { title: 'A plugin or mod is missing something it needs', detail: `It looked for ${cls}, which isn't there. Usually it was made for a different server type or version, or needs a library plugin.`, fix: "Check the plugin's page for what it needs and which versions it supports.", action: { type: 'plugins' } };
    },
  },
  {
    id: 'watchdog',
    re: /The server has stopped responding|Watchdog Thread|A single server tick took/,
    find(m, text) {
      // The freeze report shows where the main thread was stuck; a plugin's frames look like "Name.jar//com.example...".
      const after = text.slice(m.index);
      const counts = new Map();
      for (const f of after.matchAll(/([A-Za-z0-9_.+-]+)\.jar\/\//g)) {
        if (/^(paper|purpur|folia|spigot|craftbukkit|server|patched|minecraft|bundler|libraries)/i.test(f[1])) continue;
        counts.set(f[1], (counts.get(f[1]) || 0) + 1);
      }
      const plugin = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      if (plugin) {
        const name = plugin[0].replace(/[-_]\d[\w.+-]*$/, ''); // "Chunky-1.4.10" -> "Chunky"
        return {
          title: `The server froze in ${name}`,
          detail: `A tick took so long that the server stopped responding, and the main thread was stuck inside the plugin ${name} (${plugin[0]}.jar).`,
          fix: `Update ${name}, or turn it off in Plugins and start again to check that it's the cause.`,
          action: { type: 'disable', plugin: name, file: `${plugin[0]}.jar` },
        };
      }
      return { title: 'The server froze', detail: 'A tick took so long that the server stopped responding (often a heavy plugin, huge farms, or generating new chunks).', fix: 'Check the lines above for a plugin name, pre-generate the world (e.g. Chunky), and lower the view distance.' };
    },
  },
  {
    id: 'eula',
    re: /You need to agree to the EULA/,
    find() {
      return { title: 'The Minecraft EULA is not accepted', detail: 'Minecraft refuses to start until you accept its EULA.', fix: 'Tick "I agree to the Minecraft EULA" in Settings, then start again.', action: { type: 'settings' } };
    },
  },
];

/** Findings for the given console lines (newest last), most useful first, without duplicates. */
function diagnose(lines, { memoryExit = false } = {}) {
  const text = lines.join('\n');
  const out = [];
  for (const rule of RULES) {
    const m = rule.re.exec(text);
    if (m) out.push({ id: rule.id, ...rule.find(m, text) });
  }
  if (memoryExit && !out.some((f) => f.id === 'out-of-memory')) out.push({ id: 'out-of-memory', ...RULES.find((r) => r.id === 'out-of-memory').find() });
  // Every plugin that failed to enable, not just the first.
  for (const m of text.matchAll(/Error occurred while enabling ([^\s(]+)/g)) {
    if (!out.some((f) => f.id === 'plugin-failed' && f.action.plugin === m[1])) out.push({ id: 'plugin-failed', ...RULES.find((r) => r.id === 'plugin-failed').find(m) });
  }
  return out.slice(0, 5);
}

module.exports = { diagnose };
