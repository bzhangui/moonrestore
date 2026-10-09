import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const project=fileURLToPath(new URL('../',import.meta.url));
function run(command,args){const r=spawnSync(command,args,{cwd:project,stdio:'inherit',shell:false});if(r.error)throw r.error;if(r.status!==0)process.exit(r.status??1);}
const moon=process.platform==='win32'?'moon.exe':'moon';
// A fresh machine has no registry index. Refresh before resolving pinned dependencies.
run(moon,['update']);
run(moon,['build','--target','js','--release','--deny-warn']);
if(process.platform!=='win32'){
  const dir=path.join(project,'_build','host');fs.mkdirSync(dir,{recursive:true});
  run(process.env.CC||'cc',['-O2','-Wall','-Wextra','-Werror','platform/rename_noreplace.c','-o',path.join(dir,'rename_noreplace')]);
}
