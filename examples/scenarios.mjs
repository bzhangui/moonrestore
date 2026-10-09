import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const cli=fileURLToPath(new URL('../bin/moonrestore.mjs',import.meta.url));
const base=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'moonrestore-scenarios-'));
function run(...args){const r=spawnSync(process.execPath,[cli,...args],{encoding:'utf8',timeout:30000});if(r.status!==0)throw new Error(r.stderr);return JSON.parse(r.stdout);}
function prepare(name){const root=path.join(base,name),source=path.join(root,'source'),repo=path.join(root,'vault');fs.mkdirSync(source,{recursive:true});run('init',repo);return {root,source,repo};}
function put(root,rel,bytes){const p=path.join(root,rel);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,bytes);}
const reports=[];

const research=prepare('research');
put(research.source,'资料/论文.md','可恢复的第一稿');put(research.source,'实验/数据.bin',Buffer.from([0,255,1,0,2]));
const first=run('backup',research.repo,research.source,'--label','第一稿');put(research.source,'资料/论文.md','误改');
const second=run('backup',research.repo,research.source);run('verify',research.repo,'all');
run('restore',research.repo,first.snapshot,path.join(research.root,'recovered'));
assert.equal(fs.readFileSync(path.join(research.root,'recovered','资料','论文.md'),'utf8'),'可恢复的第一稿');
reports.push({scenario:'科研资料误改恢复',ok:true,changes:run('diff',research.repo,first.snapshot,second.snapshot).changes});

const team=prepare('team-assets');
const shared=Buffer.alloc(1024*1024);let seed=27;
for(let i=0;i<shared.length;i++){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;shared[i]=seed&255;}
put(team.source,'assets/source.bin',shared);put(team.source,'cache/temporary','ignore');
run('backup',team.repo,team.source,'--exclude','cache');
const unchanged=run('backup',team.repo,team.source,'--exclude','cache');assert.equal(unchanged.stored_bytes,'0');
const edited=Buffer.concat([shared.subarray(0,400000),Buffer.from('new material'),shared.subarray(400000)]);
put(team.source,'assets/source.bin',edited);const updated=run('backup',team.repo,team.source,'--exclude','cache');
run('restore',team.repo,updated.snapshot,path.join(team.root,'recovered'));
assert.deepEqual(fs.readFileSync(path.join(team.root,'recovered','assets','source.bin')),edited);
assert.ok(Number(updated.reused_bytes)>shared.length*0.75);
reports.push({scenario:'团队资产去重',ok:true,unchanged_stored_bytes:unchanged.stored_bytes,insertion_reused_bytes:updated.reused_bytes,logical_bytes:updated.logical_bytes});

const batch=prepare('batch-rollback');put(batch.source,'input.csv','id,value\n1,42\n');put(batch.source,'config.json','{"mode":"safe"}');
const safe=run('backup',batch.repo,batch.source,'--label','批处理前');put(batch.source,'input.csv','wrong conversion');fs.unlinkSync(path.join(batch.source,'config.json'));
const restored=path.join(batch.root,'recovered');run('restore',batch.repo,safe.snapshot,restored,'--prefix','input.csv');
assert.equal(fs.readFileSync(path.join(restored,'input.csv'),'utf8'),'id,value\n1,42\n');assert.ok(!fs.existsSync(path.join(restored,'config.json')));
reports.push({scenario:'批处理前安全回滚',ok:true,selected_file:'input.csv'});
console.log(JSON.stringify({controlled_simulation:true,real_user_pilot:false,example_directory:base,reports},null,2));
console.log('全部为受控临时样本；文件保留以便查看，未删除个人资料。');
