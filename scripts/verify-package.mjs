import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const directory=process.argv[2];if(!directory)throw new Error('Pass the bundle directory');
const root=path.resolve(directory);
if(fs.lstatSync(root).isSymbolicLink()||!fs.lstatSync(root).isDirectory())throw new Error('Invalid package directory');
const manifestPath=path.join(root,'manifest.json');const manifestStat=fs.lstatSync(manifestPath);
if(!manifestStat.isFile()||manifestStat.isSymbolicLink()||manifestStat.size>1048576)throw new Error('Invalid manifest file');
const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
if(manifest.format!==1||typeof manifest.files!=='object')throw new Error('Invalid package manifest');
if(Object.keys(manifest.files).length>128)throw new Error('Package file budget exceeded');
for(const [rel,expected] of Object.entries(manifest.files)){
  if(!rel||/[\\:\x00-\x1f]/.test(rel)||rel.split('/').some(p=>p===''||p==='.'||p==='..')||path.isAbsolute(rel))throw new Error('Unsafe package path');
  const exact=path.resolve(root,rel);if(!exact.startsWith(root+path.sep))throw new Error('Package traversal');
  if(!/^[0-9a-f]{64}$/.test(expected))throw new Error('Invalid expected digest');
  let component=root;for(const part of rel.split('/')){component=path.join(component,part);if(fs.lstatSync(component).isSymbolicLink())throw new Error('Package contains a link');}
  const stat=fs.lstatSync(exact);if(!stat.isFile()||stat.nlink!==1||stat.size>16777216)throw new Error('Invalid package file');
  const actual=createHash('sha256').update(fs.readFileSync(exact)).digest('hex');if(actual!==expected)throw new Error('Package checksum mismatch: '+rel);
}
console.log(JSON.stringify({package_verified:true,files:Object.keys(manifest.files).length,signed:false}));
