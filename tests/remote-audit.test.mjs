import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { sha } from "./helpers.mjs";
import { S3Backend } from "../platform/s3.mjs";
import { auditRemote, auditRemoteCycle, remoteWriterPolicy } from "../platform/remote-audit.mjs";
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

async function controlled(work) {
  const objects = new Map(),
    calls = [],
    mode = {
      deny: false,
      wrongVersion: false,
      corrupt: false,
      retention: true,
    };
  const now = Date.now(),
    until = new Date(now + 10 * 86400000).toISOString();
  const paths = [
    "moonrestore",
    "encryption.json",
    "snapshots/" + sha("manifest") + ".json",
  ];
  const members = paths.map((path, i) => {
    const bytes = Buffer.from("encrypted-fixture-" + i),
      key = "owned/" + path,
      version = "v-" + i;
    objects.set("/controlled/" + key, { bytes, version });
    return {
      path,
      key,
      version,
      size: String(bytes.length),
      checksum: sha(bytes),
    };
  });
  const receipt = Buffer.from(
    JSON.stringify({
      format: 1,
      kind: "moonrestore_encrypted_snapshot",
      encrypted: true,
      snapshot: sha("snapshot"),
      members,
    }),
  );
  objects.set("/controlled/owned/receipt.json", {
    bytes: receipt,
    version: "receipt-v1",
  });
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://localhost");
    calls.push({
      method: req.method,
      version: u.searchParams.get("versionId"),
    });
    if (mode.deny) {
      res.writeHead(403);
      return res.end();
    }
    // Model a latest delete marker: only the old, explicitly pinned version exists.
    const item = objects.get(u.pathname);
    if (!item || u.searchParams.get("versionId") !== item.version) {
      res.writeHead(404);
      return res.end();
    }
    res.setHeader(
      "x-amz-version-id",
      mode.wrongVersion ? "unexpected" : item.version,
    );
    if (mode.retention) {
      res.setHeader("x-amz-object-lock-mode", "COMPLIANCE");
      res.setHeader("x-amz-object-lock-retain-until-date", until);
    }
    res.end(mode.corrupt ? Buffer.from("broken") : item.bytes);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const backend = new S3Backend({
    endpoint: "http://127.0.0.1:" + server.address().port,
    bucket: "controlled",
    accessKeyId: "synthetic",
    secretAccessKey: "synthetic-not-a-real-secret",
  });
  try {
    await work({ backend, calls, mode, objects, checksum: sha(receipt), now });
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}
test("remote audit reads only pinned versions despite latest delete marker and never asserts plaintext recovery", () =>
  controlled(async ({ backend, checksum, calls, now }) => {
    await assert.rejects(backend.get("owned/receipt.json"));
    const r = await auditRemote(backend, "owned/receipt.json", checksum, {
      version: "receipt-v1",
      retentionDays: 7,
      now,
    });
    assert.equal(r.checked, 3);
    assert.equal(r.entire_receipt_checked, true);
    assert.equal(r.server_retention_reported, true);
    assert.equal(r.plaintext_content_verified, false);
    assert.equal(r.real_cloud_provider_verified, false);
    assert.equal(r.delete_permission_tested, false);
    assert.ok(calls.every((c) => c.method === "GET"));
    assert.ok(calls.slice(1).every((c) => c.version));
  }));
test("bounded audit pages do not claim complete receipt coverage", () =>
  controlled(async ({ backend, checksum }) => {
    const a = await auditRemote(backend, "owned/receipt.json", checksum, {
      version: "receipt-v1",
      batch: 2,
    });
    const b = await auditRemote(backend, "owned/receipt.json", checksum, {
      version: "receipt-v1",
      offset: a.next_offset,
      batch: 2,
    });
    assert.equal(a.next_offset, 2);
    assert.equal(b.next_offset, null);
    assert.equal(a.entire_receipt_checked, false);
    assert.equal(b.entire_receipt_checked, false);
    await assert.rejects(
      auditRemote(backend, "owned/receipt.json", checksum, {
        version: "receipt-v1",
        offset: 3,
      }),
    );
    await assert.rejects(
      auditRemote(backend, "owned/receipt.json", checksum, { version: "null" }),
    );
  }));
test("revoked access, wrong version, corruption and unreported/short retention fail closed", () =>
  controlled(async ({ backend, mode, checksum, now }) => {
    const run = () =>
      auditRemote(backend, "owned/receipt.json", checksum, {
        version: "receipt-v1",
        retentionDays: 7,
        now,
      });
    mode.deny = true;
    await assert.rejects(run());
    mode.deny = false;
    mode.wrongVersion = true;
    await assert.rejects(run(), /version/);
    mode.wrongVersion = false;
    mode.corrupt = true;
    await assert.rejects(run(), /checksum/);
    mode.corrupt = false;
    mode.retention = false;
    await assert.rejects(run(), /retention/);
    mode.retention = true;
    await assert.rejects(
      auditRemote(backend, "owned/receipt.json", checksum, {
        version: "receipt-v1",
        retentionDays: 11,
        now,
      }),
      /retention/,
    );
  }));
test("write-only-role policy guidance is scoped, denies deletion and never applies IAM changes", () => {
  const p = remoteWriterPolicy("owned-backups", "moonrestore");
  assert.equal(p.applied, false);
  assert.equal(p.template_only, true);
  assert.deepEqual(p.policy.Statement[1].Action, [
    "s3:DeleteObject",
    "s3:DeleteObjectVersion",
    "s3:BypassGovernanceRetention",
  ]);
  assert.ok(
    p.policy.Statement.every(
      (s) => s.Resource === "arn:aws:s3:::owned-backups/moonrestore/*",
    ),
  );
  for (const prefix of ["*", "../escape", "a/b"])
    assert.throws(() => remoteWriterPolicy("owned-backups", prefix));
});

async function cycleFixture(work){
  const parent=fs.realpathSync(os.tmpdir()),home=fs.mkdtempSync(path.join(parent,'moonrestore-audit-cycle-')),previous=process.env.MOONRESTORE_HOME;
  process.env.MOONRESTORE_HOME=home;
  try{await controlled(context=>work({...context,home,cycleId:randomUUID()}));}
  finally{if(previous===undefined)delete process.env.MOONRESTORE_HOME;else process.env.MOONRESTORE_HOME=previous;assert.equal(path.dirname(home),parent);assert.ok(path.basename(home).startsWith('moonrestore-audit-cycle-'));fs.rmSync(home,{recursive:true,force:true});}
}
test('audit cycle authenticates persisted pages and reports complete only after all pinned members',()=>cycleFixture(async({backend,checksum,cycleId})=>{
  const run=()=>auditRemoteCycle(backend,'owned/receipt.json',checksum,{cycleId,version:'receipt-v1',batch:1});
  const a=await run();assert.equal(a.checked,1);assert.equal(a.entire_receipt_checked,false);
  const b=await run();assert.equal(b.checked,2);assert.equal(b.entire_receipt_checked,false);
  const c=await run();assert.equal(c.checked,3);assert.equal(c.entire_receipt_checked,true);assert.equal(c.plaintext_content_verified,false);
  assert.equal((await run()).cached_completed_observation,true);
}));
test('failed audit page preserves cursor, needs explicit retry and cannot count a different receipt',()=>cycleFixture(async({backend,checksum,cycleId,mode})=>{
  const config={cycleId,version:'receipt-v1',batch:1};
  await auditRemoteCycle(backend,'owned/receipt.json',checksum,config);mode.deny=true;
  await assert.rejects(auditRemoteCycle(backend,'owned/receipt.json',checksum,config));mode.deny=false;
  await assert.rejects(auditRemoteCycle(backend,'owned/receipt.json',checksum,config),/explicit retry/);
  assert.equal((await auditRemoteCycle(backend,'owned/receipt.json',checksum,{...config,retry:true})).checked,2);
  await assert.rejects(auditRemoteCycle(backend,'owned/receipt.json',checksum,{...config,version:'other-version'}),/binding/);
}));
test('edited cursor and active lease cannot skip unchecked remote pages',()=>cycleFixture(async({backend,checksum,cycleId,home})=>{
  const config={cycleId,version:'receipt-v1',batch:1};await auditRemoteCycle(backend,'owned/receipt.json',checksum,config);
  const file=path.join(home,'remote-audit-cycles',cycleId+'.json'),saved=JSON.parse(fs.readFileSync(file,'utf8'));
  saved.record.offset=2;fs.writeFileSync(file,JSON.stringify(saved));
  await assert.rejects(auditRemoteCycle(backend,'owned/receipt.json',checksum,config),/authentication/);
  const lock=file+'.lock';fs.mkdirSync(lock);fs.writeFileSync(path.join(lock,'owner.json'),JSON.stringify({pid:process.pid,host:os.hostname()}));
  await assert.rejects(auditRemoteCycle(backend,'owned/receipt.json',checksum,{...config,recover:true}),/active/);
}));
