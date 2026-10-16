import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture,put,backup,call,randomBytes} from './helpers.mjs';
import {previewPrune,applyPrune,recoverMaintenance,purgePreview,purge} from '../platform/retention.mjs';
import {repositoryIdentity} from '../platform/maintenance.mjs';
const policy={keepLast:1,daily:0,weekly:0,monthly:0};
function setup(f){put(f.source,'shared','same');put(f.source,'changed',randomBytes(1000));const first=backup(f);put(f.source,'changed','new');return {first,last:backup(f)};}

test('retention previews without mutation, requires exact confirmation and keeps shared objects',async()=>{
  const f=fixture();try{const {first,last}=setup(f),p=await previewPrune(f.repo,policy);assert.deepEqual(p.plan.remove,[first.snapshot]);assert.equal(call(['list',f.repo]).snapshots.length,2);
    await assert.rejects(()=>applyPrune(f.repo,policy,'0'.repeat(64)));const result=await applyPrune(f.repo,policy,p.confirmation);assert.equal(result.space_freed_immediately,false);
    assert.deepEqual(call(['list',f.repo]).snapshots.map(s=>s.id),[last.snapshot]);call(['verify',f.repo,'all']);
    assert.equal(purgePreview(f.repo,result.batch).eligible,false);assert.throws(()=>purge(f.repo,result.batch,purgePreview(f.repo,result.batch).confirmation));
    assert.equal(recoverMaintenance(f.repo,repositoryIdentity(f.repo),{batch:result.batch}).restored,true);assert.equal(call(['list',f.repo]).snapshots.length,2);
  }finally{f.cleanup();}
});
test('protected snapshots cannot be retired and invalid or stale plans refuse application',async()=>{
  const f=fixture();try{const {first}=setup(f);assert.equal((await previewPrune(f.repo,{...policy,protect:[first.snapshot]})).plan.remove.length,0);
    const p=await previewPrune(f.repo,policy);put(f.source,'later','new snapshot');backup(f);await assert.rejects(()=>applyPrune(f.repo,policy,p.confirmation));
    await assert.rejects(()=>previewPrune(f.repo,{...policy,keepLast:0}));
  }finally{f.cleanup();}
});
test('interrupted quarantine blocks normal operations and explicit recovery rolls back',async()=>{
  const f=fixture();try{setup(f);const p=await previewPrune(f.repo,policy),args=['prune',f.repo,'--keep-last','1','--daily','0','--weekly','0','--monthly','0','--apply',p.confirmation];
    call(args,{env:{MOONRESTORE_TEST_CRASH:'maintenance-moved'},status:86});assert.ok(fs.existsSync(path.join(f.repo,'.maintenance.json')));call(['list',f.repo],{status:1});
    call(['maintenance-recover',f.repo,'--confirm',repositoryIdentity(f.repo)]);call(['verify',f.repo,'all']);assert.equal(call(['list',f.repo]).snapshots.length,2);
  }finally{f.cleanup();}
});
test('aged quarantine purge only removes authorized files and leaves current snapshots restorable',async()=>{
  const f=fixture();try{setup(f);const p=await previewPrune(f.repo,policy),r=await applyPrune(f.repo,policy,p.confirmation),clock=Date.now()+8*86400000;
    const before=purgePreview(f.repo,r.batch,{now:clock});assert.equal(before.eligible,true);const removed=purge(f.repo,r.batch,before.confirmation,{now:clock});assert.ok(removed.removed_files>0);call(['verify',f.repo,'all']);
    assert.throws(()=>recoverMaintenance(f.repo,repositoryIdentity(f.repo),{batch:r.batch}));assert.equal(purge(f.repo,r.batch,before.confirmation,{now:clock}).removed_files,0);
  }finally{f.cleanup();}
});
test('malformed quarantine paths and symlinks cannot escape the repository',async()=>{
  const f=fixture();try{setup(f);const p=await previewPrune(f.repo,policy),r=await applyPrune(f.repo,policy,p.confirmation);const recordFile=path.join(f.repo,'trash',r.batch,'manifest.json'),record=JSON.parse(fs.readFileSync(recordFile));record.entries[0].relative='../outside';fs.writeFileSync(recordFile,JSON.stringify(record));assert.throws(()=>purgePreview(f.repo,r.batch));
  }finally{f.cleanup();}
});
