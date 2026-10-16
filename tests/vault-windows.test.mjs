import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fixture,put,call} from './helpers.mjs';

test('Windows DPAPI key store permits current-user access without persisting the password',{skip:process.platform!=='win32'},()=>{
  const f=fixture();try{const repo=path.join(f.base,'encrypted'),env={MOONRESTORE_HOME:path.join(f.base,'state'),MOONRESTORE_PASSWORD:'controlled-test-password'};
    call(['init-encrypted',repo],{env});put(f.source,'file','data');call(['backup',repo,f.source],{env});
    const r=call(['key-store',repo],{env});assert.equal(r.stored_for_current_windows_user,true);assert.ok(!fs.readFileSync(r.file).includes(Buffer.from('controlled-test-password')));
    call(['list',repo],{env:{...env,MOONRESTORE_PASSWORD:''}});call(['key-export',repo,'--output',path.join(repo,'bad-key.json')],{env,status:1});
    assert.equal(fs.existsSync(path.join(repo,'bad-key.json')),false);
  }finally{f.cleanup();}
});
