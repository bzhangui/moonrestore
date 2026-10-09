import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {Host} from '../platform/adapter.mjs';
import {fixture,put,sha} from './helpers.mjs';

function session(f) {
  const h=new Host(); const invoke=(op,a=null,bytes=Buffer.alloc(0))=>JSON.parse(h.execute(op,JSON.stringify(a),bytes));
  assert.equal(invoke('open',{path:f.repo}).ok,true); assert.equal(invoke('lock').ok,true);
  return {h,invoke};
}
const limits={max_files:100000,max_file_bytes:2147483648,max_total_bytes:68719476736};

test('source root additions and file changes are rejected',()=>{
  const f=fixture();const {h,invoke}=session(f);try{
    put(f.source,'data','original');assert.equal(invoke('walk',{source:f.source,excludes:[],limits}).ok,true);
    assert.equal(invoke('open_source',{path:'data'}).ok,true);invoke('read_source',{max:65536});
    put(f.source,'data','changed length');assert.equal(invoke('close_source').ok,false);
    assert.equal(invoke('walk',{source:f.source,excludes:[],limits}).ok,true);
    put(f.source,'late','new entry');fs.utimesSync(f.source,new Date(0),new Date(0));
    assert.equal(invoke('check_source').ok,false);
  }finally{h.clean();f.cleanup();}
});

test('disk-full injection never publishes an object and releases its lock',()=>{
  const f=fixture();const {h,invoke}=session(f);const original=fs.writeFileSync;
  try{
    fs.writeFileSync=(...args)=>{if(typeof args[0]==='number'){const e=new Error('simulated ENOSPC');e.code='ENOSPC';throw e;}return original(...args);};
    const bytes=Buffer.from('payload'),id=sha(bytes);
    assert.equal(invoke('put',{id},bytes).ok,false);
    assert.ok(!fs.existsSync(path.join(f.repo,'objects',id.slice(0,2),id)));
  }finally{fs.writeFileSync=original;h.clean();assert.ok(!fs.existsSync(path.join(f.repo,'.lock')));f.cleanup();}
});

test('destination appearing at publication cannot be replaced, even if empty',()=>{
  const f=fixture();const {h,invoke}=session(f);try{
    const target=path.join(f.base,'target');assert.equal(invoke('begin_restore',{target}).ok,true);
    invoke('restore_open',{path:'data'});invoke('restore_write',null,Buffer.from('restore'));invoke('restore_close');
    h.failpoint=point=>{if(point==='restore-complete')fs.mkdirSync(target);};
    assert.equal(invoke('finish_restore').ok,false);
    assert.deepEqual(fs.readdirSync(target),[]);assert.ok(fs.existsSync(h.restore.stage));
  }finally{h.clean();f.cleanup();}
});

test('entry and depth budgets stop traversal and special paths fail closed',()=>{
  const f=fixture();const {h,invoke}=session(f);try{
    put(f.source,'a','a');put(f.source,'b','b');
    assert.equal(invoke('walk',{source:f.source,excludes:[],limits:{...limits,max_files:1}}).ok,false);
    assert.equal(invoke('begin_restore',{target:path.join(f.repo,'inside')}).ok,false);
    assert.equal(invoke('begin_restore',{target:path.join(f.base,'new')}).ok,true);
    assert.equal(invoke('restore_open',{path:'../escape'}).ok,false);
    assert.equal(invoke('restore_open',{path:'COM¹.txt'}).ok,false);
  }finally{h.clean();f.cleanup();}
});
