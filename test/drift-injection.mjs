#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-drift-'));
let count = 0;
const skill = 'targets/claude/plugin/skills/aidlc/SKILL.md';
const manifest = 'targets/claude/plugin/data/legacy-2.1.4.sha256';
const helper = 'targets/claude/plugin/scripts/aidlc-v2.sh';
function fixture() {
  const dir = fs.mkdtempSync(path.join(tmp,'case-'));
  for (const rel of ['UPSTREAM.lock','package.json','.claude-plugin/marketplace.json','targets/claude/build.mjs','targets/claude/plugin']) {
    fs.mkdirSync(path.dirname(path.join(dir,rel)),{recursive:true}); fs.cpSync(path.join(root,rel),path.join(dir,rel),{recursive:true});
  }
  return dir;
}
const change = (dir,rel,fn) => { const p=path.join(dir,rel); fs.writeFileSync(p,fn(fs.readFileSync(p,'utf8'))); };
const lock = (dir,key,value) => change(dir,'UPSTREAM.lock',s=>s.replace(new RegExp(`^${key}=.*$`,'m'),`${key}=${value}`));
function run(dir, command='build', env={}) {
  return spawnSync(process.execPath,[path.join(dir,'targets/claude/build.mjs'),command],{cwd:dir,encoding:'utf8',env:{...process.env,AIDLC_OUT_DIR:path.join(dir,'dist/claude'),CLAUDE_BIN:'/nonexistent/claude',AIDLC_REQUIRE_CLAUDE_VALIDATE:'0',...env}});
}
function test(name, mutate, pattern, afterBuild=false) {
  const dir=fixture();
  if(afterBuild) assert.equal(run(dir).status,0);
  mutate(dir);
  const r=run(dir,afterBuild?'validate':'build');
  assert.notEqual(r.status,0,`Drift accepted: ${name}`);
  assert.match(r.stdout+r.stderr,pattern,`Wrong gate: ${name}`);
  count++; console.log(`PASS ${name}`);
}
function fingerprint(dir) {
  return fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(e=>e.isDirectory()?fingerprint(path.join(dir,e.name)).map(s=>e.name+'/'+s):[e.name+':'+fs.statSync(path.join(dir,e.name)).mode+':'+fs.readFileSync(path.join(dir,e.name)).toString('base64')]);
}
try {
  const clean=fixture(); assert.equal(run(clean).status,0); count++; console.log('PASS clean build');
  const before=fingerprint(path.join(clean,'dist')); assert.equal(run(clean).status,0); assert.deepEqual(fingerprint(path.join(clean,'dist')),before); count++; console.log('PASS build idempotency');
  for(const key of ['UPSTREAM_REPO','UPSTREAM_TAG','UPSTREAM_VERSION','UPSTREAM_SHA','UPSTREAM_DATE','UPSTREAM_SIGNER_WORKFLOW','INSTALL_SH_SHA256','INSTALL_PS1_SHA256','CHECKSUMS_SHA256','SYNCED_NOTE']) test(`missing ${key}`,d=>change(d,'UPSTREAM.lock',s=>s.replace(new RegExp(`^${key}=.*\\n`,'m'),'')),new RegExp(key));
  for(const [key,value,pattern] of [['UPSTREAM_REPO','https://example.com','repository'],['UPSTREAM_TAG','main','semver'],['UPSTREAM_VERSION','9.0.0','version and tag'],['UPSTREAM_SHA','abcd','40-hex'],['INSTALL_SH_SHA256','x','64-hex'],['INSTALL_PS1_SHA256','x','64-hex'],['CHECKSUMS_SHA256','x','64-hex'],['UPSTREAM_DATE','2026-02-30','ISO'],['UPSTREAM_SIGNER_WORKFLOW','evil/workflow.yml','signer workflow']]) test(`invalid ${key}`,d=>lock(d,key,value),new RegExp(pattern));
  test('semver leading zero',d=>lock(d,'UPSTREAM_TAG','v02.10.0'),/semver/);
  test('duplicate lock field',d=>change(d,'UPSTREAM.lock',s=>s+'UPSTREAM_TAG=v2.10.0\n'),/duplicate lock/);
  test('package version mismatch',d=>change(d,'package.json',s=>s.replace('2.10.0','2.9.0')),/package.json version/);
  test('marketplace version mismatch',d=>change(d,'.claude-plugin/marketplace.json',s=>s.replace('2.10.0','2.9.0')),/marketplace plugin version/);
  const patch=fixture(); for(const rel of ['package.json','.claude-plugin/marketplace.json']) change(patch,rel,s=>s.replace('2.10.0','2.10.0-p1')); assert.equal(run(patch).status,0); count++; console.log('PASS plugin patch version');
  for(const rel of [skill,helper,manifest,'targets/claude/plugin/data/legacy-2.1.4.gitignore-block']) test(`missing ${rel}`,d=>fs.unlinkSync(path.join(d,rel)),/Restore authored file/);
  test('skill name',d=>change(d,skill,s=>s.replace('name: aidlc','name: wrong')),/name: aidlc/);
  for(const mode of ['plan','apply']) test(`skill ${mode} command`,d=>change(d,skill,s=>s.replace(`aidlc-v2.sh" ${mode}`,`aidlc-v2.sh" wrong`)),new RegExp(`helper ${mode}`));
  test('malformed manifest',d=>change(d,manifest,s=>s.replace(/^[a-f0-9]/,'z')),/valid sha256/);
  test('CR manifest',d=>change(d,manifest,s=>s.replace('.claude/', '.claude/\r')),/valid sha256/);
  test('dist CR byte',d=>change(d,'dist/claude/skills/aidlc/SKILL.md',s=>s+'\r'),/Remove CR bytes/,true);
  test('NUL manifest',d=>change(d,manifest,s=>s.replace('.claude/', '.claude/\0')),/valid sha256/);
  test('absolute manifest',d=>change(d,manifest,s=>s.replace('.claude/', '/.claude/')),/valid sha256/);
  test('parent manifest',d=>change(d,manifest,s=>s.replace('.claude/', '.claude/../')),/unsafe paths/);
  test('duplicate manifest',d=>change(d,manifest,s=>s+s.split('\n')[0]+'\n'),/duplicate legacy/);
  test('manifest floor',d=>change(d,manifest,s=>s.split('\n').slice(0,199).join('\n')+'\n'),/at least 200/);
  test('empty block',d=>change(d,'targets/claude/plugin/data/legacy-2.1.4.gitignore-block',()=>''),/gitignore block/);
  test('wrong block marker',d=>change(d,'targets/claude/plugin/data/legacy-2.1.4.gitignore-block',s=>'wrong'+s),/gitignore block/);
  test('shell syntax',d=>change(d,helper,s=>s+'\nif\n'),/shell syntax/);
  test('dist extra file',d=>fs.writeFileSync(path.join(d,'dist/claude/extra'),'drift'),/exactly the shim file set/,true);
  test('dist missing file',d=>fs.unlinkSync(path.join(d,'dist/claude/scripts/aidlc-v2.sh')),/exactly the shim file set/,true);
  test('dist pins drift',d=>change(d,'dist/claude/data/pins.env',s=>s.replace('2.10.0','2.9.0')),/pins.env/,true);
  test('dist JSON parse',d=>change(d,'dist/claude/.claude-plugin/plugin.json',()=>'{broken'),/JSON|Expected|property/,true);
  const rejected=fixture(); const fake=path.join(rejected,'claude'); fs.writeFileSync(fake,'#!/bin/sh\necho rejected\nexit 1\n',{mode:0o755}); assert.notEqual(run(rejected,'build',{CLAUDE_BIN:fake}).status,0); count++; console.log('PASS rejecting Claude CLI');
  const required=fixture(); const r=run(required,'build',{AIDLC_REQUIRE_CLAUDE_VALIDATE:'1'}); assert.notEqual(r.status,0); assert.match(r.stderr,/Install Claude CLI/); count++; console.log('PASS required absent Claude CLI');
  console.log(`Drift tests: ${count} passed, 0 failed.`);
} finally { fs.rmSync(tmp,{recursive:true,force:true}); }
