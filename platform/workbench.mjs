import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {checked} from './vault.mjs';
import {core,health,drill,capacity,hash,fingerprint,options} from './maintenance.mjs';
import {saveJob,listJobs,runJob} from './jobs.mjs';
import {previewPrune} from './retention.mjs';

const ui=fileURLToPath(new URL('../ui/',import.meta.url));
function object(value,allowed){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!allowed.includes(k)))throw new Error('Invalid request fields');}
function restoration(p) {
  object(p,['repository','snapshot','target','prefix','confirmation']);
  if(typeof p.repository!=='string'||typeof p.snapshot!=='string'||!/^[a-f0-9]{64}$/.test(p.snapshot)||typeof p.target!=='string'||p.prefix!==undefined&&typeof p.prefix!=='string')throw new Error('Invalid restore request');
  const target=checked(p.target,false);checked(path.dirname(target));if(fs.existsSync(target))throw new Error('Restore target already exists');
  const repo=checked(p.repository);const lower=v=>process.platform==='win32'?v.toLowerCase():v;
  if(lower(target)===lower(repo)||lower(target).startsWith(lower(repo)+path.sep)||lower(repo).startsWith(lower(target)+path.sep))throw new Error('Restore/repository overlap');
  return {repository:repo,snapshot:p.snapshot,target,prefix:p.prefix||'',state:fingerprint(repo)};
}
async function restorePreview(p) {
  const plan=restoration(p),model=await core(['catalog',plan.repository,plan.snapshot]);
  const entries=model.entries.filter(e=>!plan.prefix||e.path===plan.prefix||e.path.startsWith(plan.prefix+'/')||e.kind==='dir'&&plan.prefix.startsWith(e.path+'/'));
  if(!entries.length)throw new Error('Restore selection not found');
  const available=fs.statfsSync(path.dirname(plan.target),{bigint:true}),required=entries.reduce((n,e)=>n+BigInt(e.size),0n);
  if(available.bsize*available.bavail<required+16777216n)throw new Error('Insufficient restore target space');
  return {ok:true,preview:true,files:entries.filter(e=>e.kind==='file').length,bytes:String(required),confirmation:hash(JSON.stringify(plan)),overwrites_existing_data:false};
}
export async function startWorkbench({port=8790,token=randomBytes(32).toString('hex')}={}) {
  if(!Number.isInteger(port)||port<0||port>65535||!/^[a-f0-9]{64}$/.test(token))throw new Error('Invalid workbench options');
  let busy=false,origin;
  const server=http.createServer(async(req,res)=>{
    const send=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if(req.headers.host!==new URL(origin).host||req.headers.origin&&req.headers.origin!==origin||req.headers['sec-fetch-site']==='cross-site'){send(403,{ok:false,error:'来源被拒绝'});return;}
    let url;try{url=new URL(req.url,origin);}catch{send(400,{ok:false,error:'无效请求地址'});return;}
    if(req.method==='GET'&&['/','/app.js','/style.css'].includes(url.pathname)) {
      const file=path.join(ui,{'/':'index.html','/app.js':'app.js','/style.css':'style.css'}[url.pathname]);
      try{const bytes=fs.readFileSync(file);res.writeHead(200,{'Content-Type':url.pathname.endsWith('.js')?'text/javascript; charset=utf-8':url.pathname.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8'});res.end(bytes);}catch{send(500,{ok:false,error:'工作台资源缺失，请重新检查发行包。'});}return;
    }
    const supplied=req.headers.authorization?.replace(/^Bearer /,'')||'';
    if(Buffer.byteLength(supplied)!==token.length||!timingSafeEqual(Buffer.from(supplied),Buffer.from(token))){send(401,{ok:false,error:'本机会话未授权，请使用启动时提供的完整链接。'});return;}
    if(req.method==='GET'&&url.pathname==='/api/jobs'){try{send(200,{ok:true,jobs:listJobs(),busy});}catch{send(400,{ok:false,error:'任务配置无法读取，请在本机修复后重试。'});}return;}
    if(req.method!=='POST'||req.headers.origin!==origin||req.headers['content-type']!=='application/json'){send(403,{ok:false,error:'请求方法、来源或内容类型不正确'});return;}
    if(busy){send(409,{ok:false,error:'已有操作正在执行，请等待结果。'});return;}
    const routes=['/api/job-save','/api/job-run','/api/snapshots','/api/catalog','/api/restore-preview','/api/restore','/api/report','/api/drill','/api/capacity','/api/prune-preview','/api/init'];
    if(!routes.includes(url.pathname)){send(404,{ok:false,error:'操作不存在'});return;}
    busy=true;
    try {
      const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>65536)throw new Error('Request body exceeds 64 KiB');chunks.push(chunk);}
      const p=JSON.parse(Buffer.concat(chunks).toString('utf8'));let result;
      switch(url.pathname) {
        case '/api/job-save':result=await saveJob(p);break;
        case '/api/job-run':object(p,['id','confirmation']);if(p.confirmation!==p.id)throw new Error('Explicit job confirmation required');result=await runJob(p.id);break;
        case '/api/init':object(p,['repository','confirmation']);if(p.confirmation!==p.repository)throw new Error('Explicit repository confirmation required');result=await core(['init',p.repository]);break;
        case '/api/snapshots':object(p,['repository']);result=await core(['list',p.repository]);result.snapshots.sort((a,b)=>b.created.localeCompare(a.created));result.total=result.snapshots.length;result.snapshots=result.snapshots.slice(0,100);break;
        case '/api/catalog':object(p,['repository','snapshot','offset']);result=await core(['catalog',p.repository,p.snapshot]);if(!Number.isInteger(p.offset??0)||p.offset<0||p.offset>100000)throw new Error('Invalid catalog offset');result.total=result.entries.length;result.entries=result.entries.slice(p.offset??0,(p.offset??0)+100);break;
        case '/api/restore-preview':result=await restorePreview(p);break;
        case '/api/restore':{
          const preview=await restorePreview(p);if(p.confirmation!==preview.confirmation)throw new Error('Restore plan changed; preview again');const plan=restoration(p);
          result=await core(['restore',plan.repository,plan.snapshot,plan.target,...(plan.prefix?['--prefix',plan.prefix]:[])]);break;
        }
        case '/api/report':object(p,['repository','snapshot']);result=await health(p.repository,p.snapshot||'all');break;
        case '/api/drill':object(p,['repository','snapshot']);result=await drill(p.repository,p.snapshot);break;
        case '/api/capacity':object(p,['repository','source']);result=await capacity(p.repository,p.source);break;
        case '/api/prune-preview':object(p,['repository']);result=await previewPrune(p.repository);delete result.plan.entries;break;
      }
      send(200,result);
    }catch{send(400,{ok:false,error:'操作未完成。请检查路径、权限、仓库状态、解锁方式和可用空间；详细诊断请在本机 CLI 运行。原始资料不会被自动删除。'});}
    finally{busy=false;}
  });
  server.requestTimeout=12*60*1000;server.headersTimeout=10000;server.maxConnections=32;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{origin='http://127.0.0.1:'+server.address().port;resolve();});});
  return {server,origin,token,url:origin+'/#'+token,close:()=>new Promise(resolve=>{server.closeIdleConnections();server.close(resolve);})};
}
export async function workbenchCommand(args) {
  if(args[0]!=='workbench')return null;const {values:v,positionals:p}=options(args.slice(1),['port']);
  if(p.length||v.port&&!/^[0-9]{1,5}$/.test(v.port))throw new Error('Usage: workbench [--port 8790]');
  const app=await startWorkbench({port:v.port===undefined?8790:Number(v.port)});
  console.log('MoonRestore 本机工作台（此链接含临时授权，请勿公开）：\n'+app.url+'\nCtrl+C 停止；只监听本机回环。');
  return new Promise(resolve=>{let stopped=false;const stop=async()=>{if(stopped)return;stopped=true;await app.close();resolve({ok:true,stopped:true});};process.once('SIGINT',stop);process.once('SIGTERM',stop);});
}
