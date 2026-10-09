import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {project,fixture,put,call} from './helpers.mjs';
test('Windows guided launcher dependency/build self-check',{skip:process.platform!=='win32'},()=>{
  const r=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File','scripts/console.ps1','-CheckOnly'],{cwd:project,encoding:'utf8',timeout:30000});
  assert.equal(r.status,0,r.stderr);assert.ok(r.stdout.includes('MoonRestore 0.1.0'));
});
test('Windows menu completes a confirmed backup with an empty optional label',{skip:process.platform!=='win32'},()=>{
  const f=fixture();try {
    put(f.source,'sample','backup');
    const input=['2',f.repo,f.source,'','yes','0',''].join('\n');
    const r=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File','scripts/console.ps1'],{cwd:project,encoding:'utf8',input,timeout:30000});
    assert.equal(r.status,0,r.stderr);assert.equal(call(['list',f.repo]).snapshots.length,1);
  }finally{f.cleanup();}
});
