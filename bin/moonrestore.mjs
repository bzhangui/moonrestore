#!/usr/bin/env node
import { Host } from '../platform/adapter.mjs';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const host = new Host();
globalThis.__moonrestore_host = host;
const built = new URL('../_build/js/release/build/cmd/main/main.js', import.meta.url);
if (!fs.existsSync(fileURLToPath(built))) {
  console.error('MoonRestore 尚未构建。请在项目目录执行：moon build --target js --release');
  process.exitCode = 2;
} else {
  try { await import(built.href); }
  catch (e) { console.error(`MoonRestore failed: ${e.message}`); process.exitCode = 1; }
  finally { try { host.clean(); } catch(e) { console.error(`Cleanup failed: ${e.message}`); process.exitCode = 1; } }
}
