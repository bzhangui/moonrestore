import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {project} from './helpers.mjs';
test('Windows guided launcher dependency/build self-check',{skip:process.platform!=='win32'},()=>{
  const r=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File','scripts/console.ps1','-CheckOnly'],{cwd:project,encoding:'utf8',timeout:30000});
  assert.equal(r.status,0,r.stderr);assert.ok(r.stdout.includes('MoonRestore 0.1.0'));
});
