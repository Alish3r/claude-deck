// Bootstrap entry (NOT bundled — copied as-is by build.mjs; becomes manifest CodePath).
// Registers crash handlers BEFORE dynamically importing the real bundle (plugin.js), so
// even an import-time failure (a bad native addon, a missing dependency) is captured —
// process.on('uncaughtException'/'unhandledRejection') cannot catch a synchronous
// top-level `import` failure in the entry module itself, but it CAN catch a rejected
// dynamic import() awaited in a try/catch, which is what this file does.

import { writeFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LOG = join(tmpdir(), 'langcycle-plugin-crash.log');
// Append-only log with a cap: Stream Deck restarts a crashing plugin in a loop, and an
// unbounded log would grow forever. Reset it when it passes ~256KB (fresh runs rewrite it
// quickly anyway; the tail that matters is always the most recent crash).
try { if (statSync(LOG).size > 262144) writeFileSync(LOG, ''); } catch { /* absent */ }
const log = (label, e) => {
  try { writeFileSync(LOG, `[${new Date().toISOString()}] ${label}: ${(e && e.stack) || e}\n`, { flag: 'a' }); } catch { /* ignore */ }
};

process.on('uncaughtException', (e) => log('uncaughtException', e));
process.on('unhandledRejection', (e) => log('unhandledRejection', e));
log('bootstrap start', `node=${process.version} argv=${JSON.stringify(process.argv.slice(2))}`);

const HERE = dirname(fileURLToPath(import.meta.url));
try {
  // dynamic import() requires a file:// URL on Windows — a raw "C:\..." path throws
  // ERR_UNSUPPORTED_ESM_URL_SCHEME.
  await import(pathToFileURL(join(HERE, 'plugin.js')).href);
  log('plugin.js imported', 'ok');
} catch (e) {
  log('plugin.js import FAILED', e);
}
