'use strict';
// Builds test/crashtest-plugin/CrashTest.jar: a plugin that crashes a TEST server on purpose, to try the crash doctor.
//   node test/crashtest-plugin/build.js
// Uses the Spigot API that minecraft-plugin/build.js downloads (run that once first).
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = __dirname;
const LIBS = path.join(os.tmpdir(), 'treehost-plugin-build');
const javaBin = (name) => {
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
};

const api = path.join(LIBS, 'spigot-api.jar');
if (!fs.existsSync(api)) throw new Error('Run node minecraft-plugin/build.js first (it downloads the Spigot API).');
const out = path.join(LIBS, 'crashtest-classes');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
execFileSync(javaBin('javac'), ['--release', '8', '-nowarn', '-Xlint:-options', '-encoding', 'UTF-8', '-cp', api, '-d', out, path.join(ROOT, 'src/online/treehost/crashtest/CrashTest.java')], { stdio: 'inherit' });
fs.copyFileSync(path.join(ROOT, 'src', 'plugin.yml'), path.join(out, 'plugin.yml'));
const jar = path.join(ROOT, 'CrashTest.jar');
fs.rmSync(jar, { force: true });
execFileSync(javaBin('jar'), ['--create', '--file', jar, '-C', out, '.'], { stdio: 'inherit' });
console.log(`Built ${path.relative(process.cwd(), jar)} (${fs.statSync(jar).size} bytes)`);
