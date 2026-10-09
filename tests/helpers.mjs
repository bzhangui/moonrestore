import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const project = fileURLToPath(new URL('../', import.meta.url));
export const cli = path.join(project,'bin','moonrestore.mjs');
export const sha = b => createHash('sha256').update(b).digest('hex');
export function call(args, {env={}, status=0}={}) {
  const r = spawnSync(process.execPath,[cli,...args],{encoding:'utf8',timeout:30000,env:{...process.env,...env}});
  assert.equal(r.error, undefined, String(r.error));
  assert.equal(r.status,status,`stdout=${r.stdout}\nstderr=${r.stderr}`);
  if (status !== 0) return r;
  return JSON.parse(r.stdout.trim());
}
export function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(),'moonrestore-test-'));
  const source = path.join(base,'source'); fs.mkdirSync(source);
  const repo = path.join(base,'vault'); call(['init',repo]);
  return {base,source,repo,cleanup() {
    const exact = path.resolve(base);
    assert.equal(path.dirname(exact),path.resolve(os.tmpdir()));
    assert.ok(path.basename(exact).startsWith('moonrestore-test-'));
    fs.rmSync(exact,{recursive:true,force:true});
  }};
}
export function put(source, rel, data) {
  const file = path.join(source,rel); fs.mkdirSync(path.dirname(file),{recursive:true}); fs.writeFileSync(file,data);
}
export function backup(f, ...extra) { return call(['backup',f.repo,f.source,...extra]); }
export function snapshot(f,id) { return JSON.parse(fs.readFileSync(path.join(f.repo,'snapshots',id+'.json'),'utf8')); }
export function forge(f, object) {
  const text=JSON.stringify(object); const id=sha(text);
  fs.writeFileSync(path.join(f.repo,'snapshots',id+'.json'),text); return id;
}
export function randomBytes(n, seed=7) {
  const b=Buffer.alloc(n); let x=seed>>>0;
  for(let i=0;i<n;i++){x^=x<<13;x^=x>>>17;x^=x<<5;b[i]=x&255;}
  return b;
}
export function tree(root) {
  const out={};
  function visit(dir,prefix='') { for(const name of fs.readdirSync(dir).sort()) {
    const rel=prefix?prefix+'/'+name:name; const file=path.join(dir,name);
    if(fs.statSync(file).isDirectory()){out[rel+'/']='dir';visit(file,rel);}else out[rel]=sha(fs.readFileSync(file));
  }}
  visit(root);return out;
}
