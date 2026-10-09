// Small controlled performance sample, NOT a production or long-term load test.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const project=fileURLToPath(new URL('../',import.meta.url));
const base=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'moonrestore-bench-'));
const source=path.join(base,'source'),repo=path.join(base,'vault');fs.mkdirSync(source);
const records=[];
function run(name,...args){const start=performance.now();const r=spawnSync(process.execPath,[path.join(project,'bin','moonrestore.mjs'),...args],{encoding:'utf8',timeout:60000,env:{...process.env,MOONRESTORE_PROFILE:'1'}});if(r.status!==0)throw new Error(r.stderr);
  const profile=JSON.parse(r.stderr.trim().split('\n').at(-1));const output=JSON.parse(r.stdout);records.push({operation:name,elapsed_ms:Math.round(performance.now()-start),max_rss_kib:profile.max_rss_kib});return output;}
const data=Buffer.alloc(8*1024*1024);let x=29;
for(let i=0;i<data.length;i++){x^=x<<13;x^=x>>>17;x^=x<<5;data[i]=x&255;}
fs.writeFileSync(path.join(source,'dataset.bin'),data);run('init','init',repo);
const first=run('first-backup','backup',repo,source),again=run('unchanged-backup','backup',repo,source);
assert.equal(again.stored_bytes,'0');run('verify','verify',repo,first.snapshot);
const target=path.join(base,'restore');run('restore','restore',repo,first.snapshot,target);
const sha=b=>createHash('sha256').update(b).digest('hex');assert.equal(sha(fs.readFileSync(path.join(target,'dataset.bin'))),sha(data));
const report={controlled_sample:true,production_benchmark:false,platform:process.platform,arch:process.arch,node:process.version,
  recorded_at:new Date().toISOString(),dataset_bytes:data.length,initial_stored_bytes:first.stored_bytes,unchanged_stored_bytes:again.stored_bytes,
  restored_identical:true,records};
const dir=path.join(project,'.local','benchmarks');fs.mkdirSync(dir,{recursive:true});
const output=path.join(dir,`benchmark-${Date.now()}.json`);fs.writeFileSync(output,JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({...report,report_file:output},null,2));
assert.equal(path.dirname(path.resolve(base)),path.resolve(fs.realpathSync(os.tmpdir())));assert.ok(path.basename(base).startsWith('moonrestore-bench-'));
fs.rmSync(base,{recursive:true,force:true});
