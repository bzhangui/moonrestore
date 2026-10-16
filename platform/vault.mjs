// Cryptographic OS adapter. Logical hashes, chunking and snapshot rules remain MoonBit.
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes, randomUUID, scryptSync, hkdfSync, createCipheriv, createDecipheriv, createHmac, timingSafeEqual} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export const ENCRYPTED_MAGIC = 'moonrestore-encrypted-repository-v2\n';
export const ENVELOPE_OVERHEAD = 64;
export const stateHome = () => path.resolve(process.env.MOONRESTORE_HOME || fileURLToPath(new URL('../.local/state', import.meta.url)));
export function checked(input, existing=true) {
  if(typeof input!=='string'||!input||input.includes('\0'))throw new Error('Invalid path');
  const full=path.resolve(input),root=path.parse(full).root;let current=root;
  for(const part of full.slice(root.length).split(path.sep).filter(Boolean)) {
    current=path.join(current,part);
    if(fs.existsSync(current)||isLink(current)) {
      if(fs.lstatSync(current).isSymbolicLink())throw new Error('Links/junctions are unsupported');
    } else if(existing)throw new Error('Path does not exist');
  }
  return full;
}
function isLink(p){try{return fs.lstatSync(p).isSymbolicLink();}catch(e){if(e.code==='ENOENT')return false;throw e;}}
export function readPrivate(file,max=1048576) {
  const full=checked(file),s=fs.lstatSync(full);
  if(!s.isFile()||s.nlink!==1||s.size>max)throw new Error('Not a bounded regular file');
  return fs.readFileSync(full);
}
export function mkdirPrivate(dir) {
  const full=checked(dir,false);fs.mkdirSync(full,{recursive:true,mode:0o700});checked(full);return full;
}
export function writePrivate(file,bytes) {
  checked(path.dirname(file));const fd=fs.openSync(file,'wx',0o600);
  try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}
function hex(value,bytes){if(typeof value!=='string'||!new RegExp('^[a-f0-9]{'+bytes*2+'}$').test(value))throw new Error('Invalid encrypted metadata');return Buffer.from(value,'hex');}
function encrypt(key,plain,aad) {
  const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);
  cipher.setAAD(Buffer.from(aad));const data=Buffer.concat([cipher.update(plain),cipher.final()]);
  return {nonce:nonce.toString('hex'),tag:cipher.getAuthTag().toString('hex'),data:data.toString('hex')};
}
function decrypt(key,box,aad) {
  const cipher=createDecipheriv('aes-256-gcm',key,hex(box.nonce,12));cipher.setAAD(Buffer.from(aad));cipher.setAuthTag(hex(box.tag,16));
  if(typeof box.data!=='string'||box.data.length>128||!/^[a-f0-9]+$/.test(box.data))throw new Error('Invalid wrapped key');
  return Buffer.concat([cipher.update(Buffer.from(box.data,'hex')),cipher.final()]);
}
function passwordKey(password,salt) {
  if(typeof password!=='string'||Buffer.byteLength(password)<12||Buffer.byteLength(password)>4096)throw new Error('MOONRESTORE_PASSWORD must contain 12..4096 UTF-8 bytes');
  return scryptSync(password,salt,32,{N:131072,r:8,p:1,maxmem:256*1024*1024});
}
export function createVault(password) {
  const salt=randomBytes(16),id=randomUUID(),key=randomBytes(32),derived=passwordKey(password,salt);
  try{return {key,config:{format:2,id,cipher:'AES-256-GCM-HKDF-SHA256-v2',kdf:'scrypt-N131072-r8-p1',salt:salt.toString('hex'),
    wrapped:encrypt(derived,key,'MoonRestore key '+id),check:createHmac('sha256',key).update('MoonRestore '+id).digest('hex')}};}
  finally{derived.fill(0);}
}
function configValid(c){
  if(!c||c.format!==2||c.cipher!=='AES-256-GCM-HKDF-SHA256-v2'||c.kdf!=='scrypt-N131072-r8-p1'||typeof c.id!=='string'||!/^[a-f0-9-]{36}$/.test(c.id)||
    Object.keys(c).some(k=>!['format','id','cipher','kdf','salt','wrapped','check'].includes(k)))throw new Error('Unsupported encrypted configuration');
  hex(c.salt,16);hex(c.check,32);
}
function protectedKeyPath(c){return path.join(stateHome(),'keys',c.id+'.dpapi');}
function dpapi(input,protect) {
  if(process.platform!=='win32')throw new Error('OS key storage currently requires Windows DPAPI');
  const method=protect?'Protect':'Unprotect';
  const command="Add-Type -AssemblyName System.Security; $v=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); $r=[Security.Cryptography.ProtectedData]::"+method+"($v,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))";
  const r=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{input:input.toString('base64'),encoding:'utf8',timeout:15000,shell:false,windowsHide:true,maxBuffer:8192});
  if(r.status!==0)throw new Error('Windows current-user key storage failed');return Buffer.from(r.stdout.trim(),'base64');
}
export function unlockVault(c,env=process.env) {
  configValid(c);let key;
  try{
    if(env.MOONRESTORE_KEY_FILE) {
      const backup=JSON.parse(readPrivate(env.MOONRESTORE_KEY_FILE,4096));
      if(backup.repository!==c.id)throw new Error('Recovery key belongs to another repository');key=hex(backup.key,32);
    } else if(env.MOONRESTORE_PASSWORD){const derived=passwordKey(env.MOONRESTORE_PASSWORD,hex(c.salt,16));try{key=decrypt(derived,c.wrapped,'MoonRestore key '+c.id);}finally{derived.fill(0);}}
    else if(fs.existsSync(protectedKeyPath(c)))key=dpapi(readPrivate(protectedKeyPath(c),8192),false);
    else throw new Error('Encrypted repository requires a password, private recovery key or previously authorized Windows key store');
    const actual=createHmac('sha256',key).update('MoonRestore '+c.id).digest();
    if(key.length!==32||!timingSafeEqual(actual,hex(c.check,32)))throw new Error('Invalid key');
    return key;
  }catch(e){key?.fill(0);throw new Error('Unable to unlock repository: password/key unavailable, invalid or metadata damaged');}
}
export function rememberKey(c,key) {
  configValid(c);const file=protectedKeyPath(c);mkdirPrivate(path.dirname(file));
  if(fs.existsSync(file))throw new Error('A stored key already exists; not overwritten');
  writePrivate(file,dpapi(key,true));return file;
}
export const storageId=(key,kind,id)=>key?createHmac('sha256',key).update(kind+':'+id).digest('hex'):id;
function payloadCipher(create,key,config,nonce) {
  const derived=Buffer.from(hkdfSync('sha256',key,Buffer.from(config.id),Buffer.from('MoonRestore payload AES-GCM v2'),32));
  try{return create('aes-256-gcm',derived,nonce);}finally{derived.fill(0);}
}
export function seal(key,config,kind,id,bytes) {
  const name=storageId(key,kind,id),nonce=randomBytes(12),cipher=payloadCipher(createCipheriv,key,config,nonce);
  cipher.setAAD(Buffer.from(config.id+':'+kind+':'+name));
  const encrypted=Buffer.concat([cipher.update(Buffer.concat([Buffer.from(id,'hex'),Buffer.from(bytes)])),cipher.final()]);
  return Buffer.concat([Buffer.from('MRV2'),nonce,cipher.getAuthTag(),encrypted]);
}
export function unseal(key,config,kind,name,bytes) {
  if(bytes.length<ENVELOPE_OVERHEAD||bytes.subarray(0,4).toString()!=='MRV2')throw new Error('Invalid authenticated envelope');
  const cipher=payloadCipher(createDecipheriv,key,config,bytes.subarray(4,16));
  cipher.setAAD(Buffer.from(config.id+':'+kind+':'+name));cipher.setAuthTag(bytes.subarray(16,32));
  const plain=Buffer.concat([cipher.update(bytes.subarray(32)),cipher.final()]);const id=plain.subarray(0,32).toString('hex');
  if(storageId(key,kind,id)!==name)throw new Error('Encrypted object identity mismatch');
  return {id,bytes:plain.subarray(32)};
}
