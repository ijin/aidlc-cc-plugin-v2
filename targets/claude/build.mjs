#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = path.join(root, 'targets/claude/plugin');
const out = path.resolve(process.env.AIDLC_OUT_DIR || path.join(root, 'dist/claude'));
const authored = ['skills/aidlc/SKILL.md', 'scripts/aidlc-v2.sh', 'data/legacy-2.1.4.sha256', 'data/legacy-2.1.4.gitignore-block'];
const expected = [...authored, '.claude-plugin/plugin.json', 'data/pins.env'].sort();
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const requireContract = (ok, fix) => { if (!ok) throw new Error(fix); };
export function parseEnv(text) {
  const entries = text.split('\n').filter(l => l && !l.startsWith('#')).map(l => {
    const i = l.indexOf('=');
    requireContract(i > 0, 'Repair KEY=VALUE fields in UPSTREAM.lock');
    return [l.slice(0, i), l.slice(i + 1)];
  });
  requireContract(new Set(entries.map(([k]) => k)).size === entries.length, 'Remove duplicate lock fields');
  return Object.fromEntries(entries);
}
export function pins(lock) {
  return `AIDLC_V2_PINNED_VERSION=${lock.UPSTREAM_VERSION}\nAIDLC_V2_PINNED_TAG=${lock.UPSTREAM_TAG}\nAIDLC_V2_INSTALL_SH_SHA256=${lock.INSTALL_SH_SHA256}\nAIDLC_V2_INSTALL_PS1_SHA256=${lock.INSTALL_PS1_SHA256}\n`;
}
function files(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    requireContract(!e.isSymbolicLink(), `Remove symlink ${prefix}${e.name}`);
    return e.isDirectory() ? files(path.join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`];
  }).sort();
}
function contract() {
  const lock = parseEnv(read('UPSTREAM.lock'));
  for (const key of ['UPSTREAM_REPO', 'UPSTREAM_TAG', 'UPSTREAM_VERSION', 'UPSTREAM_SHA', 'UPSTREAM_DATE', 'UPSTREAM_SIGNER_WORKFLOW', 'INSTALL_SH_SHA256', 'INSTALL_PS1_SHA256', 'CHECKSUMS_SHA256', 'SYNCED_NOTE']) {
    requireContract(lock[key], `Restore ${key} by running sync-upstream.sh`);
  }
  requireContract(lock.UPSTREAM_REPO === 'https://github.com/awslabs/aidlc-workflows.git', 'Restore the upstream repository URL');
  const semver = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(lock.UPSTREAM_TAG);
  requireContract(semver && (!semver[4] || semver[4].split('.').every(s => !/^\d+$/.test(s) || s === '0' || !s.startsWith('0'))), 'Sync a valid v<semver> tag');
  requireContract(lock.UPSTREAM_VERSION === lock.UPSTREAM_TAG.slice(1), 'Sync matching upstream version and tag');
  requireContract(/^[0-9a-f]{40}$/.test(lock.UPSTREAM_SHA), 'Sync the full peeled 40-hex SHA');
  for (const key of ['INSTALL_SH_SHA256', 'INSTALL_PS1_SHA256', 'CHECKSUMS_SHA256']) requireContract(/^[0-9a-f]{64}$/.test(lock[key]), `Sync a valid 64-hex ${key}`);
  requireContract(/^\d{4}-\d{2}-\d{2}$/.test(lock.UPSTREAM_DATE) && !Number.isNaN(Date.parse(lock.UPSTREAM_DATE)) && new Date(lock.UPSTREAM_DATE).toISOString().slice(0, 10) === lock.UPSTREAM_DATE, 'Sync an ISO release date');
  requireContract(/^awslabs\/aidlc-workflows\/\.github\/workflows\/[\w-]+\.yml$/.test(lock.UPSTREAM_SIGNER_WORKFLOW), 'Sync a signer workflow under awslabs/aidlc-workflows/.github/workflows/');
  const pkg = JSON.parse(read('package.json'));
  const marketplace = JSON.parse(read('.claude-plugin/marketplace.json'));
  requireContract(pkg.version === lock.UPSTREAM_VERSION || (pkg.version.startsWith(`${lock.UPSTREAM_VERSION}-p`) && /^\d+$/.test(pkg.version.slice(lock.UPSTREAM_VERSION.length + 2))), 'Set package.json version to the pinned version or its -pN patch');
  requireContract(marketplace.plugins.find(p => p.name === 'aidlc-v2')?.version === pkg.version, 'Set marketplace plugin version to package.json version');
  for (const rel of authored) requireContract(fs.existsSync(path.join(source, rel)), `Restore authored file targets/claude/plugin/${rel}`);
  const skill = fs.readFileSync(path.join(source, authored[0]), 'utf8');
  requireContract(/^name: aidlc\s*$/m.test(skill), 'Restore name: aidlc in SKILL.md');
  for (const mode of ['plan', 'apply']) requireContract(skill.includes(`"${'${CLAUDE_PLUGIN_ROOT}'}/scripts/aidlc-v2.sh" ${mode}`), `Restore helper ${mode} invocation in SKILL.md`);
  const manifest = fs.readFileSync(path.join(source, authored[2]), 'utf8');
  const lines = manifest.endsWith('\n') ? manifest.slice(0, -1).split('\n') : manifest.split('\n');
  const paths = [];
  for (const line of lines) {
    requireContract(/^[0-9a-f]{64}  (\.claude\/[^\0\r]+|\.mcp\.json|\.gitignore)$/.test(line), 'Restore valid sha256 manifest entries');
    const rel = line.slice(66);
    requireContract(!rel.split('/').includes('..') && !path.isAbsolute(rel), 'Remove unsafe paths from legacy manifest');
    paths.push(rel);
  }
  requireContract(new Set(paths).size === paths.length, 'Remove duplicate legacy manifest paths');
  requireContract(paths.length >= 200, 'Restore at least 200 legacy manifest entries');
  requireContract(fs.readFileSync(path.join(source, authored[3]), 'utf8').startsWith('# AI-DLC —'), 'Restore non-empty exact legacy gitignore block');
  const syntax = spawnSync('sh', ['-n', path.join(source, authored[1])], { encoding: 'utf8' });
  requireContract(syntax.status === 0, `Repair helper shell syntax: ${syntax.stderr}`);
  const lint = spawnSync('shellcheck', ['-s', 'sh', path.join(source, authored[1])], { encoding: 'utf8' });
  if (lint.status !== null && lint.status !== 0) console.warn(`WARN: shellcheck\n${lint.stdout}${lint.stderr}`);
  return { lock, pkg };
}
function validate(lock) {
  requireContract(JSON.stringify(files(out)) === JSON.stringify(expected), 'Rebuild dist with exactly the shim file set');
  requireContract(fs.readFileSync(path.join(out, 'data/pins.env'), 'utf8') === pins(lock), 'Rebuild pins.env from UPSTREAM.lock');
  for (const rel of files(out)) requireContract(!fs.readFileSync(path.join(out, rel)).includes(13), `Remove CR bytes from dist/${rel}; enforce LF and rebuild`);
  for (const rel of files(out).filter(p => p.endsWith('.json'))) JSON.parse(fs.readFileSync(path.join(out, rel), 'utf8'));
  const validationHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-validate-'));
  try {
    const env = { ...process.env, HOME: validationHome, CLAUDE_CONFIG_DIR: path.join(validationHome, '.claude'), XDG_CONFIG_HOME: path.join(validationHome, 'config'), XDG_CACHE_HOME: path.join(validationHome, 'cache'), XDG_DATA_HOME: path.join(validationHome, 'data') };
    for (const dir of [out, root]) {
      const result = spawnSync(process.env.CLAUDE_BIN || 'claude', ['plugin', 'validate', dir], { encoding: 'utf8', env });
      if (result.error?.code === 'ENOENT') {
        requireContract(process.env.AIDLC_REQUIRE_CLAUDE_VALIDATE !== '1', 'Install Claude CLI for required plugin validation');
        console.warn('WARN: Claude CLI absent; skipping plugin and marketplace validation');
        break;
      }
      requireContract(result.status === 0, `Fix claude plugin validate failure for ${dir}: ${result.stdout}${result.stderr}`);
    }
  } finally { fs.rmSync(validationHome, { recursive: true, force: true }); }

}
const command = process.argv[2] || 'build';
try {
  if (command === 'clean') fs.rmSync(out, { recursive: true, force: true });
  else {
    requireContract(['build', 'validate'].includes(command), 'Use build, validate, or clean');
    const { lock, pkg } = contract();
    if (command === 'build') {
      fs.rmSync(out, { recursive: true, force: true });
      for (const rel of authored) {
        fs.mkdirSync(path.dirname(path.join(out, rel)), { recursive: true });
        fs.copyFileSync(path.join(source, rel), path.join(out, rel));
      }
      fs.chmodSync(path.join(out, authored[1]), 0o755);
      fs.writeFileSync(path.join(out, 'data/pins.env'), pins(lock));
      fs.mkdirSync(path.join(out, '.claude-plugin'));
      fs.writeFileSync(path.join(out, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'aidlc-v2', version: pkg.version, description: 'Sets up and updates AI-DLC via upstream’s installer, pinned and verified.', author: { name: 'ijin' }, homepage: 'https://github.com/ijin/aidlc-cc-plugin-v2', repository: 'https://github.com/ijin/aidlc-cc-plugin-v2', license: 'MIT-0' }, null, 2) + '\n');
    }
    validate(lock);
    console.log(`Build contract passed (${expected.length} files).`);
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
