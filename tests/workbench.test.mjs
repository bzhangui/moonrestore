import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture,put,backup} from './helpers.mjs';
import {startWorkbench} from '../platform/workbench.mjs';

test('workbench is loopback-only with session authorization, origin and CSP gates',async()=>{
  const app=await startWorkbench({port:0});try{
    assert.equal(app.server.address().address,'127.0.0.1');const page=await fetch(app.origin);assert.equal(page.status,200);assert.ok(page.headers.get('content-security-policy').includes("frame-ancestors 'none'"));assert.ok((await page.text()).includes('备份之后'));
    assert.equal((await fetch(app.origin+'/api/jobs')).status,401);
    assert.equal((await fetch(app.origin+'/api/jobs',{headers:{Authorization:'Bearer '+app.token,Origin:'https://untrusted.example'}})).status,403);
    assert.equal((await fetch(app.origin+'/api/init',{method:'POST',headers:{Authorization:'Bearer '+app.token,'Content-Type':'application/json'},body:'{}'})).status,403);
  }finally{await app.close();}
});
test('workbench performs catalog, preview and non-overwriting restore through real HTTP',async()=>{
  const f=fixture(),app=await startWorkbench({port:0});const request=async(route,body)=>{const r=await fetch(app.origin+'/api/'+route,{method:'POST',headers:{Authorization:'Bearer '+app.token,Origin:app.origin,'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
  try{put(f.source,'paper','value');const b=backup(f),target=path.join(f.base,'restored');assert.equal((await request('snapshots',{repository:f.repo})).body.snapshots.length,1);
    assert.equal((await request('catalog',{repository:f.repo,snapshot:b.snapshot})).body.entries[0].path,'paper');
    const plan=await request('restore-preview',{repository:f.repo,snapshot:b.snapshot,target});assert.equal(plan.status,200);assert.equal(plan.body.files,1);assert.equal(fs.existsSync(target),false);
    assert.equal((await request('restore',{repository:f.repo,snapshot:b.snapshot,target,confirmation:'wrong'})).status,400);
    const result=await request('restore',{repository:f.repo,snapshot:b.snapshot,target,confirmation:plan.body.confirmation});assert.equal(result.body.ok,true);assert.equal(fs.readFileSync(path.join(target,'paper'),'utf8'),'value');
    assert.equal((await request('restore-preview',{repository:f.repo,snapshot:b.snapshot,target})).status,400);
    assert.equal((await request('init',{repository:path.join(f.base,'wrong'),confirmation:'different'})).status,400);
    assert.equal((await request('catalog',{repository:f.repo,snapshot:b.snapshot,offset:-1})).status,400);
    assert.equal((await request('catalog',{repository:f.repo,snapshot:b.snapshot,unknown:true})).status,400);
  }finally{await app.close();f.cleanup();}
});
