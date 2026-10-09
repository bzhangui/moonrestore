// OS capabilities only. CDC, all content hashes, manifest rules, backup/restore
// decisions and diffing live in MoonBit. No user credentials or external calls.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function publishDirectory(source, target) {
  if (process.platform === 'win32') { fs.renameSync(source,target); return; }
  const helper = fileURLToPath(new URL('../_build/host/rename_noreplace',import.meta.url));
  if (!exists(helper)) throw new Error('Exclusive rename helper missing; run npm run build');
  const result = spawnSync(helper,[source,target],{encoding:'utf8',timeout:10000,shell:false});
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr.trim() || 'Exclusive rename failed');
}

const MAGIC = 'moonrestore-repository-v1\n';
const exists = p => { try { fs.lstatSync(p); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const contains = (a, b) => samePath(a, b) || (process.platform === 'win32' ? b.toLowerCase().startsWith(a.toLowerCase() + path.sep) : b.startsWith(a + path.sep));

function checkedPath(input, mustExist = true) {
  if (typeof input !== 'string' || !input || input.includes('\0')) throw new Error('Invalid filesystem path');
  const full = path.resolve(input);
  const root = path.parse(full).root;
  let p = root;
  for (const part of full.slice(root.length).split(path.sep).filter(Boolean)) {
    p = path.join(p, part);
    if (exists(p)) {
      const s = fs.lstatSync(p);
      if (s.isSymbolicLink()) throw new Error(`Links/junctions are not supported: ${p}`);
    } else if (mustExist) throw new Error(`Path does not exist: ${p}`);
  }
  return full;
}

function safeRelative(rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 1024 || /[\x00-\x1f\x7f\\:*?"<>|]/u.test(rel)) throw new Error('Unsafe relative path');
  for (const part of rel.split('/')) {
    if (!part || part === '.' || part === '..' || part.length > 255 || /[. ]$/.test(part) || /^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)) throw new Error('Unsafe relative component');
  }
  return rel;
}
const idPath = id => { if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid content ID'); return id; };

function syncDir(p) {
  // Windows does not expose portable directory fsync through Node. Documented
  // durability boundary: file contents are synced; rename metadata is best effort.
  if (process.platform !== 'win32') {
    const fd = fs.openSync(p, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
}

function readBounded(p, max) {
  checkedPath(p);
  const s = fs.lstatSync(p);
  if (!s.isFile() || s.size > max || s.nlink !== 1) throw new Error('Not a bounded regular file');
  const fd = fs.openSync(p, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const now = fs.fstatSync(fd);
    if (now.dev !== s.dev || now.ino !== s.ino || now.size !== s.size) throw new Error('File changed before read');
    const buf = Buffer.alloc(now.size);
    let offset = 0;
    while (offset < buf.length) {
      const n = fs.readSync(fd, buf, offset, buf.length - offset, null);
      if (!n) throw new Error('Unexpected end of file');
      offset += n;
    }
    const after = fs.fstatSync(fd);
    if (after.size !== now.size || after.mtimeMs !== now.mtimeMs || after.ctimeMs !== now.ctimeMs) throw new Error('File changed during read');
    return buf;
  } finally { fs.closeSync(fd); }
}

function writeNew(p, bytes) {
  checkedPath(path.dirname(p));
  const fd = fs.openSync(p, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

export class Host {
  constructor() {
    this.repo = null; this.held = false; this.source = null;
    this.sourceEntries = new Map(); this.sourceRootStat = null; this.reader = null; this.restore = null;
    this.bytes = new Uint8Array(); this.writes = 0;
  }
  execute(op, text, bytes) {
    try { this.bytes = new Uint8Array(); return JSON.stringify({ok: true, value: this.operation(op, JSON.parse(text), bytes)}); }
    catch (e) { return JSON.stringify({ok: false, error: e.message}); }
  }
  repoPath(rel) {
    if (!this.repo) throw new Error('Repository not open');
    return checkedPath(path.join(this.repo, rel), false);
  }
  requireLock() { if (!this.held) throw new Error('Repository lock required'); }
  lock() {
    const p = this.repoPath('.lock');
    try { fs.mkdirSync(p, {mode: 0o700}); }
    catch (e) { if (e.code === 'EEXIST') throw new Error('Repository locked; use recover only after the owning process has stopped'); throw e; }
    try { writeNew(path.join(p, 'owner.json'), Buffer.from(JSON.stringify({pid: process.pid, host: os.hostname(), created: new Date().toISOString()}))); }
    catch (e) { fs.rmdirSync(p); throw e; }
    this.held = true;
  }
  unlock() {
    if (this.held) {
      const p = this.repoPath('.lock');
      fs.unlinkSync(checkedPath(path.join(p, 'owner.json')));
      fs.rmdirSync(p); this.held = false;
    }
  }
  clean() {
    if (this.reader) { fs.closeSync(this.reader.fd); this.reader = null; }
    if (this.restore) {
      if (this.restore.fd !== null) fs.closeSync(this.restore.fd);
      this.restore.fd = null;
      // Keep incomplete restore staging for diagnosis; never publish it or erase
      // an external path automatically. Status/recover reports its location.
      this.restore = null;
    }
    this.unlock();
  }
  store(id, bytes) {
    this.requireLock(); idPath(id);
    const final = this.repoPath(`objects/${id.slice(0,2)}/${id}`);
    if (exists(final)) { this.bytes = readBounded(final, 1048576); return {created: false}; }
    const parent = path.dirname(final);
    if (!exists(parent)) fs.mkdirSync(parent, {mode: 0o700});
    const temp = this.repoPath(`tmp/${randomUUID()}.part`);
    writeNew(temp, bytes);
    this.failpoint('object-written');
    fs.renameSync(temp, final); syncDir(parent);
    this.writes++;
    return {created: true};
  }
  failpoint(point) {
    if (process.env.MOONRESTORE_TEST_FAILURE === point) throw new Error(`Injected failure: ${point}`);
    if (process.env.MOONRESTORE_TEST_CRASH === point) {
      process.stdout.write(`CRASH_POINT:${point}\n`);
      process.exit(86);
    }
  }
  walk(source, excludes, limits) {
    const root = checkedPath(source);
    if (!fs.lstatSync(root).isDirectory()) throw new Error('Source must be a directory');
    if (contains(root, this.repo) || contains(this.repo, root)) throw new Error('Source and repository must not overlap');
    this.source = root; this.sourceRootStat = fs.lstatSync(root); this.sourceEntries.clear();
    const out = []; let total = 0;
    for (const rel of excludes) safeRelative(rel);
    const skipped = rel => excludes.some(ex => rel === ex || rel.startsWith(ex + '/'));
    const visit = (dir, prefix, depth) => {
      if (depth > 64) throw new Error('Directory depth limit exceeded');
      // Directory enumeration is incremental, not an unbounded readdir array.
      const iterator = fs.opendirSync(dir);
      try {
        for (let d = iterator.readSync(); d !== null; d = iterator.readSync()) {
          const rel = prefix ? `${prefix}/${d.name}` : d.name;
          if (skipped(rel)) continue;
          safeRelative(rel);
          if (out.length >= limits.max_files) throw new Error('Entry count limit exceeded');
          const p = checkedPath(path.join(dir, d.name));
          const stat = fs.lstatSync(p);
          if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error(`Unsupported link/special file: ${rel}`);
          if (stat.isFile() && stat.nlink !== 1) throw new Error(`Hard links are unsupported: ${rel}`);
          if (stat.isFile() && stat.size > limits.max_file_bytes) throw new Error(`File size limit exceeded: ${rel}`);
          total += stat.isFile() ? stat.size : 0;
          if (total > limits.max_total_bytes) throw new Error('Source byte limit exceeded');
          const kind = stat.isDirectory() ? 'dir' : 'file';
          out.push({path: rel, kind, size: String(kind === 'dir' ? 0 : stat.size)});
          this.sourceEntries.set(rel, {p, stat});
          if (kind === 'dir') visit(p, rel, depth + 1);
        }
      } finally { iterator.closeSync(); }
    };
    visit(root, '', 0);
    out.sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    return out;
  }
  unchanged(a, b) { return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs; }
  operation(op, a, bytes) {
    switch(op) {
      case 'init': {
        const p = checkedPath(a.path, false);
        if (exists(p)) throw new Error('Repository target must not exist');
        checkedPath(path.dirname(p));
        fs.mkdirSync(p, {mode: 0o700});
        for (const name of ['objects','snapshots','tmp']) fs.mkdirSync(path.join(p,name), {mode: 0o700});
        writeNew(path.join(p,'moonrestore'), Buffer.from(MAGIC)); syncDir(p);
        return {path: p, format: 1};
      }
      case 'open': {
        this.repo = checkedPath(a.path);
        if (readBounded(this.repoPath('moonrestore'), 128).toString('utf8') !== MAGIC) throw new Error('Not a MoonRestore repository');
        for (const name of ['objects','snapshots','tmp']) if (!fs.lstatSync(this.repoPath(name)).isDirectory()) throw new Error('Invalid repository layout');
        return null;
      }
      case 'lock': this.lock(); return null;
      case 'unlock': this.unlock(); return null;
      case 'clock': return new Date().toISOString();
      case 'walk': this.requireLock(); return this.walk(a.source, a.excludes, a.limits);
      case 'open_source': {
        this.requireLock(); if (this.reader) throw new Error('Source already open');
        const entry = this.sourceEntries.get(safeRelative(a.path));
        if (!entry) throw new Error('Unknown source entry');
        checkedPath(entry.p);
        const fd = fs.openSync(entry.p, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
        const now = fs.fstatSync(fd);
        if (!now.isFile() || now.nlink !== 1 || !this.unchanged(entry.stat, now)) { fs.closeSync(fd); throw new Error('Source changed before backup'); }
        this.reader = {fd, initial: now, bytes: 0}; return null;
      }
      case 'read_source': {
        if (!this.reader || !Number.isInteger(a.max) || a.max < 1 || a.max > 1048576) throw new Error('Invalid source read');
        const buf = Buffer.alloc(a.max);
        const count = fs.readSync(this.reader.fd, buf, 0, a.max, null);
        this.reader.bytes += count;
        if (this.reader.bytes > this.reader.initial.size) throw new Error('Source grew during backup');
        this.bytes = buf.subarray(0,count); return count;
      }
      case 'close_source': {
        if (!this.reader) throw new Error('No source open');
        const r = this.reader; this.reader = null;
        try { if (!this.unchanged(r.initial, fs.fstatSync(r.fd)) || r.bytes !== r.initial.size) throw new Error('Source changed during backup'); }
        finally { fs.closeSync(r.fd); }
        return null;
      }
      case 'check_source': {
        if (!this.unchanged(this.sourceRootStat,fs.lstatSync(checkedPath(this.source)))) throw new Error('Source root changed during backup');
        for (const {p, stat} of this.sourceEntries.values()) {
          if (!this.unchanged(stat, fs.lstatSync(checkedPath(p)))) throw new Error('Source tree changed during backup');
        }
        return null;
      }
      case 'put': return this.store(a.id, bytes);
      case 'get': this.requireLock(); this.bytes = readBounded(this.repoPath(`objects/${idPath(a.id).slice(0,2)}/${a.id}`), 1048576); return this.bytes.length;
      case 'commit': {
        this.requireLock(); idPath(a.id);
        if (bytes.length > 33554432) throw new Error('Manifest too large');
        const final = this.repoPath(`snapshots/${a.id}.json`);
        if (exists(final)) throw new Error('Snapshot already exists');
        const temp = this.repoPath(`tmp/${randomUUID()}.manifest`);
        writeNew(temp, bytes); this.failpoint('manifest-written');
        fs.renameSync(temp, final); syncDir(path.dirname(final));
        return null;
      }
      case 'manifest': this.requireLock(); this.bytes = readBounded(this.repoPath(`snapshots/${idPath(a.id)}.json`), 33554432); return this.bytes.length;
      case 'list': {
        this.requireLock(); const ids = [];
        const dir = fs.opendirSync(this.repoPath('snapshots'));
        try { for (let d = dir.readSync(); d !== null; d = dir.readSync()) {
          if (!/^[a-f0-9]{64}\.json$/.test(d.name)) throw new Error('Unexpected snapshot file');
          if (ids.length >= 100000) throw new Error('Snapshot count limit exceeded');
          ids.push(d.name.slice(0,-5));
        } } finally { dir.closeSync(); }
        return ids.sort();
      }
      case 'inventory': {
        this.requireLock(); const out = [];
        const root = this.repoPath('objects'); const shards = fs.opendirSync(root);
        try { for(let shard=shards.readSync();shard!==null;shard=shards.readSync()) {
          if(!/^[a-f0-9]{2}$/.test(shard.name)) throw new Error('Unexpected object shard');
          const p=checkedPath(path.join(root,shard.name));
          if(!fs.lstatSync(p).isDirectory()) throw new Error('Invalid object shard');
          const files=fs.opendirSync(p);
          try { for(let file=files.readSync();file!==null;file=files.readSync()) {
            idPath(file.name);
            if(!file.name.startsWith(shard.name)) throw new Error('Object in incorrect shard');
            const s=fs.lstatSync(checkedPath(path.join(p,file.name)));
            if(!s.isFile()||s.nlink!==1||s.size>1048576) throw new Error('Invalid object file');
            if(out.length>=1000000) throw new Error('Object inventory limit exceeded');
            out.push({id:file.name,size:s.size});
          }} finally {files.closeSync();}
        }} finally {shards.closeSync();}
        return out;
      }
      case 'recover': {
        const p = this.repoPath('.lock');
        if (exists(p)) {
          const owner = JSON.parse(readBounded(path.join(p,'owner.json'), 1024).toString('utf8'));
          if (owner.host !== os.hostname() || !Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error('Cannot safely recover foreign/invalid lock');
          try { process.kill(owner.pid, 0); throw new Error('Lock owner is still running'); }
          catch (e) { if (e.code !== 'ESRCH') throw e; }
          fs.unlinkSync(path.join(p,'owner.json')); fs.rmdirSync(p);
        }
        this.lock();
        let removed = 0;
        // Temp cleanup only; committed chunks/snapshots are NEVER deleted here.
        const dir = this.repoPath('tmp');
        const files=fs.opendirSync(dir); let visited=0;
        try { for(let entry=files.readSync();entry!==null;entry=files.readSync()) {
          if(++visited>100000) throw new Error('Temporary entry limit exceeded');
          const name=entry.name;
          if (!/^[a-f0-9-]{36}\.(part|manifest)$/.test(name)) continue;
          const f = checkedPath(path.join(dir,name));
          if (!fs.lstatSync(f).isFile()) throw new Error('Unexpected temporary entry');
          fs.unlinkSync(f); removed++;
        }} finally {files.closeSync();}
        this.unlock(); return {removed_temporary_files: removed, committed_data_deleted: false};
      }
      case 'begin_restore': {
        this.requireLock(); if (this.restore) throw new Error('Restore already active');
        const target = checkedPath(a.target, false);
        if (exists(target)) throw new Error('Restore target must not exist');
        if (contains(this.repo, target) || contains(target, this.repo)) throw new Error('Restore/repository overlap');
        const parent = checkedPath(path.dirname(target));
        const stage = path.join(parent, `.moonrestore-${randomUUID()}.partial`);
        fs.mkdirSync(stage, {mode: 0o700});
        this.restore = {target, parent, stage, fd: null}; return {staging: stage};
      }
      case 'restore_dir': {
        if (!this.restore) throw new Error('Restore not active');
        const p = path.join(this.restore.stage,safeRelative(a.path)); checkedPath(p,false);
        fs.mkdirSync(p, {mode: 0o700}); syncDir(path.dirname(p)); return null;
      }
      case 'restore_open': {
        if (!this.restore || this.restore.fd !== null) throw new Error('Invalid restore open');
        const p = path.join(this.restore.stage,safeRelative(a.path)); checkedPath(p,false);
        this.restore.fd = fs.openSync(p,'wx',0o600); this.restore.fileParent = path.dirname(p); return null;
      }
      case 'restore_write': if (!this.restore || this.restore.fd === null) throw new Error('No restore file open'); fs.writeFileSync(this.restore.fd,bytes); this.failpoint('restore-written'); return null;
      case 'restore_close': {
        if (!this.restore || this.restore.fd === null) throw new Error('No restore file open');
        fs.fsyncSync(this.restore.fd); fs.closeSync(this.restore.fd); this.restore.fd = null;
        syncDir(this.restore.fileParent); return null;
      }
      case 'finish_restore': {
        const r = this.restore; if (!r || r.fd !== null) throw new Error('Invalid restore completion');
        if (exists(r.target)) throw new Error('Restore target appeared; refusing overwrite');
        checkedPath(r.parent); syncDir(r.stage); this.failpoint('restore-complete');
        publishDirectory(r.stage,r.target); syncDir(r.parent); this.restore = null;
        return {target: r.target};
      }
      default: throw new Error(`Unsupported operation: ${op}`);
    }
  }
}
