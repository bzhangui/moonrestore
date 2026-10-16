import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture,put,call} from './helpers.mjs';
test('large profile is explicit, old repositories retain their 2 GiB safety limit',()=>{
  const f=fixture();try{const large=path.join(f.base,'large');assert.equal(call(['init-large',large]).format,3);
    const file=path.join(f.source,'large.bin'),fd=fs.openSync(file,'wx');fs.ftruncateSync(fd,2147483649);fs.closeSync(fd);
    call(['plan',f.repo,f.source],{status:1});const plan=call(['plan',large,f.source]);assert.equal(plan.logical_bytes,'2147483649');assert.equal(plan.limits.max_file_bytes,'68719476736');
  }finally{f.cleanup();}
});
test('format 3 snapshots are bounded and copying them requires a compatible destination',()=>{
  const f=fixture();try{put(f.source,'data','small data in explicit large profile');const repo=path.join(f.base,'large');call(['init-large',repo]);const b=call(['backup',repo,f.source]);
    assert.equal(call(['catalog',repo,b.snapshot]).format,3);call(['verify',repo,'all']);call(['replicate',repo,f.repo],{status:1});
    const copy=path.join(f.base,'copy');assert.equal(call(['replicate',repo,copy]).ok,true);assert.ok(fs.readFileSync(path.join(copy,'moonrestore'),'utf8').includes('v3'));
  }finally{f.cleanup();}
});
