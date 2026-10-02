#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-shim-')));
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
let count = 0;
const installerStdinProbe = 'if [ -t 0 ]; then echo tty >> "$STATE/install-stdin"; elif IFS= read -r input; then echo readable >> "$STATE/install-stdin"; else echo eof >> "$STATE/install-stdin"; fi';
const stub = `#!/bin/sh
printf '%s\\n' "$*" >> "$STATE/log"
if [ -t 0 ]; then echo tty >> "$STATE/stdin"; elif IFS= read -r input; then echo readable >> "$STATE/stdin"; else echo eof >> "$STATE/stdin"; fi
if [ "$1" = --version ]; then printf 'aidlc %s (runtime test)\\n' "$(cat "$STATE/version")"; exit 0; fi
previous=''
for arg do
  if [ "$previous" = --project-dir ]; then project=$arg; fi
  if [ "$previous" = --pin ]; then pin=$arg; fi
  previous=$arg
done
case "$*" in *--unpin*) phase=unpin ;; *--pin*) phase=pin ;; *--dry-run*) phase=dry ;; doctor*) phase=doctor ;; *) phase=config ;; esac
scope=real
case "$project" in */rehearsal) scope=scratch ;; esac
if [ "${'${PROBE_LEGACY:-0}'}" = 1 ]; then
  if [ -f "$project/.claude/tools/aidlc-version.ts" ]; then present=present; else present=absent; fi
  printf '%s:%s:%s\\n' "$scope" "$phase" "$present" >> "$STATE/migration-order"
fi
output=$STATE/$phase.output
[ ! -f "$STATE/$scope-$phase.output" ] || output=$STATE/$scope-$phase.output
[ ! -f "$output" ] || cat "$output"
rc=0
[ ! -f "$STATE/$phase.rc" ] || rc=$(cat "$STATE/$phase.rc")
[ ! -f "$STATE/$scope-$phase.rc" ] || rc=$(cat "$STATE/$scope-$phase.rc")
[ "$rc" = 0 ] || exit "$rc"
case "$phase" in pin) printf '%s\\n' "$pin" > "$project/.aidlc-version" ;; unpin) rm -f "$project/.aidlc-version" ;; esac
`;

function fixture() {
  const dir = fs.mkdtempSync(path.join(tmp, 'case-'));
  const plugin = path.join(dir, 'plugin');
  fs.cpSync(path.join(root, 'targets/claude/plugin'), plugin, { recursive: true });
  const project = path.join(dir, 'project');
  const state = path.join(dir, 'state');
  const bin = path.join(dir, 'bin');
  for (const p of [project, state, bin, path.join(dir, 'home')]) fs.mkdirSync(p);
  fs.writeFileSync(path.join(state, 'version'), '2.10.0');
  const stubPath = path.join(dir, 'stub');
  fs.writeFileSync(stubPath, stub, { mode: 0o755 });
  const installer = `#!/bin/sh\n${installerStdinProbe}\nprintf '%s\\n' "$*" >> "$STATE/install-log"\nmkdir -p "$AIDLC_BIN_DIR"\ncp "$STUB" "$AIDLC_BIN_DIR/aidlc"\nchmod 755 "$AIDLC_BIN_DIR/aidlc"\n`;
  const release = path.join(dir, 'releases/v2.10.0');
  fs.mkdirSync(release, { recursive: true });
  fs.writeFileSync(path.join(release, 'install.sh'), installer);
  fs.writeFileSync(path.join(release, 'install.ps1'), 'fake powershell payload\n');
  fs.writeFileSync(path.join(plugin, 'data/pins.env'), `AIDLC_V2_PINNED_VERSION=2.10.0\nAIDLC_V2_PINNED_TAG=v2.10.0\nAIDLC_V2_INSTALL_SH_SHA256=${hash(installer)}\nAIDLC_V2_INSTALL_PS1_SHA256=${hash('fake powershell payload\n')}\n`);
  const env = { ...process.env, PATH: '/usr/bin:/bin', HOME: path.join(dir, 'home'), SHELL: '/bin/sh', STATE: state, STUB: stubPath, AIDLC_BIN_DIR: bin, AIDLC_INSTALL_ROOT: path.join(dir, 'install'), AIDLC_V2_PLATFORM: 'unix', AIDLC_V2_RELEASE_BASE: `file://${path.dirname(release)}`, AIDLC_V2_AIDLC: '', AIDLC_V2_POWERSHELL: '', LOCALAPPDATA: path.join(dir, 'localapp') };
  const run = (args, overrides = {}) => spawnSync(process.env.AIDLC_TEST_SH || 'sh', [path.join(plugin, 'scripts/aidlc-v2.sh'), ...args, '--project', project], { env: { ...env, ...overrides }, input: 'must not reach aidlc\n', encoding: 'utf8' });
  const get = name => fs.existsSync(path.join(state, name)) ? fs.readFileSync(path.join(state, name), 'utf8') : '';
  const write = (rel, text) => { const p = path.join(project, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
  return { dir, plugin, project, state, bin, stubPath, env, run, get, write };
}
function test(name, fn) {
  if(process.env.AIDLC_TEST_FILTER && !new RegExp(process.env.AIDLC_TEST_FILTER).test(name)) return;
  const f = fixture();
  try { fn(f); assert.ok(f.get('stdin').split('\n').filter(Boolean).every(l=>l==='eof'), 'every aidlc invocation receives EOF'); assert.ok(f.get('install-stdin').split('\n').filter(Boolean).every(l=>l==='eof'), 'every installer invocation receives EOF'); count++; console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}`); throw error; }
}
function success(result, code = 0) { assert.equal(result.status, code, result.stdout + result.stderr); }
function existing(f) { f.env.AIDLC_V2_AIDLC = f.stubPath; }
function snapshot(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(e => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? snapshot(p).map(r=>`${e.name}/${r}`) : [`${e.name}:${e.isSymbolicLink() ? fs.readlinkSync(p) : hash(fs.readFileSync(p))}`];
  });
}
function legacy(f) {
  const rows = fs.readFileSync(path.join(f.plugin, 'data/legacy-2.1.4.sha256'), 'utf8').trimEnd().split('\n');
  const result = spawnSync('git', ['archive', 'v2.1.4+up.b61e0ed', 'src'], { cwd: root, maxBuffer: 32 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr?.toString());
  const unpack = path.join(f.dir, 'unpack'); fs.mkdirSync(unpack);
  const tar = spawnSync('tar', ['-xf', '-', '-C', unpack], { input: result.stdout }); assert.equal(tar.status, 0);
  fs.cpSync(path.join(unpack, 'src'), f.project, { recursive: true });
  return rows.map(l=>l.slice(66));
}
try {
  test('bootstrap verifies hash, argv, ordering, off-PATH and stdin', f => {
    const r = f.run(['apply', '--yes']); success(r, 5);
    assert.equal(f.get('install-log'), '--version 2.10.0 --yes --quiet\n'); assert.equal(f.get('install-stdin'), 'eof\n');
    assert.match(r.stdout, new RegExp('export PATH="' + f.bin + ':\\$PATH"'));
    const log = f.get('log').trim().split('\n');
    assert.deepEqual(log.map(l=>l.startsWith('--version') ? 'version' : l.includes('--pin') ? 'pin' : l.includes('--dry-run') ? 'dry' : l.startsWith('doctor') ? 'doctor' : 'config'), ['version', 'pin', 'dry', 'config', 'doctor']);
    assert.ok(!log.join('\n').includes('--force'));
    assert.ok(f.get('stdin').split('\n').filter(Boolean).every(l=>l==='eof'));
  });
  test('hash mismatch refuses installer', f => {
    fs.appendFileSync(path.join(f.dir, 'releases/v2.10.0/install.sh'), '# tampered\n');
    const r = f.run(['apply', '--yes']); success(r, 4); assert.match(r.stderr, /expected .*actual/); assert.equal(f.get('install-log'), ''); assert.equal(f.get('log'), '');
  });
  test('existing CLI used without bootstrap', f => { existing(f); success(f.run(['apply','--yes','--mcp','none'])); assert.equal(f.get('install-log'), ''); assert.match(f.get('log'), /--mcp none/); });
  test('minimum CLI and preview suffix accepted', f => { existing(f); fs.writeFileSync(path.join(f.state,'version'),'2.8.0-preview.20260924.1'); success(f.run(['apply','--yes'])); });
  test('old CLI exits 5 without writes', f => { existing(f); fs.writeFileSync(path.join(f.state,'version'),'2.7.9'); const before=snapshot(f.project); const r=f.run(['apply','--yes']); success(r,5); assert.match(r.stderr,/aidlc update/); assert.deepEqual(snapshot(f.project),before); assert.equal(f.get('install-log'),''); assert.equal(f.get('log'),'--version\n'); });
  test('plan without CLI changes nothing anywhere', f => { const before=snapshot(f.dir); success(f.run(['plan','--check'])); assert.deepEqual(snapshot(f.dir),before); });
  test('legacy plan without CLI shows the static plan, exits 0, changes nothing', f => {
    legacy(f); const before=snapshot(f.dir); const r=f.run(['plan']); success(r);
    assert.match(r.stdout,/Legacy migration: remove 241/); assert.match(r.stdout,/rehearse this migration on a scratch copy/);
    assert.deepEqual(snapshot(f.dir),before); assert.equal(f.get('log'),''); assert.equal(f.get('install-log'),'');
  });
  test('plan previews current CLI and does not pin', f => { existing(f); success(f.run(['plan'])); assert.match(f.get('log'),/--dry-run/); assert.ok(!f.get('log').includes('--pin')); assert.ok(!fs.existsSync(path.join(f.project,'.aidlc-version'))); });
  test('plan conflicts exit 3, relay output, and never force', f => {
    existing(f); fs.writeFileSync(path.join(f.state,'dry.rc'),'4'); fs.writeFileSync(path.join(f.state,'dry.output'),'config conflict .claude/settings.json\n');
    const r=f.run(['plan']); success(r,3); assert.match(r.stdout,/config conflict .claude\/settings.json/); assert.match(r.stderr,/without backup/); assert.ok(!f.get('log').includes('--force'));
  });
  test('plan operational preview failure exits 1 and relays output', f => {
    existing(f); fs.writeFileSync(path.join(f.state,'dry.rc'),'1'); fs.writeFileSync(path.join(f.state,'dry.output'),'runtime unavailable\n');
    const r=f.run(['plan']); success(r,1); assert.match(r.stdout,/runtime unavailable/);
  });
  test('plan off-PATH CLI is informational and exits 0', f => {
    fs.copyFileSync(f.stubPath,path.join(f.bin,'aidlc'));
    const r=f.run(['plan']); success(r); assert.match(r.stdout,/Note: after setup, export PATH=/); assert.ok(!f.get('log').includes('--pin')); assert.ok(!fs.existsSync(path.join(f.project,'.aidlc-version')));
  });
  test('newer project pin blocks plan and apply before any changes', f => {
    existing(f);
    for(const v of ['2.11.0','2.10.1','3.0.0']) {
      f.write('.aidlc-version',v+'\nignored second line\n'); const before=snapshot(f.project);
      for(const args of [['plan'],['apply','--yes']]) {
        const r=f.run(args); success(r,5); assert.ok(r.stderr.includes(`This project is on AI-DLC ${v}, newer than the version this plugin pins (2.10.0). Run upstream's aidlc config directly, or update this plugin.`)); assert.deepEqual(snapshot(f.project),before);
      }
    }
    assert.equal(f.get('log'),''); assert.equal(f.get('install-log'),'');
  });
  test('upstream-managed version chooses higher marker or project pin', f => {
    existing(f); f.write('.claude/tools/data/aidlc-stamp.json','{}');
    for(const [pin,framework,newer] of [['2.10.0','2.11.0','2.11.0'],['2.12.0','2.11.0','2.12.0'],['','2.10.1','2.10.1']]) {
      f.write('.aidlc-version',pin+'\n'); f.write('.claude/tools/aidlc-version.ts',`export const AIDLC_VERSION = "${framework}";\n`);
      for(const args of [['plan'],['apply','--yes']]) { const r=f.run(args); success(r,5); assert.ok(r.stderr.includes(`AI-DLC ${newer}, newer`)); }
    }
    assert.equal(f.get('log'),'');
  });
  test('equal, same-number preview, and numerically older project pins proceed', f => {
    existing(f);
    for(const v of ['2.10.0','2.10.0-preview.20260920.1','2.9.99']) {
      f.write('.aidlc-version',v+'\n'); success(f.run(['plan'])); success(f.run(['apply','--yes']));
    }
  });
  test('stable project refuses the same-number preview pin', f => {
    existing(f); f.write('.aidlc-version','2.10.0\n');
    const p=path.join(f.plugin,'data/pins.env'); fs.writeFileSync(p,fs.readFileSync(p,'utf8').replace('AIDLC_V2_PINNED_VERSION=2.10.0','AIDLC_V2_PINNED_VERSION=2.10.0-preview.20260920.1'));
    for(const args of [['plan'],['apply','--yes']]) success(f.run(args),5);
    assert.equal(f.get('log'),'');
  });
  test('apply requires yes and usage errors are 2', f => { for(const args of [['apply'],['plan','--bad'],['plan','--mcp','invalid'],['apply','--yes','--check']]) success(f.run(args),2); assert.equal(f.get('log'),''); });
  test('legacy removes every pristine manifest file and preserves workspace', f => {
    existing(f); const files=legacy(f); const memory=fs.readFileSync(path.join(f.project,'aidlc/spaces/default/memory/org.md'));
    success(f.run(['apply','--yes'])); for(const rel of files) assert.ok(!fs.existsSync(path.join(f.project,rel)),rel);
    assert.deepEqual(fs.readFileSync(path.join(f.project,'aidlc/spaces/default/memory/org.md')),memory);
  });
  test('legacy rehearsal then real pin and migration, with failed real pin preserving files', f => {
    existing(f); legacy(f); f.env.PROBE_LEGACY='1'; fs.writeFileSync(path.join(f.state,'real-pin.rc'),'1');
    const before=snapshot(f.project); success(f.run(['apply','--yes']),1); assert.deepEqual(snapshot(f.project),before);
    assert.equal(f.get('migration-order'),'scratch:pin:absent\nscratch:dry:absent\nscratch:unpin:absent\nreal:pin:present\n');
    fs.writeFileSync(path.join(f.state,'real-pin.rc'),'0'); fs.writeFileSync(path.join(f.state,'log'),''); fs.writeFileSync(path.join(f.state,'migration-order'),'');
    success(f.run(['apply','--yes'])); assert.equal(f.get('migration-order'),'scratch:pin:absent\nscratch:dry:absent\nscratch:unpin:absent\nreal:pin:present\nreal:dry:absent\nreal:config:absent\nreal:doctor:absent\n');
  });
  test('merged legacy settings conflicts in scratch leave the real project untouched', f => {
    existing(f); legacy(f); f.write('.claude/settings.json','{"model":"sonnet","permissions":{"allow":["custom"]}}\n');
    fs.writeFileSync(path.join(f.state,'scratch-dry.rc'),'4'); fs.writeFileSync(path.join(f.state,'scratch-dry.output'),'config conflict .claude/settings.json\n');
    const before=snapshot(f.project);
    for(const args of [['plan'],['apply','--yes']]) {
      fs.writeFileSync(path.join(f.state,'log'),''); const r=f.run(args); success(r,3); assert.match(r.stdout,/nothing in your project was changed/); assert.deepEqual(snapshot(f.project),before);
      const log=f.get('log'); assert.match(log,/--project-dir .*rehearsal.*--dry-run/); assert.ok(!log.includes(`--project-dir ${f.project}`)); assert.ok(!log.includes('--force'));
      if(args[0]==='apply') assert.match(log,/--unpin --project-dir .*rehearsal/); else assert.ok(!log.includes('--pin'));
    }
  });
  test('later legacy conflict prints a working restore for exactly the migrated paths', f => {
    existing(f); legacy(f);
    for (const args of [['init','-q'],['add','-A','--force'],['-c','user.email=t@t','-c','user.name=t','-c','commit.gpgsign=false','commit','-qm','legacy']]) success(spawnSync('git',['-C',f.project,...args]));
    fs.writeFileSync(path.join(f.state,'real-dry.rc'),'4'); fs.writeFileSync(path.join(f.state,'real-dry.output'),'config conflict .claude/settings.json\n');
    const r=f.run(['apply','--yes']); success(r,3); assert.match(r.stderr,/real migration already removed or stripped/); assert.ok(!r.stderr.includes('git checkout -- .claude .mcp.json .gitignore'));
    const match=r.stderr.match(/listed one per line in (\S+)\./); assert.ok(match, r.stderr); const list=match[1];
    assert.ok(!list.startsWith(f.project)); const paths=fs.readFileSync(list,'utf8').trim().split('\n'); assert.equal(paths.length,241); assert.ok(!paths.some(p=>p.startsWith('aidlc/')));
    const printed=r.stderr.split('\n').find(l=>l.startsWith('  while IFS= read -r f;')); assert.equal(printed,`  while IFS= read -r f; do git checkout HEAD -- "$f" 2>/dev/null; done < "${list}"`);
    assert.ok(!fs.existsSync(path.join(f.project,'.claude/tools/aidlc-version.ts')));
    const restore=spawnSync('sh',['-c',printed],{cwd:f.project,encoding:'utf8'}); success(restore);
    const status=spawnSync('git',['-C',f.project,'status','--porcelain'],{encoding:'utf8'}); assert.equal(status.stdout,'','restore brings back every migrated file');
    assert.ok(!fs.existsSync(path.join(f.project,'.aidlc-version'))); assert.match(r.stdout,/Reverted project pin to none/);
    fs.rmSync(list,{force:true});
  });
  test('strip-only migration later failure reports public copies outside git', f => {
    existing(f); const marker=path.join(f.dir,'legacy-marker'); fs.writeFileSync(marker,'export const AIDLC_VERSION = "2.1.4";\n'); fs.mkdirSync(path.join(f.project,'.claude/tools'),{recursive:true}); fs.symlinkSync(marker,path.join(f.project,'.claude/tools/aidlc-version.ts'));
    const block=fs.readFileSync(path.join(f.plugin,'data/legacy-2.1.4.gitignore-block'),'utf8'); f.write('.gitignore','user\n\n'+block); fs.writeFileSync(path.join(f.state,'real-config.rc'),'4'); fs.writeFileSync(path.join(f.state,'real-config.output'),'config conflict config\n');
    const r=f.run(['apply','--yes']); success(r,3); assert.match(r.stderr,/unmodified copies of public release v2.1.4/); assert.equal(fs.readFileSync(path.join(f.project,'.gitignore'),'utf8'),'user\n'); assert.ok(fs.lstatSync(path.join(f.project,'.claude/tools/aidlc-version.ts')).isSymbolicLink());
  });
  test('legacy modified and symlink files/directories kept, exact suffix stripped', f => {
    existing(f); legacy(f);
    f.write('.claude/CLAUDE.md','user customization\n');
    const outside=path.join(f.dir,'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside,'file'),'outside\n');
    fs.unlinkSync(path.join(f.project,'.claude/settings.json')); fs.symlinkSync(path.join(outside,'file'),path.join(f.project,'.claude/settings.json'));
    fs.renameSync(path.join(f.project,'.claude/knowledge'),path.join(outside,'knowledge')); fs.symlinkSync(path.join(outside,'knowledge'),path.join(f.project,'.claude/knowledge'));
    const outsideBefore=snapshot(outside);
    const block=fs.readFileSync(path.join(f.plugin,'data/legacy-2.1.4.gitignore-block'),'utf8');
    f.write('.gitignore','my-ignore\n\n'+block); f.write('aidlc/custom','memory'); fs.mkdirSync(path.join(f.project,'.claude/user-empty'));
    const plan=f.run(['plan']); success(plan); assert.match(plan.stdout,/CLAUDE.md \(locally modified\)/); assert.match(plan.stdout,/settings.json \(symlink\)/); assert.match(plan.stdout,/outside project/);
    const r=f.run(['apply','--yes']); success(r); assert.equal(fs.readFileSync(path.join(f.project,'.gitignore'),'utf8'),'my-ignore\n'); assert.equal(fs.readFileSync(path.join(f.project,'.claude/CLAUDE.md'),'utf8'),'user customization\n'); assert.deepEqual(snapshot(outside),outsideBefore); assert.equal(fs.readFileSync(path.join(f.project,'aidlc/custom'),'utf8'),'memory'); assert.ok(fs.existsSync(path.join(f.project,'.claude/user-empty')));
  });
  test('nonmatching gitignore remains unchanged', f => { existing(f); legacy(f); f.write('.gitignore','my-ignore\n# AI-DLC — modified\n'); success(f.run(['apply','--yes'])); assert.equal(fs.readFileSync(path.join(f.project,'.gitignore'),'utf8'),'my-ignore\n# AI-DLC — modified\n'); });
  test('empty gitignore prefix becomes empty', f => { existing(f); legacy(f); const block=fs.readFileSync(path.join(f.plugin,'data/legacy-2.1.4.gitignore-block')); f.write('.gitignore',Buffer.concat([Buffer.from('\n\n'),block])); success(f.run(['apply','--yes'])); assert.equal(fs.statSync(path.join(f.project,'.gitignore')).size,0); });
  test('gitignore strip preserves arbitrary prefix bytes', f => {
    existing(f); legacy(f);
    const block=fs.readFileSync(path.join(f.plugin,'data/legacy-2.1.4.gitignore-block'));
    const prefix=Buffer.from([97,0,98,13,10]);
    f.write('.gitignore',Buffer.concat([prefix,Buffer.from('\n\n'),block]));
    success(f.run(['apply','--yes']));
    assert.deepEqual(fs.readFileSync(path.join(f.project,'.gitignore')),prefix);
  });
  test('dry-run conflict maps 4 to 3 and never forces', f => { existing(f); fs.writeFileSync(path.join(f.state,'dry.rc'),'4'); fs.writeFileSync(path.join(f.state,'dry.output'),'config conflict .claude/CLAUDE.md\n'); const r=f.run(['apply','--yes']); success(r,3); assert.match(r.stdout,/conflict/); assert.match(r.stderr,/without backup/); assert.ok(!f.get('log').includes('--force')); assert.ok(!f.get('log').includes('doctor')); });
  test('config conflict maps to 3', f => { existing(f); fs.writeFileSync(path.join(f.state,'config.rc'),'4'); fs.writeFileSync(path.join(f.state,'config.output'),'config conflict config\n'); success(f.run(['apply','--yes']),3); });
  test('pin action required maps to 5', f => { existing(f); fs.writeFileSync(path.join(f.state,'pin.rc'),'5'); success(f.run(['apply','--yes']),5); assert.ok(!f.get('log').includes('--dry-run')); });
  test('operational and doctor errors map to 1', f => { existing(f); fs.writeFileSync(path.join(f.state,'doctor.rc'),'1'); success(f.run(['apply','--yes']),1); fs.writeFileSync(path.join(f.state,'pin.rc'),'4'); success(f.run(['apply','--yes']),1); });
  test('off-PATH apply prioritizes PATH even when doctor fails', f => {
    fs.copyFileSync(f.stubPath,path.join(f.bin,'aidlc')); fs.writeFileSync(path.join(f.state,'doctor.rc'),'1'); fs.writeFileSync(path.join(f.state,'doctor.output'),'hook runtime missing\n');
    const r=f.run(['apply','--yes']); success(r,5); assert.match(r.stdout,/export PATH=/); assert.match(r.stdout,/doctor may report the hook runtime until aidlc is on PATH/); assert.match(r.stdout,/hook runtime missing/); assert.ok(f.get('log').includes('doctor'));
  });
  test('unknown project and unsupported platform exit 5', f => { existing(f); f.write('.claude/tools/aidlc-version.ts','export const AIDLC_VERSION = "2.2.0";\n'); success(f.run(['apply','--yes']),5); assert.equal(f.get('log'),''); success(f.run(['plan'],{AIDLC_V2_PLATFORM:'unsupported'}),5); });
  test('upstream stamp takes priority over legacy marker', f => { existing(f); f.write('.claude/tools/aidlc-version.ts','export const AIDLC_VERSION = "2.1.4";\n'); f.write('.claude/tools/data/aidlc-stamp.json','{}'); success(f.run(['apply','--yes'])); assert.ok(fs.existsSync(path.join(f.project,'.claude/tools/aidlc-version.ts'))); });
  test('CLI on PATH succeeds', f => { fs.copyFileSync(f.stubPath,path.join(f.bin,'aidlc')); success(f.run(['apply','--yes'],{PATH:`${f.bin}:/usr/bin:/bin`})); });
  test('Windows verifies ps1 and passes exact PowerShell flags', f => {
    const ps=path.join(f.dir,'powershell');
    fs.writeFileSync(ps, `#!/bin/sh\n${installerStdinProbe}\nprintf '%s\\n' "$*" > "$STATE/ps-log"\nmkdir -p "$LOCALAPPDATA/aidlc/bin"\ncp "$STUB" "$LOCALAPPDATA/aidlc/bin/aidlc.cmd"\nchmod 755 "$LOCALAPPDATA/aidlc/bin/aidlc.cmd"\n`,{mode:0o755});
    const overrides={AIDLC_V2_PLATFORM:'windows',AIDLC_V2_POWERSHELL:ps};
    success(f.run(['apply','--yes'],overrides),5); assert.match(f.get('ps-log'),/^-NoProfile -ExecutionPolicy Bypass -File .*install.ps1 -Version 2.10.0 -Yes -Quiet\n$/); assert.match(f.get('stdin'),/^eof/); assert.equal(f.get('install-stdin'),'eof\n');
    fs.unlinkSync(path.join(f.env.LOCALAPPDATA,'aidlc/bin/aidlc.cmd')); fs.writeFileSync(path.join(f.state,'ps-log'),''); fs.appendFileSync(path.join(f.dir,'releases/v2.10.0/install.ps1'),'tampered'); success(f.run(['apply','--yes'],overrides),4); assert.equal(f.get('ps-log'),'');
  });
  test('CRLF data, legacy marker and pin are accepted, CLI build metadata stripped', f => {
    existing(f); legacy(f);
    for(const name of ['pins.env','legacy-2.1.4.sha256','legacy-2.1.4.gitignore-block']) { const p=path.join(f.plugin,'data',name); fs.writeFileSync(p,fs.readFileSync(p,'utf8').replaceAll('\n','\r\n')); }
    f.write('.claude/tools/aidlc-version.ts','export const AIDLC_VERSION = "2.1.4";\r\n'); f.write('.aidlc-version','2.1.4\r\n'); fs.writeFileSync(path.join(f.state,'version'),'2.10.0+build.1\r');
    success(f.run(['plan'])); success(f.run(['apply','--yes'])); assert.ok(f.get('log').includes('--pin 2.10.0 ')); assert.ok(!f.get('log').includes('2.10.0+build'));
  });
  test('in-project symlinked knowledge preserves pristine files under aidlc', f => {
    existing(f); legacy(f); const kb=path.join(f.project,'aidlc/kb'); fs.renameSync(path.join(f.project,'.claude/knowledge'),kb); fs.symlinkSync('../aidlc/kb',path.join(f.project,'.claude/knowledge')); const before=snapshot(path.join(f.project,'aidlc'));
    const r=f.run(['apply','--yes']); success(r); assert.match(r.stdout,/symlinked directory/); assert.deepEqual(snapshot(path.join(f.project,'aidlc')),before);
  });
  test('atomic gitignore mv failure leaves original bytes and removes sibling temporary file', f => {
    existing(f); const marker=path.join(f.dir,'legacy-marker'); fs.writeFileSync(marker,'export const AIDLC_VERSION = "2.1.4";\n'); fs.mkdirSync(path.join(f.project,'.claude/tools'),{recursive:true}); fs.symlinkSync(marker,path.join(f.project,'.claude/tools/aidlc-version.ts'));
    const block=fs.readFileSync(path.join(f.plugin,'data/legacy-2.1.4.gitignore-block'),'utf8'); const original='user\n\n'+block; f.write('.gitignore',original);
    fs.writeFileSync(path.join(f.bin,'mv'),`#!/bin/sh\ncase "$2" in "${f.project}/.gitignore") exit 1 ;; esac\nexec /bin/mv "$@"\n`,{mode:0o755});
    success(f.run(['apply','--yes'],{PATH:`${f.bin}:/usr/bin:/bin`}),1); assert.equal(fs.readFileSync(path.join(f.project,'.gitignore'),'utf8'),original); assert.ok(!fs.readdirSync(f.project).some(p=>p.startsWith('.aidlc-v2-gitignore.')));
  });
  test('home, root, Claude config redirection, and empty project are refused', f => {
    existing(f);
    for(const project of ['/',f.env.HOME]) success(spawnSync(process.env.AIDLC_TEST_SH || 'sh',[path.join(f.plugin,'scripts/aidlc-v2.sh'),'plan','--project',project],{env:f.env,encoding:'utf8'}),5);
    success(f.run(['plan'],{HOME:f.project}),5);
    const config=path.join(f.dir,'claude-config'); fs.mkdirSync(config); fs.symlinkSync(config,path.join(f.project,'.claude')); success(f.run(['plan'],{CLAUDE_CONFIG_DIR:config}),5);
    const r=spawnSync(process.env.AIDLC_TEST_SH || 'sh',[path.join(f.plugin,'scripts/aidlc-v2.sh'),'plan','--project',''],{env:f.env,encoding:'utf8'}); success(r,2); assert.equal(f.get('log'),'');
  });
  test('dry run and config distinguish conflicts, action refusals, and operational errors', f => {
    existing(f);
    for(const phase of ['dry','config']) for(const [rc,output,expected] of [[4,'config conflict settings',3],[4,'active workflow refusal',5],[5,'action required',5],[1,'operational failure',1],[3,'network unavailable',1]]) {
      for(const p of ['dry','config']) { fs.writeFileSync(path.join(f.state,p+'.rc'),'0'); fs.writeFileSync(path.join(f.state,p+'.output'),''); }
      fs.writeFileSync(path.join(f.state,phase+'.rc'),String(rc)); fs.writeFileSync(path.join(f.state,phase+'.output'),output); const r=f.run(['apply','--yes']); success(r,expected); assert.ok(r.stdout.includes(output)); assert.ok(!fs.existsSync(path.join(f.project,'.aidlc-version')));
      if(phase==='dry') success(f.run(['plan']),expected);
    }
  });
  test('failed config restores an older prior pin', f => {
    existing(f); f.write('.aidlc-version','2.9.0\n'); fs.writeFileSync(path.join(f.state,'real-config.rc'),'1');
    const r=f.run(['apply','--yes']); success(r,1);
    assert.equal(fs.readFileSync(path.join(f.project,'.aidlc-version'),'utf8'),'2.9.0\n'); assert.match(r.stdout,/Reverted project pin to 2.9.0/);
  });
  test('doctor failure after a successful config keeps the new pin', f => {
    existing(f); f.write('.aidlc-version','2.9.0\n'); fs.writeFileSync(path.join(f.state,'doctor.rc'),'1');
    const r=f.run(['apply','--yes']); success(r,1);
    assert.equal(fs.readFileSync(path.join(f.project,'.aidlc-version'),'utf8'),'2.10.0\n'); assert.ok(!/Reverted/.test(r.stdout+r.stderr), r.stdout+r.stderr);
  });
  test('off-PATH legacy setup with failing doctor keeps the pin and prints no restore advice', f => {
    legacy(f); fs.copyFileSync(f.stubPath,path.join(f.bin,'aidlc')); fs.writeFileSync(path.join(f.state,'doctor.rc'),'1');
    const r=f.run(['apply','--yes']); success(r,5); assert.match(r.stdout,/export PATH=/);
    assert.equal(fs.readFileSync(path.join(f.project,'.aidlc-version'),'utf8'),'2.10.0\n');
    assert.ok(!/Reverted|real migration already removed|git checkout HEAD/.test(r.stdout+r.stderr), r.stdout+r.stderr);
  });
  test('empty prior pin file counts as no pin', f => {
    existing(f); f.write('.aidlc-version','\n'); fs.writeFileSync(path.join(f.state,'real-config.rc'),'1');
    const r=f.run(['apply','--yes']); success(r,1); assert.match(r.stdout,/Reverted project pin to none/); assert.ok(!f.get('log').includes("--pin \n") && !/--pin  /.test(f.get('log')));
  });
  test('legacy plan with a CLI shows a quiet rehearsal (no per-file removed lines)', f => {
    existing(f); legacy(f); const r=f.run(['plan']); success(r);
    assert.ok(!/^removed /m.test(r.stdout), 'plan must not print removed lines'); assert.match(r.stdout,/^remove /m); assert.match(r.stdout,/Legacy migration: remove 241/);
    assert.equal((r.stdout.match(/Legacy migration:/g)||[]).length,1);
  });
  test('legacy plan without CLI classifies an appended .gitignore as strip-suffix', f => {
    legacy(f); const block=fs.readFileSync(path.join(f.plugin,'data/legacy-2.1.4.gitignore-block'),'utf8'); f.write('.gitignore','node_modules\n\n'+block);
    const r=f.run(['plan']); success(r); assert.match(r.stdout,/strip-suffix \.gitignore/); assert.ok(!/keep \.gitignore/.test(r.stdout));
  });
  test('pin return mapping and scratch refusal mapping always unpin scratch', f => {
    existing(f);
    for(const [rc,expected] of [[5,5],[4,1],[1,1]]) { fs.writeFileSync(path.join(f.state,'pin.rc'),String(rc)); success(f.run(['apply','--yes']),expected); }
    fs.writeFileSync(path.join(f.state,'pin.rc'),'0'); legacy(f); const before=snapshot(f.project);
    for(const [rc,output,expected] of [[4,'config conflict settings',3],[4,'active workflow',5],[5,'action required',5],[1,'error',1]]) {
      fs.writeFileSync(path.join(f.state,'scratch-dry.rc'),String(rc)); fs.writeFileSync(path.join(f.state,'scratch-dry.output'),output); fs.writeFileSync(path.join(f.state,'log'),''); const r=f.run(['apply','--yes']); success(r,expected); assert.match(f.get('log'),/--unpin --project-dir .*rehearsal/); assert.deepEqual(snapshot(f.project),before);
    }
  });
  test('Windows honors explicit bin and reports actual PATH directory', f => {
    fs.copyFileSync(f.stubPath,path.join(f.bin,'aidlc.cmd')); const r=f.run(['apply','--yes'],{AIDLC_V2_PLATFORM:'windows'}); success(r,5); assert.ok(r.stdout.includes(`Add "${f.bin}" to your user PATH`)); assert.equal(f.get('install-log'),'');
  });
  console.log(`Shim tests: ${count} passed, 0 failed.`);
} finally { fs.rmSync(tmp,{recursive:true,force:true}); }
