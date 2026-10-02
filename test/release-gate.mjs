#!/usr/bin/env node
// Opt-in real-release verification. All upstream state lives under this temp root.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-release-gate-'));
const bin = path.join(tmp, 'bin');
const home = path.join(tmp, 'home');
const outside = path.join(tmp, 'outside');
for (const dir of [bin, home, outside]) fs.mkdirSync(dir);
const pins = Object.fromEntries(fs.readFileSync(path.join(root, 'dist/claude/data/pins.env'),'utf8').trim().split('\n').map(l=>l.split('=')));
const version = pins.AIDLC_V2_PINNED_VERSION;
// Controlled PATH prevents discovering or replacing the user's machine CLI.
// Include gh through a sandbox symlink, for the upstream signature verifier.
const tools = path.join(tmp,'tools'); fs.mkdirSync(tools);
const gh = spawnSync('sh',['-c','command -v gh'],{encoding:'utf8'}).stdout.trim();
if(gh) fs.symlinkSync(gh,path.join(tools,'gh'));
const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: path.join(tmp,'claude-config'), XDG_DATA_HOME: path.join(tmp,'data'), XDG_CONFIG_HOME: path.join(tmp,'config'), XDG_CACHE_HOME: path.join(tmp,'cache'), AIDLC_INSTALL_ROOT: path.join(tmp,'install'), AIDLC_BIN_DIR: bin, PATH: `${tools}:/usr/bin:/bin:/usr/sbin:/sbin`, AIDLC_V2_PLATFORM: 'unix', AIDLC_V2_AIDLC: '', AIDLC_V2_RELEASE_BASE: 'https://github.com/awslabs/aidlc-workflows/releases/download' };
function run(command,args,cwd=outside) {
  const r=spawnSync(command,args,{cwd,env,input:'',encoding:'utf8',timeout:300000,maxBuffer:32*1024*1024});
  if(r.error) throw r.error;
  return r;
}
function apply(project) {
  const r=run('sh',[path.join(root,'dist/claude/scripts/aidlc-v2.sh'),'apply','--project',project,'--yes']);
  process.stdout.write(r.stdout); process.stderr.write(r.stderr);
  assert.ok(r.status===0 || r.status===5,`apply failed with ${r.status}`);
  if(r.status===5) assert.match(r.stdout+r.stderr,/export PATH=|Add ".*" to your user PATH/, 'action-required success must explain PATH');
  assert.equal(fs.readFileSync(path.join(project,'.aidlc-version'),'utf8').trim(),version);
}
const cli=path.join(bin,'aidlc');
function doctor(project) {
  const r=run(cli,['doctor','--project-dir',project,'--quiet'],project);
  process.stdout.write(r.stdout); process.stderr.write(r.stderr);
  assert.equal(r.status,0,`doctor failed: ${r.stdout}${r.stderr}`);
  assert.match(r.stdout+r.stderr,/\b0 failed\b/, 'doctor must report 0 failed');
}
function active() {
  const r=run(cli,['--version']); assert.equal(r.status,0,r.stderr); return r.stdout.trim();
}
try {
  const fresh=path.join(tmp,'fresh'); fs.mkdirSync(fresh);
  console.log('Gate: fresh project and real pinned bootstrap');
  apply(fresh); doctor(fresh);
  const before=active();
  // Re-pin an already configured project; compare the machine launcher outside it.
  apply(fresh); assert.equal(active(),before,'fresh pin changed machine-active CLI');
  const archive=path.join(tmp,'archive'); fs.mkdirSync(archive);
  const result=spawnSync('git',['archive','v2.1.4+up.b61e0ed','src'],{cwd:root,maxBuffer:32*1024*1024});
  assert.equal(result.status,0,result.stderr?.toString());
  const tar=spawnSync('tar',['-xf','-','-C',archive],{input:result.stdout}); assert.equal(tar.status,0,tar.stderr?.toString());
  function materialize(name) {
    const project=path.join(tmp,name); fs.mkdirSync(project);
    for(const rel of ['.claude','.mcp.json','.gitignore','aidlc']) fs.cpSync(path.join(archive,'src',rel),path.join(project,rel),{recursive:true});
    return project;
  }
  function treeHash(dir) {
    return fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(e=>{
      const p=path.join(dir,e.name);
      return e.isDirectory()?treeHash(p).map(r=>e.name+'/'+r):[e.name+':'+(e.isSymbolicLink()?fs.readlinkSync(p):crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'))];
    });
  }
  const merged=materialize('legacy-merged');
  const settingsPath=path.join(merged,'.claude/settings.json'); const settings=JSON.parse(fs.readFileSync(settingsPath)); settings.model='sonnet'; settings.permissions.allow.push('Bash(user-command:*)'); fs.writeFileSync(settingsPath,JSON.stringify(settings,null,2)+'\n');
  const mergedBefore=treeHash(merged);
  console.log('Gate: merged legacy settings must conflict without changes');
  const refused=run('sh',[path.join(root,'dist/claude/scripts/aidlc-v2.sh'),'apply','--project',merged,'--yes']); process.stdout.write(refused.stdout); process.stderr.write(refused.stderr);
  assert.equal(refused.status,3,refused.stdout+refused.stderr); assert.deepEqual(treeHash(merged),mergedBefore); assert.ok(!fs.existsSync(path.join(merged,'.aidlc-version')));
  const legacy=materialize('legacy');
  const memory=path.join(legacy,'aidlc/spaces/default/memory/org.md'); const original=fs.readFileSync(memory);
  console.log('Gate: exact 2.1.4 migration');
  apply(legacy); doctor(legacy); assert.deepEqual(fs.readFileSync(memory),original); assert.equal(active(),before,'legacy pin changed machine-active CLI');
  const appended=materialize('legacy-appended'); const userLines='my-private-dir/\nmy-user-file\n'; const block=fs.readFileSync(path.join(root,'dist/claude/data/legacy-2.1.4.gitignore-block'),'utf8'); fs.writeFileSync(path.join(appended,'.gitignore'),userLines+'\n'+block);
  console.log('Gate: appended legacy gitignore preserves user lines');
  apply(appended); doctor(appended); const ignore=fs.readFileSync(path.join(appended,'.gitignore'),'utf8'); for(const line of userLines.trim().split('\n')) assert.ok(ignore.split('\n').includes(line),line);
  assert.equal(active(),before,'appended legacy pin changed machine-active CLI');
  // Registry state is sandboxed through HOME/XDG_DATA_HOME, as is the install.
  // An unpinned rehearsal must leave no registry references to scratch projects.
  for(const base of [env.XDG_DATA_HOME,env.AIDLC_INSTALL_ROOT]) {
    if(!fs.existsSync(base)) continue;
    const check=dir=>{for(const e of fs.readdirSync(dir,{withFileTypes:true})) {const p=path.join(dir,e.name); if(e.isDirectory())check(p); else if(e.name.endsWith('.json')) assert.ok(!fs.readFileSync(p,'utf8').includes('/rehearsal'),`scratch pin retained in ${p}`);}};
    check(base);
  }
  console.log('Release gate: fresh + legacy + appended doctor 0 failed; merged settings refused unchanged; pins correct; memory preserved; scratch pins unregistered; machine-active version unchanged.');
} catch(error) {
  console.error(`Release gate FAILED: ${error.message}`); process.exitCode=1;
} finally { fs.rmSync(tmp,{recursive:true,force:true}); }
