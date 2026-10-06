const fs = require('fs');
const { execSync } = require('child_process');

function versionParts(value) {
  const match = String(value).match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) throw new Error(`Invalid release version: ${value}`);
  return match.slice(1).map(Number);
}

function compare(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

const packagePath = 'package.json';
const indexPath = 'index.html';
const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
const current = versionParts(pkg.version);

const tags = execSync('git tag --sort=-v:refname', { encoding: 'utf8' })
  .split(/\r?\n/)
  .map(x => x.trim())
  .filter(x => /^v\d+\.\d+\.\d+$/.test(x));

if (!tags.length) {
  console.log(`No previous release tag found; keeping ${pkg.version}.`);
  process.exit(0);
}

const latest = tags[0].slice(1);
const latestParts = versionParts(latest);
const relation = compare(current, latestParts);

if (relation < 0) {
  throw new Error(`package.json version ${pkg.version} is older than latest release ${latest}.`);
}

if (relation > 0) {
  console.log(`Version ${pkg.version} is already newer than latest release ${latest}; no bump required.`);
  process.exit(0);
}

const next = `${current[0]}.${current[1]}.${current[2] + 1}`;
pkg.version = next;
fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n');

let html = fs.readFileSync(indexPath, 'utf8');
html = html.replace(/name="application-version" content="[^"]+"/, `name="application-version" content="${next}"`);
html = html.replace(/data-fieldinspect-version="[^"]+"/, `data-fieldinspect-version="${next}"`);
html = html.replace(/FieldInspect release marker: v[^,]+/, `FieldInspect release marker: v${next}`);
fs.writeFileSync(indexPath, html);

console.log(`Automatically bumped FieldInspect Pro ${pkg.version} from ${latest} to ${next}.`);
