import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture,put,backup,call,snapshot} from './helpers.mjs';
import {health,drill,capacity,saveReport} from '../platform/maintenance.mjs';
import {createVault,unlockVault,seal,unseal,storageId,checked} from '../platform/vault.mjs';

test('health distinguishes full content verification, empty repositories and private details',async()=>{
  const f=fixture();try{
    const directory=path.join(f.base,'reports');assert.equal((await health(f.repo,'all',{directory})).ok,false);
    put(f.source,'private-name','original');const b=backup(f);const good=await health(f.repo,b.snapshot,{directory});assert.equal(good.ok,true);
    const part=snapshot(f,b.snapshot).entries[0].chunks[0];fs.writeFileSync(path.join(f.repo,'objects',part.id.slice(0,2),part.id),'damaged');
    const bad=await health(f.repo,'all',{directory});assert.equal(bad.ok,false);assert.equal(bad.audit.snapshots[0].failed_files,1);
    assert.ok(!fs.readFileSync(bad.files.json,'utf8').includes('private-name'));
    const detailed=await health(f.repo,'all',{directory,details:true});assert.ok(fs.readFileSync(detailed.files.json,'utf8').includes('private-name'));
    assert.equal(fs.existsSync(path.join(f.repo,'.lock')),false);
  }finally{f.cleanup();}
});
test('restore drill actually restores and re-reads files without leaving output',async()=>{
  const f=fixture();try{put(f.source,'目录/file','value');const b=backup(f),r=await drill(f.repo,b.snapshot,{parent:f.base,directory:path.join(f.base,'reports')});
    assert.equal(r.ok,true);assert.equal(r.post_restore_readback,true);assert.equal(r.restored_files,1);assert.equal(r.temporary_cleanup,true);assert.ok(!fs.readdirSync(f.base).some(n=>n.startsWith('moonrestore-drill-')));
  }finally{f.cleanup();}
});
test('failed and selective drills preserve original files and declare their scope',async()=>{
  const f=fixture();try{put(f.source,'a','one');put(f.source,'b','two');const b=backup(f);const r=await drill(f.repo,b.snapshot,{prefix:'a',parent:f.base,directory:path.join(f.base,'reports')});assert.equal(r.ok,true);assert.equal(r.restored_files,1);assert.equal(r.scope,'selected_subtree');
    const bad=await drill(f.repo,'0'.repeat(64),{parent:f.base,directory:path.join(f.base,'reports')});assert.equal(bad.ok,false);assert.equal(fs.readFileSync(path.join(f.source,'a'),'utf8'),'one');
  }finally{f.cleanup();}
});
test('capacity is conservative, supports exclusions and reports insufficient reserves',async()=>{
  const f=fixture();try{put(f.source,'data','tiny');const c=await capacity(f.repo,f.source,{reserve:'0'});assert.equal(c.ok,true);assert.equal(c.required_logical_bytes,'4');assert.equal(c.prediction,'conservative_default_chunks_estimate_not_a_reservation');
    assert.equal((await capacity(f.repo,f.source,{reserve:'9000000000000000000'})).ok,false);
    await assert.rejects(()=>capacity(f.repo,f.source,{reserve:'-1'}));
  }finally{f.cleanup();}
});
test('HTML report escapes untrusted strings and refuses overwriting existing reports',()=>{
  const f=fixture();try{const files=saveReport({ok:false,label:'<script>alert(1)</script>'},{directory:path.join(f.base,'reports')});const html=fs.readFileSync(files.html,'utf8');assert.ok(!html.includes('<script>'));assert.ok(html.includes('&lt;script&gt;'));}finally{f.cleanup();}
});
test('reports reject symlink destinations and strict CLI options',async()=>{
  const f=fixture();try{const other=path.join(f.base,'other');fs.mkdirSync(other);const link=path.join(f.base,'alias');fs.symlinkSync(other,link,process.platform==='win32'?'junction':'dir');
    assert.throws(()=>checked(link));await assert.rejects(()=>health(f.repo,'all',{directory:link}));
    call(['report',f.repo,'--parent',f.base],{status:1});
  }finally{f.cleanup();}
});
test('standard encrypted envelopes authenticate data, identity and repository',()=>{
  const v=createVault('controlled-test-password'),w=createVault('another-controlled-password');const id='a'.repeat(64),name=storageId(v.key,'object',id),plain=Buffer.from('private content');
  const encrypted=seal(v.key,v.config,'object',id,plain);assert.equal(encrypted.includes(plain),false);assert.deepEqual(unseal(v.key,v.config,'object',name,encrypted).bytes,plain);
  const modified=Buffer.from(encrypted);modified[modified.length-1]^=1;assert.throws(()=>unseal(v.key,v.config,'object',name,modified));assert.throws(()=>unseal(v.key,w.config,'object',name,encrypted));assert.throws(()=>unseal(v.key,v.config,'manifest',name,encrypted));
  assert.deepEqual(unlockVault(v.config,{MOONRESTORE_PASSWORD:'controlled-test-password'}),v.key);assert.throws(()=>unlockVault(v.config,{MOONRESTORE_PASSWORD:'incorrect-controlled-pass'}));
});
test('encrypted CLI backups hide file names and content, recover by independent key',()=>{
  const f=fixture();try{put(f.source,'private-filename','secret contents');const repo=path.join(f.base,'encrypted'),env={MOONRESTORE_PASSWORD:'controlled-test-password',MOONRESTORE_HOME:path.join(f.base,'state')};
    call(['init-encrypted',repo],{env});const b=call(['backup',repo,f.source],{env});call(['verify',repo,b.snapshot],{env});
    const sealed=fs.readFileSync(path.join(repo,'snapshots',fs.readdirSync(path.join(repo,'snapshots'))[0]));assert.ok(!sealed.includes(Buffer.from('private-filename')));
    call(['list',repo],{env:{...env,MOONRESTORE_PASSWORD:'incorrect-controlled-pass'},status:1});
    const key=path.join(f.base,'recovery-key.json');call(['key-export',repo,'--output',key],{env});
    const out=path.join(f.base,'restored');call(['restore',repo,b.snapshot,out],{env:{...env,MOONRESTORE_PASSWORD:'',MOONRESTORE_KEY_FILE:key}});assert.equal(fs.readFileSync(path.join(out,'private-filename'),'utf8'),'secret contents');
    const cfg=JSON.parse(fs.readFileSync(path.join(repo,'encryption.json')));cfg.kdf='unsafe';fs.writeFileSync(path.join(repo,'encryption.json'),JSON.stringify(cfg));call(['list',repo],{env,status:1});
  }finally{f.cleanup();}
});
test('replication is independently verified, repeatable and never propagates deletions',()=>{
  const f=fixture();try{put(f.source,'data','one');const a=backup(f),copy=path.join(f.base,'replica');const first=call(['replicate',f.repo,copy]);assert.equal(first.destination_audited,true);assert.equal(first.independent_physical_device_verified,false);
    assert.equal(call(['replicate',f.repo,copy]).copied_snapshots,0);fs.unlinkSync(path.join(f.repo,'snapshots',a.snapshot+'.json'));
    assert.equal(call(['list',copy]).snapshots.length,1);call(['replicate',copy,copy],{status:1});
    const out=path.join(f.base,'copy-restored');call(['restore',copy,a.snapshot,out]);assert.equal(fs.readFileSync(path.join(out,'data'),'utf8'),'one');
  }finally{f.cleanup();}
});
test('plaintext-to-encrypted copy preserves logical snapshot IDs and supports destination credentials',()=>{
  const f=fixture();try{put(f.source,'data','sensitive');const b=backup(f),dest=path.join(f.base,'protected');
    const env={MOONRESTORE_DEST_PASSWORD:'controlled-test-password'};assert.equal(call(['replicate',f.repo,dest,'--encrypted'],{env}).ok,true);
    call(['verify',dest,b.snapshot],{env:{MOONRESTORE_PASSWORD:'controlled-test-password'}});assert.equal(call(['list',f.repo]).snapshots.length,1);
  }finally{f.cleanup();}
});
