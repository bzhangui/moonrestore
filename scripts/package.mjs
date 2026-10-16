import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {moon,moonEnv} from './build.mjs';
const project=fileURLToPath(new URL('../',import.meta.url));
const sourceVersion=JSON.parse(fs.readFileSync(path.join(project,'package.json'),'utf8')).version;
const build=spawnSync(process.execPath,[path.join(project,'scripts','build.mjs')],{cwd:project,stdio:'inherit'});
if(build.error||build.status!==0)throw new Error('Build failed; no bundle created');
const parent=path.join(project,'.local','releases');fs.mkdirSync(parent,{recursive:true});
const destination=path.join(parent,`moonrestore-${sourceVersion}-${process.platform}-${process.arch}-${randomUUID().slice(0,8)}`);
fs.mkdirSync(destination); // Never overwrite a previous bundle.
const files=[
  'bin/moonrestore.mjs','platform/adapter.mjs','scripts/console.ps1','scripts/verify-package.mjs','开始使用.cmd',
  'platform/vault.mjs','platform/maintenance.mjs','platform/retention.mjs','platform/jobs.mjs','platform/workbench.mjs',
  'ui/index.html','ui/style.css','ui/app.js',
  '_build/js/release/build/cmd/main/main.js',
  'examples/demo.mjs','examples/scenarios.mjs','LICENSE','NOTICE','SECURITY.md',
  'licenses/MoonBit-Apache-2.0.txt','docs/OPERATIONS.md','docs/FORMAT.md','docs/THIRD_PARTY.md',
  'docs/WORKBENCH.md','docs/RECOVERY.md',
];
if(process.platform!=='win32')files.push('_build/host/rename_noreplace');
const hashes={};const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
for(const rel of files){const from=path.join(project,rel),to=path.join(destination,rel);if(!fs.statSync(from).isFile())throw new Error('Missing bundle file: '+rel);
  fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(from,to,fs.constants.COPYFILE_EXCL);hashes[rel]=hash(fs.readFileSync(to));}
fs.copyFileSync(path.join(project,'docs','PORTABLE.md'),path.join(destination,'README.md'));hashes['README.md']=hash(fs.readFileSync(path.join(destination,'README.md')));
const metadata=JSON.stringify({name:'moonrestore-portable',version:sourceVersion,private:true,type:'module',engines:{node:'>=22'}},null,2);
fs.writeFileSync(path.join(destination,'package.json'),metadata,{flag:'wx'});hashes['package.json']=hash(metadata);
const version=spawnSync(moon,['version','--all'],{cwd:project,env:moonEnv,encoding:'utf8'});
if(version.status!==0)throw new Error('Unable to record toolchain');
const manifest={format:1,version:sourceVersion,platform:process.platform,arch:process.arch,toolchain:version.stdout.trim(),files:hashes};
fs.writeFileSync(path.join(destination,'manifest.json'),JSON.stringify(manifest,null,2),{flag:'wx'});
const verified=spawnSync(process.execPath,[path.join(project,'scripts','verify-package.mjs'),destination],{cwd:project,stdio:'inherit'});
if(verified.status!==0)throw new Error('Bundle verification failed');
const smoke=spawnSync(process.execPath,[path.join(destination,'bin','moonrestore.mjs'),'version'],{cwd:destination,encoding:'utf8'});
if(smoke.status!==0||!smoke.stdout.includes('MoonRestore '+sourceVersion))throw new Error('Bundle smoke test failed');
const functional=spawnSync(process.execPath,[path.join(project,'scripts','smoke-portable.mjs'),destination],{cwd:project,stdio:'inherit'});
if(functional.status!==0)throw new Error('Bundle functional smoke test failed');
console.log(JSON.stringify({ok:true,bundle:destination,file_count:Object.keys(hashes).length,runtime_required:'Node.js >= 22',publicly_published:false},null,2));
