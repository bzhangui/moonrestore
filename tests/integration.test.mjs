import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {Host} from '../platform/adapter.mjs';
import {fixture,call,put,backup,snapshot,forge,randomBytes,tree} from './helpers.mjs';

test('init refuses existing directories and maintains repository format',()=>{
  const f=fixture();try {
    call(['init',f.repo],{status:1});
    assert.equal(fs.readFileSync(path.join(f.repo,'moonrestore'),'utf8'),'moonrestore-repository-v1\n');
    assert.deepEqual(call(['list',f.repo]).snapshots,[]);
  }finally{f.cleanup();}
});

test('Unicode binary empty files/directories exclusions and verified historical restore',()=>{
  const f=fixture();try {
    put(f.source,'资料/论文.md','初稿\n');put(f.source,'data.bin',randomBytes(200000));
    put(f.source,'zero',Buffer.alloc(0));fs.mkdirSync(path.join(f.source,'empty-dir'));
    put(f.source,'private/token.txt','DO_NOT_BACK_UP');
    const b=backup(f,'--exclude','private','--label','科研资料');
    const s=snapshot(f,b.snapshot);
    assert.ok(!JSON.stringify(s).includes(f.source));
    assert.ok(!s.entries.some(e=>e.path.startsWith('private')));
    assert.equal(call(['verify',f.repo,b.snapshot]).files,3);
    const dest=path.join(f.base,'restored');call(['restore',f.repo,b.snapshot,dest]);
    assert.equal(fs.readFileSync(path.join(dest,'资料','论文.md'),'utf8'),'初稿\n');
    assert.deepEqual(fs.readFileSync(path.join(dest,'data.bin')),fs.readFileSync(path.join(f.source,'data.bin')));
    assert.equal(fs.readFileSync(path.join(dest,'zero')).length,0);assert.ok(fs.statSync(path.join(dest,'empty-dir')).isDirectory());
    put(f.source,'资料/论文.md','第二稿');fs.unlinkSync(path.join(f.source,'data.bin'));
    const second=backup(f,'--exclude','private');
    assert.equal(call(['list',f.repo]).snapshots.length,2);
    const old=path.join(f.base,'history');call(['restore',f.repo,b.snapshot,old]);
    assert.equal(fs.readFileSync(path.join(old,'资料','论文.md'),'utf8'),'初稿\n');
    const changes=call(['diff',f.repo,b.snapshot,second.snapshot]).changes;
    assert.ok(changes.some(x=>x.path==='data.bin'&&x.change==='removed'));
    assert.ok(changes.some(x=>x.path==='资料/论文.md'&&x.change==='modified'));
    assert.equal(call(['verify',f.repo,'all']).verified_snapshots.length,2);
  }finally{f.cleanup();}
});

test('unchanged snapshots store zero extra payload and CDC resynchronizes after insertion',()=>{
  const f=fixture();try {
    const original=randomBytes(1024*1024);put(f.source,'data.bin',original);
    const first=backup(f), second=backup(f);
    assert.equal(second.stored_bytes,'0');assert.equal(second.reused_bytes,String(original.length));
    const edited=Buffer.concat([original.subarray(0,400000),Buffer.from('inserted-content'),original.subarray(400000)]);
    put(f.source,'data.bin',edited);const third=backup(f);
    assert.ok(Number(third.reused_bytes)>original.length*0.75,JSON.stringify(third));
    assert.ok(Number(third.stored_bytes)<original.length*0.25);
    const dest=path.join(f.base,'edit');call(['restore',f.repo,third.snapshot,dest]);
    assert.deepEqual(fs.readFileSync(path.join(dest,'data.bin')),edited);
    assert.notEqual(first.snapshot,second.snapshot);
  }finally{f.cleanup();}
});

test('restore never overwrites existing targets and selective restore preserves relative paths',()=>{
  const f=fixture();try {
    put(f.source,'a/b/file.txt','selected');put(f.source,'other','not selected');const b=backup(f);
    const target=path.join(f.base,'existing');fs.mkdirSync(target);put(target,'sentinel','keep');
    call(['restore',f.repo,b.snapshot,target],{status:1});assert.equal(fs.readFileSync(path.join(target,'sentinel'),'utf8'),'keep');
    call(['restore',f.repo,b.snapshot,path.join(f.base,'not-found'),'--prefix','absent'],{status:1});
    const selected=path.join(f.base,'selected');call(['restore',f.repo,b.snapshot,selected,'--prefix','a/b/file.txt']);
    assert.equal(fs.readFileSync(path.join(selected,'a','b','file.txt'),'utf8'),'selected');
    assert.ok(!fs.existsSync(path.join(selected,'other')));
  }finally{f.cleanup();}
});

test('corrupt/missing objects fail verification and restore without creating output',()=>{
  const f=fixture();try {
    put(f.source,'important','original');const b=backup(f);const id=snapshot(f,b.snapshot).entries[0].chunks[0].id;
    const object=path.join(f.repo,'objects',id.slice(0,2),id);
    fs.writeFileSync(object,'corrupt!');
    call(['verify',f.repo,b.snapshot],{status:1});
    const target=path.join(f.base,'no-partial');call(['restore',f.repo,b.snapshot,target],{status:1});assert.ok(!fs.existsSync(target));
    call(['backup',f.repo,f.source],{status:1});assert.equal(fs.readdirSync(path.join(f.repo,'snapshots')).length,1);
    fs.unlinkSync(object);call(['verify',f.repo,b.snapshot],{status:1});
  }finally{f.cleanup();}
});

test('manifest tampering is detected before JSON parsing',()=>{
  const f=fixture();try {
    put(f.source,'data','original');const b=backup(f);const file=path.join(f.repo,'snapshots',b.snapshot+'.json');
    fs.appendFileSync(file,' ');call(['verify',f.repo,b.snapshot],{status:1});call(['list',f.repo],{status:1});
  }finally{f.cleanup();}
});

test('hash-valid hostile manifests reject traversal collision topology and reordered chunks',()=>{
  const f=fixture();try {
    put(f.source,'dir/data',randomBytes(3000));const b=backup(f,'--min','64','--avg','128','--max','512');
    const original=snapshot(f,b.snapshot);
    const attacks=[
      s=>s.entries[1].path='../escape',
      s=>s.entries.push({...s.entries[1],path:'DIR/DATA'}),
      s=>s.entries=s.entries.filter(e=>e.kind!=='dir'),
      s=>s.entries[1].kind='link',
      s=>s.entries[1].chunks[0].id='../bad',
      s=>s.entries[1].size='-1',
      s=>s.format=99,
      s=>s.entries[1].chunks.reverse(),
      s=>s.entries[1].path='NUL.txt',
    ];
    for(const attack of attacks){const s=structuredClone(original);attack(s);const id=forge(f,s);
      const dest=path.join(f.base,'hostile');call(['restore',f.repo,id,dest],{status:1});assert.ok(!fs.existsSync(dest));}
    assert.ok(!fs.existsSync(path.join(f.base,'escape')));
  }finally{f.cleanup();}
});

test('backup refuses overlapping paths unsafe options sparse oversize files and hard links',()=>{
  const f=fixture();try {
    call(['backup',f.repo,f.base],{status:1});call(['backup',f.repo,f.repo],{status:1});
    for(const options of [['--avg','129'],['--max','99999999'],['--min','-1'],['--label','a','--label','b'],['--unknown','x'],['--exclude','../x']]){
      call(['backup',f.repo,f.source,...options],{status:1});}
    put(f.source,'hard','data');fs.linkSync(path.join(f.source,'hard'),path.join(f.source,'hard2'));
    call(['backup',f.repo,f.source],{status:1});fs.unlinkSync(path.join(f.source,'hard2'));
    const sparse=path.join(f.source,'huge');const fd=fs.openSync(sparse,'wx');fs.ftruncateSync(fd,2147483649);fs.closeSync(fd);
    call(['backup',f.repo,f.source],{status:1});
    assert.equal(fs.readdirSync(path.join(f.repo,'snapshots')).length,0);
  }finally{f.cleanup();}
});

test('junction/symlink source and repository components are rejected',()=>{
  const f=fixture();try {
    const outside=path.join(f.base,'outside');fs.mkdirSync(outside);put(outside,'private','never');
    fs.symlinkSync(outside,path.join(f.source,'linked'),process.platform==='win32'?'junction':'dir');
    call(['backup',f.repo,f.source],{status:1});
    fs.unlinkSync(path.join(f.source,'linked'));
    const alias=path.join(f.base,'alias');fs.symlinkSync(f.repo,alias,process.platform==='win32'?'junction':'dir');
    call(['list',alias],{status:1});
  }finally{f.cleanup();}
});

test('caught write failure does not publish a snapshot; recovery cleans only temporary data',()=>{
  const f=fixture();try {
    put(f.source,'data',randomBytes(50000));
    call(['backup',f.repo,f.source],{status:1,env:{MOONRESTORE_TEST_FAILURE:'manifest-written'}});
    assert.equal(fs.readdirSync(path.join(f.repo,'snapshots')).length,0);
    const result=call(['recover',f.repo]);assert.ok(result.removed_temporary_files>0);assert.equal(result.committed_data_deleted,false);
    const b=backup(f);assert.equal(b.stored_bytes,'0');call(['verify',f.repo,b.snapshot]);
  }finally{f.cleanup();}
});

test('process termination at object/manifest commit leaves no snapshot and safely restarts',()=>{
  for(const point of ['object-written','manifest-written']){
    const f=fixture();try {
      put(f.source,'data',randomBytes(90000));
      call(['backup',f.repo,f.source],{status:86,env:{MOONRESTORE_TEST_CRASH:point}});
      assert.equal(fs.readdirSync(path.join(f.repo,'snapshots')).length,0);
      call(['list',f.repo],{status:1});call(['recover',f.repo]);
      const b=backup(f);call(['verify',f.repo,b.snapshot]);
      const out=path.join(f.base,'restored');call(['restore',f.repo,b.snapshot,out]);assert.deepEqual(tree(out),tree(f.source));
    }finally{f.cleanup();}
  }
});

test('terminated restore stages privately and never exposes a partial destination',()=>{
  const f=fixture();try {
    put(f.source,'data','original');const b=backup(f);const dest=path.join(f.base,'restore');
    call(['restore',f.repo,b.snapshot,dest],{status:86,env:{MOONRESTORE_TEST_CRASH:'restore-written'}});
    assert.ok(!fs.existsSync(dest));assert.ok(fs.readdirSync(f.base).some(x=>x.endsWith('.partial')));
    call(['recover',f.repo]);call(['restore',f.repo,b.snapshot,dest]);assert.deepEqual(tree(dest),tree(f.source));
  }finally{f.cleanup();}
});

test('concurrent owners and foreign-host recovery fail closed',()=>{
  const f=fixture();const h=new Host();try {
    const invoke=(op,a)=>JSON.parse(h.execute(op,JSON.stringify(a),Buffer.alloc(0)));
    assert.ok(invoke('open',{path:f.repo}).ok);assert.ok(invoke('lock',null).ok);
    call(['list',f.repo],{status:1});call(['recover',f.repo],{status:1});h.clean();
    fs.mkdirSync(path.join(f.repo,'.lock'));
    fs.writeFileSync(path.join(f.repo,'.lock','owner.json'),JSON.stringify({pid:999999,host:os.hostname()+'-foreign'}));
    call(['recover',f.repo],{status:1});assert.ok(fs.existsSync(path.join(f.repo,'.lock')));
  }finally{h.clean();f.cleanup();}
});

test('bounded platform reads and low-level path IDs cannot escape repository',()=>{
  const f=fixture();const h=new Host();try {
    const invoke=(op,a)=>JSON.parse(h.execute(op,JSON.stringify(a),Buffer.alloc(0)));
    invoke('open',{path:f.repo});invoke('lock',null);
    assert.equal(invoke('get',{id:'../../outside'}).ok,false);
    assert.equal(invoke('manifest',{id:'x'.repeat(64)}).ok,false);
    assert.equal(invoke('read_source',{max:100000000}).ok,false);
  }finally{h.clean();f.cleanup();}
});

test('seeded multi-version user simulations restore byte-identical trees',()=>{
  const f=fixture();try {
    const versions=[];
    for(let v=0;v<8;v++){
      put(f.source,'实验/样本.bin',randomBytes(10000+v*1007,v+42));
      put(f.source,'论文.txt',`revision ${v}\n`);put(f.source,`batch${v}/empty`,Buffer.alloc(0));
      if(v===4)fs.unlinkSync(path.join(f.source,'论文.txt'));
      const expected=tree(f.source);const b=backup(f,'--label',`revision-${v}`);versions.push({b,expected});
    }
    for(let i=0;i<versions.length;i++){
      const dest=path.join(f.base,`version-${i}`);call(['restore',f.repo,versions[i].b.snapshot,dest]);assert.deepEqual(tree(dest),versions[i].expected);
    }
  }finally{f.cleanup();}
});
