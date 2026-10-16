import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fixture,put,call} from './helpers.mjs';
import {saveJob,listJobs,runJob,runDue,schedulePreview,recoverJobs} from '../platform/jobs.mjs';

async function owned(fn){const f=fixture(),previous=process.env.MOONRESTORE_HOME;process.env.MOONRESTORE_HOME=path.join(f.base,'state');try{await fn(f);}finally{if(previous===undefined)delete process.env.MOONRESTORE_HOME;else process.env.MOONRESTORE_HOME=previous;f.cleanup();}}
test('jobs back up, verify, drill and record overdue/last-success without implicit scheduling',()=>owned(async f=>{
  put(f.source,'paper','version');const saved=await saveJob({id:'papers',repository:f.repo,source:f.source,reserveBytes:'0'});assert.equal(saved.registered_with_os,false);assert.equal(listJobs()[0].overdue,true);
  const result=await runJob('papers');assert.equal(result.ok,true);assert.ok(result.drill);assert.equal(listJobs()[0].overdue,false);assert.equal((await runDue()).no_due_jobs,true);
  const preview=schedulePreview('papers');assert.equal(preview.preview,true);assert.ok(preview.xml.includes('InteractiveToken'));assert.ok(!preview.xml.includes('controlled-test-password'));
}));
test('jobs refuse surprising empty/drop sources and preserve last successful record',()=>owned(async f=>{
  put(f.source,'a','a');put(f.source,'b','b');await saveJob({id:'safe',repository:f.repo,source:f.source,reserveBytes:'0'});assert.equal((await runJob('safe')).ok,true);const success=listJobs()[0].lastSuccess;
  fs.unlinkSync(path.join(f.source,'a'));assert.equal((await runJob('safe')).ok,false);assert.equal(listJobs()[0].lastSuccess,success);assert.equal(call(['list',f.repo]).snapshots.length,1);
}));
test('one job per repository, strict options and offline-device identity checks',()=>owned(async f=>{
  put(f.source,'data','one');await saveJob({id:'one',repository:f.repo,source:f.source,reserveBytes:'0'});
  await assert.rejects(()=>saveJob({id:'other',repository:f.repo,source:f.source}));await assert.rejects(()=>saveJob({id:'bad',repository:f.repo,source:f.source,allowEmpty:'false'}));
  fs.writeFileSync(path.join(f.repo,'repository-id'),'0'.repeat(36));assert.equal((await runJob('one')).ok,false);
}));
test('excluded directories stay excluded in capacity preflight and backup',()=>owned(async f=>{
  put(f.source,'data','keep');const folder=path.join(f.source,'cache');fs.mkdirSync(folder);fs.symlinkSync(f.repo,path.join(folder,'junction'),process.platform==='win32'?'junction':'dir');
  await saveJob({id:'exclude',repository:f.repo,source:f.source,reserveBytes:'0',excludes:['cache']});assert.equal((await runJob('exclude')).ok,true);
}));
test('active local job locks cannot be broken by recovery',()=>owned(async f=>{
  fs.mkdirSync(process.env.MOONRESTORE_HOME);const lock=path.join(process.env.MOONRESTORE_HOME,'.jobs.lock');fs.mkdirSync(lock);fs.writeFileSync(path.join(lock,'owner.json'),JSON.stringify({pid:process.pid,host:os.hostname()}));assert.throws(()=>recoverJobs('recover-stopped-local-job'));assert.throws(()=>recoverJobs('wrong'));assert.ok(fs.existsSync(lock));
}));

test('corrupt job configuration fails closed rather than silently skipping overdue work',()=>owned(async f=>{
  put(f.source,'data','one');await saveJob({id:'validate',repository:f.repo,source:f.source});const file=path.join(process.env.MOONRESTORE_HOME,'jobs.json'),c=JSON.parse(fs.readFileSync(file));c.jobs[0].intervalMinutes='never';fs.writeFileSync(file,JSON.stringify(c));assert.throws(()=>listJobs());
}));
