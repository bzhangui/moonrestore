// Exercise only synthetic data, through the copied runtime, without MoonBit SDK.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {removeOwned} from '../platform/maintenance.mjs';
const bundle=path.resolve(process.argv[2]||'');
if(!fs.statSync(path.join(bundle,'manifest.json')).isFile())throw new Error('Expected verified portable bundle');
const parent=fs.realpathSync(os.tmpdir()),root=fs.mkdtempSync(path.join(parent,'moonrestore-portable-smoke-'));
try{
  const source=path.join(root,'source'),repository=path.join(root,'encrypted');fs.mkdirSync(source);fs.writeFileSync(path.join(source,'sample.txt'),'controlled portable backup');
  const env={...process.env,MOONRESTORE_HOME:path.join(root,'state'),MOONRESTORE_PASSWORD:'controlled-portable-smoke-only'};
  const run=args=>{const result=spawnSync(process.execPath,[path.join(bundle,'bin','moonrestore.mjs'),...args],{cwd:bundle,env,encoding:'utf8',timeout:60000,shell:false,maxBuffer:1024*1024});assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);};
  run(['init-encrypted',repository]);const snapshot=run(['backup',repository,source]).snapshot;
  assert.equal(run(['report',repository,'all']).ok,true);
  const drill=run(['drill',repository,snapshot]);assert.equal(drill.ok,true);assert.equal(drill.post_restore_readback,true);
  console.log(JSON.stringify({portable_runtime_smoke:true,encrypted_backup:true,report:true,restore_readback:true}));
}finally{removeOwned(root,parent,'moonrestore-portable-smoke-');}
