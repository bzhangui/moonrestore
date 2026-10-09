import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const project=fileURLToPath(new URL('../',import.meta.url));
const moon=process.platform==='win32'?'moon.exe':'moon';
function run(command,args){const r=spawnSync(command,args,{cwd:project,stdio:'inherit',shell:false});if(r.error)throw r.error;if(r.status!==0)process.exit(r.status??1);}
if(Number(process.versions.node.split('.')[0])<22)throw new Error('Node >= 22 required');
const v=spawnSync(moon,['version','--all'],{cwd:project,encoding:'utf8'});
if(v.error||v.status!==0)throw new Error('MoonBit unavailable');
const match=v.stdout.match(/moonc v(\d+)\.(\d+)\.(\d+)/);
if(!match)throw new Error('Unable to determine compiler version');
const version=match.slice(1).map(Number);const baseline=[0,10,14];
let comparison=0;for(let i=0;i<3;i++){if(version[i]!==baseline[i]){comparison=version[i]>baseline[i]?1:-1;break;}}
if(comparison<0)throw new Error('moonc >= 0.10.14 required');
console.log(v.stdout.trim());
run(moon,['update']);
run(moon,['fmt','--check']);
for(const target of ['js','wasm','wasm-gc','native']){
  run(moon,['check','--target',target,'--deny-warn']);
  run(moon,['build','--target',target,'--release','--deny-warn']);
  run(moon,['test','--target',target,'--deny-warn']);
  run(moon,['run','examples/core','--target',target]);
}
run(process.execPath,['scripts/build.mjs']);
run(process.execPath,['--test','tests/integration.test.mjs','tests/platform.test.mjs','tests/launcher.test.mjs','tests/package.test.mjs']);
run(process.execPath,['examples/scenarios.mjs']);
console.log('All local maintenance checks passed. Remote CI/publication/real hardware durability are separate evidence.');
