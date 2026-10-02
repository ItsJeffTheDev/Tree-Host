'use strict';
// Builds the Tree Host staff plugin (minecraft-plugin/TreeHostStaff.jar) with a JDK's javac and jar tools.
// The jar is committed, so only run this after changing the plugin source:  node minecraft-plugin/build.js
// It compiles for Java 8 against the Spigot 1.13.2 API, so the one jar runs on every Paper/Spigot/Purpur/Folia/
// CraftBukkit server from 1.13 to today.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = __dirname;
const CACHE = path.join(os.tmpdir(), 'treehost-plugin-build');
const REPO = 'https://repo.papermc.io/repository/maven-public';
const LIBS = {
  'spigot-api.jar': `${REPO}/org/spigotmc/spigot-api/1.13.2-R0.1-SNAPSHOT/spigot-api-1.13.2-R0.1-20190423.030901-214.jar`,
  'bungee-chat.jar': `${REPO}/net/md-5/bungeecord-chat/1.13-SNAPSHOT/bungeecord-chat-1.13-20190406.085523-69.jar`,
};

/** javac from JAVA_HOME, or the newest JDK we can find. */
function jdkTool(name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const homes = [process.env.JAVA_HOME].filter(Boolean);
  if (process.platform === 'win32') {
    for (const base of ['C:/Program Files/Java', 'C:/Program Files/Eclipse Adoptium', 'C:/Program Files/Microsoft']) {
      try {
        for (const d of fs.readdirSync(base).sort().reverse()) homes.push(path.join(base, d));
      } catch {}
    }
  }
  for (const h of homes) if (fs.existsSync(path.join(h, 'bin', exe))) return path.join(h, 'bin', exe);
  return name;
}

(async () => {
  fs.mkdirSync(CACHE, { recursive: true });
  for (const [file, url] of Object.entries(LIBS)) {
    const dest = path.join(CACHE, file);
    if (fs.existsSync(dest)) continue;
    console.log(`Downloading ${file}...`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed: ${url} (${res.status})`);
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  }
  const out = path.join(CACHE, 'classes');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const sources = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.java') && sources.push(path.join(d, e.name))));
  walk(path.join(ROOT, 'src'));
  const cp = Object.keys(LIBS).map((f) => path.join(CACHE, f)).join(path.delimiter);
  execFileSync(jdkTool('javac'), ['--release', '8', '-nowarn', '-Xlint:-options', '-encoding', 'UTF-8', '-cp', cp, '-d', out, ...sources], { stdio: 'inherit' });
  fs.copyFileSync(path.join(ROOT, 'src', 'plugin.yml'), path.join(out, 'plugin.yml'));
  const jar = path.join(ROOT, 'TreeHostStaff.jar');
  fs.rmSync(jar, { force: true });
  execFileSync(jdkTool('jar'), ['--create', '--file', jar, '-C', out, '.'], { stdio: 'inherit' });
  console.log(`Built ${path.relative(process.cwd(), jar)} (${fs.statSync(jar).size} bytes)`);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
