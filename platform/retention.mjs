import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {checked,readPrivate,writePrivate,mkdirPrivate} from './vault.mjs';
import {core,hash,openHost,fingerprint,validatedInventory,options,repositoryIdentity} from './maintenance.mjs';

const uuid=value=>{if(typeof value!=='string'||!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value))throw new Error('Invalid quarantine ID');return value;};
const regular=p=>{const s=fs.lstatSync(checked(p));if(!s.isFile()||s.nlink!==1)throw new Error('Expected regular maintenance file');return s;};
function entryPath(root,rel) {
  if(typeof rel!=='string'||!(/^(objects\/[a-f0-9]{2}\/[a-f0-9]{64}|snapshots\/[a-f0-9]{64}\.json)$/.test(rel)))throw new Error('Unsafe maintenance entry');
  if(rel.startsWith('objects/')&&rel.split('/')[1]!==rel.split('/')[2].slice(0,2))throw new Error('Incorrect shard');
  return path.join(root,...rel.split('/'));
}
function loadBatch(repository,batch) {
  const root=checked(repository),dir=checked(path.join(root,'trash',uuid(batch))),record=JSON.parse(readPrivate(path.join(dir,'manifest.json'),16*1024*1024));
  if(record.format!==1||record.batch!==batch||!Array.isArray(record.entries)||record.entries.length>100000||!Number.isFinite(Date.parse(record.created)))throw new Error('Invalid quarantine manifest');
  const seen=new Set();for(const e of record.entries){entryPath(root,e.relative);if(seen.has(e.relative)||!/^[a-f0-9]{64}$/.test(e.sha256))throw new Error('Invalid quarantine entry');seen.add(e.relative);}
  return {root,dir,record};
}
export async function previewPrune(repository,{keepLast=10,daily=7,weekly=4,monthly=12,protect=[]}={}) {
  const inventory=await validatedInventory(repository),args=['retention-plan',repository,String(keepLast),'--daily',String(daily),'--weekly',String(weekly),'--monthly',String(monthly)];
  for(const p of protect)args.push('--protect',p);
  if(inventory.snapshots.some(s=>Date.parse(s.model.created)>Date.now()))throw new Error('Future-dated snapshot; retention refused');
  const policy=await core(args);if(fingerprint(repository)!==inventory.before)throw new Error('Repository changed');
  const host=openHost(repository);let entries;
  try {
    host.lock();if(fingerprint(repository)!==inventory.before)throw new Error('Repository changed');
    const referenced=new Set();for(const s of inventory.snapshots)if(policy.keep.includes(s.id))for(const e of s.model.entries)for(const c of e.chunks)referenced.add(c.id);
    entries=policy.remove.map(snapshot=>({relative:path.relative(host.repo,host.storagePath('manifest',snapshot)).split(path.sep).join('/')}));
    for(const object of host.operation('inventory',null))if(!referenced.has(object.id))entries.push({relative:path.relative(host.repo,host.storagePath('object',object.id)).split(path.sep).join('/')});
    if(entries.length>100000)throw new Error('Maintenance batch exceeds 100000 entries; split the dataset');
    for(const entry of entries){const file=entryPath(host.repo,entry.relative);regular(file);entry.sha256=hash(readPrivate(file,33554496));}
  }finally{host.clean();}
  const plan={format:1,kind:'retention_preview',repository_identity:repositoryIdentity(repository),state:inventory.before,keep:policy.keep,remove:policy.remove,entries};
  const token=hash(JSON.stringify(plan));return {ok:true,preview:true,confirmation:token,plan,quarantine_grace_days:7,repository_wide:true,space_freed_immediately:false};
}
export async function applyPrune(repository,settings,confirmation) {
  const preview=await previewPrune(repository,settings);
  if(typeof confirmation!=='string'||confirmation!==preview.confirmation)throw new Error('Plan confirmation changed; preview again');
  if(!preview.plan.entries.length)return {...preview,applied:false};
  const host=openHost(repository),batch=randomUUID(),dir=path.join(host.repo,'trash',batch),journal=path.join(host.repo,'.maintenance.json');
  try{
    host.lock();if(fingerprint(repository)!==preview.plan.state)throw new Error('Repository changed after preview');
    mkdirPrivate(dir);const record={format:1,batch,created:new Date().toISOString(),repository_identity:preview.plan.repository_identity,entries:preview.plan.entries};
    writePrivate(path.join(dir,'manifest.json'),JSON.stringify(record));writePrivate(journal,JSON.stringify({format:1,batch}));
    for(const entry of record.entries) {
      const from=entryPath(host.repo,entry.relative),to=entryPath(dir,entry.relative);
      if(hash(readPrivate(from,33554496))!==entry.sha256)throw new Error('Entry changed during maintenance');
      mkdirPrivate(path.dirname(to));if(fs.existsSync(to))throw new Error('Quarantine destination exists');fs.renameSync(from,to);host.failpoint('maintenance-moved');
    }
    fs.unlinkSync(journal);
    return {ok:true,preview:false,quarantined:true,batch,removed_snapshots:preview.plan.remove.length,quarantined_files:record.entries.length,space_freed_immediately:false,minimum_grace_days:7};
  }finally{host.clean();}
}
export function recoverMaintenance(repository,confirmation,{batch}={}) {
  if(confirmation!==repositoryIdentity(repository))throw new Error('Repository identity confirmation required');
  const host=openHost(repository,{allowMaintenance:true});
  try {
    if(!batch){host.operation('recover',null);const j=JSON.parse(readPrivate(path.join(host.repo,'.maintenance.json'),1024));batch=uuid(j.batch);}
    host.lock();const {root,dir,record}=loadBatch(repository,batch);
    if(record.repository_identity!==confirmation)throw new Error('Wrong repository identity');
    if(fs.existsSync(path.join(dir,'purge-started.json')))throw new Error('Purge has started; quarantine rollback is no longer complete');
    // Check all collisions before moving anything; never overwrite new data.
    for(const entry of record.entries){const from=entryPath(dir,entry.relative),to=entryPath(root,entry.relative);
      if(fs.existsSync(from)){if(fs.existsSync(to))throw new Error('Restore collision; no overwrite');if(hash(readPrivate(from,33554496))!==entry.sha256)throw new Error('Quarantine damaged');}
      else if(!fs.existsSync(to)||hash(readPrivate(to,33554496))!==entry.sha256)throw new Error('Maintenance data missing');
    }
    for(const entry of [...record.entries].reverse()){const from=entryPath(dir,entry.relative),to=entryPath(root,entry.relative);if(fs.existsSync(from)){mkdirPrivate(path.dirname(to));fs.renameSync(from,to);}}
    const journal=path.join(root,'.maintenance.json');if(fs.existsSync(journal))fs.unlinkSync(checked(journal));
    if(!fs.existsSync(path.join(dir,'restored.json')))writePrivate(path.join(dir,'restored.json'),JSON.stringify({restored:new Date().toISOString()}));
    return {ok:true,restored:true,batch,overwritten:false};
  }finally{host.clean();}
}
export function purgePreview(repository,batch,{now=Date.now()}={}) {
  const {dir,record}=loadBatch(repository,batch);
  if(fs.existsSync(path.join(dir,'restored.json')))throw new Error('Quarantine was restored');
  const eligible=now-Date.parse(record.created)>=7*86400000;
  return {ok:true,preview:true,batch,eligible,minimum_grace_days:7,confirmation:hash(JSON.stringify(record))};
}
export function purge(repository,batch,confirmation,{now=Date.now()}={}) {
  const preview=purgePreview(repository,batch,{now});if(!preview.eligible||confirmation!==preview.confirmation)throw new Error('Quarantine is too young or confirmation changed');
  const host=openHost(repository);try{
    host.lock();const {dir,record}=loadBatch(repository,batch);
    for(const entry of record.entries){const file=entryPath(dir,entry.relative);if(fs.existsSync(file)&&hash(readPrivate(file,33554496))!==entry.sha256)throw new Error('Quarantine changed; deletion refused');}
    if(!fs.existsSync(path.join(dir,'purge-started.json')))writePrivate(path.join(dir,'purge-started.json'),JSON.stringify({started:new Date(now).toISOString()}));
    let removed=0;for(const entry of record.entries){const file=entryPath(dir,entry.relative);if(fs.existsSync(file)){regular(file);fs.unlinkSync(file);removed++;}}
    return {ok:true,purged:true,batch,removed_files:removed,recoverable:false,receipt_retained:true};
  }finally{host.clean();}
}
export async function retentionCommand(args) {
  if(!['prune','purge','maintenance-recover','maintenance-restore'].includes(args[0]))return null;
  const {values:v,positionals:p}=options(args.slice(1),['keep-last','daily','weekly','monthly','protect','apply','confirm']);
  const command=args[0];
  if(command==='prune'){
    if(p.length!==1||'confirm'in v)throw new Error('Usage: prune repository [--keep-last N] [--daily N] [--weekly N] [--monthly N] [--protect id] [--apply preview-token]');
    const settings={keepLast:v['keep-last']??10,daily:v.daily??7,weekly:v.weekly??4,monthly:v.monthly??12,protect:v.protect??[]};
    return v.apply?applyPrune(p[0],settings,v.apply):previewPrune(p[0],settings);
  }
  if(command==='purge'){
    if(p.length!==2||Object.keys(v).some(k=>k!=='apply'))throw new Error('Usage: purge repository batch [--apply preview-token]');
    return v.apply?purge(p[0],p[1],v.apply):purgePreview(p[0],p[1]);
  }
  if(p.length!==(command==='maintenance-restore'?2:1)||!v.confirm||Object.keys(v).length!==1)throw new Error('Explicit --confirm repository-identity required');
  return recoverMaintenance(p[0],v.confirm,{batch:command==='maintenance-restore'?p[1]:undefined});
}
