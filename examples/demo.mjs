// A disposable, assertion-backed historical recovery example. No personal files.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const cli=fileURLToPath(new URL('../bin/moonrestore.mjs',import.meta.url));
const base=fs.mkdtempSync(path.join(os.tmpdir(),'moonrestore-demo-'));
function run(...args){const r=spawnSync(process.execPath,[cli,...args],{encoding:'utf8',timeout:30000});if(r.status!==0)throw new Error(r.stderr);return JSON.parse(r.stdout);}
const source=path.join(base,'paper'),repo=path.join(base,'vault'),restored=path.join(base,'restored');
fs.mkdirSync(source);fs.writeFileSync(path.join(source,'notes.md'),'可恢复的第一稿\n');
run('init',repo);const first=run('backup',repo,source,'--label','初稿');
fs.writeFileSync(path.join(source,'notes.md'),'不小心改坏了\n');
const second=run('backup',repo,source,'--label','修改后');
run('verify',repo,'all');run('restore',repo,first.snapshot,restored);
assert.equal(fs.readFileSync(path.join(restored,'notes.md'),'utf8'),'可恢复的第一稿\n');
console.log(JSON.stringify({ok:true,example_directory:base,first:first.snapshot,second:second.snapshot,
  recovered_file:path.join(restored,'notes.md'),changes:run('diff',repo,first.snapshot,second.snapshot).changes},null,2));
console.log('演示文件保留以便查看；未接触个人数据。');
