import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {project} from './helpers.mjs';
test('package checksum verifier rejects corruption and traversal manifests',()=>{
  const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'moonrestore-package-test-'));
  const verify=()=>spawnSync(process.execPath,[path.join(project,'scripts','verify-package.mjs'),dir],{encoding:'utf8'});
  try {
    fs.writeFileSync(path.join(dir,'example'),'content');const digest=createHash('sha256').update('content').digest('hex');
    const manifest={format:1,files:{example:digest}};fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify(manifest));assert.equal(verify().status,0);
    fs.appendFileSync(path.join(dir,'example'),'corrupted');assert.notEqual(verify().status,0);
    fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify({format:1,files:{'../outside':digest}}));assert.notEqual(verify().status,0);
  }finally{assert.equal(path.dirname(path.resolve(dir)),path.resolve(fs.realpathSync(os.tmpdir())));assert.ok(path.basename(dir).startsWith('moonrestore-package-test-'));fs.rmSync(dir,{recursive:true,force:true});}
});
