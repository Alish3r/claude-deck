// launcher/tools/capture-fixtures.mjs — capture REAL `claude` TUI frames into launcher/fixtures/.
// Spawns claude in a PTY, drives it through states, snapshots raw bytes (ANSI intact) so the
// idle-detector is validated against the actual interface, not a mental model of it.
//   node tools/capture-fixtures.mjs idle          # no prompt sent → zero API cost
//   node tools/capture-fixtures.mjs busy "say hi"  # sends a tiny prompt, grabs spinner/footer frames
import { spawn } from '@lydell/node-pty';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '..', 'fixtures');
const mode = process.argv[2] || 'idle';
const prompt = process.argv[3] || 'say hi in one word';
const claude = process.platform === 'win32' ? 'claude.cmd' : 'claude';

mkdirSync(FIXTURES, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pty = spawn(process.platform === 'win32' ? 'cmd.exe' : claude,
  process.platform === 'win32' ? ['/c', claude] : [],
  { name: 'xterm-256color', cols: 100, rows: 30, cwd: process.cwd(), env: process.env });

let buf = '';
pty.onData((d) => { buf += d; });

function snapshot(name, text) {
  const p = join(FIXTURES, `${name}.txt`);
  writeFileSync(p, text);
  console.log(`wrote ${p} (${text.length} bytes)`);
}

const strip = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b[()][AB012]|\x1b[78Mc]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '');
const tail = () => strip(buf).slice(-800);          // current frame only, not the whole accumulated buffer

async function drainOnboarding() {
  // A freshly-spawned claude walks through several first-run gates (trust folder, browser tools, …),
  // each a "❯ 1. …  Enter to confirm" selection. Accept the default on each until the input box appears.
  // (Capture-tool only — the launcher itself NEVER auto-accepts; it refuses on any permission.)
  for (let i = 0; i < 8; i++) {
    const t = tail();
    if (/[│|]\s*>\s/.test(t) && !/❯\s*\d+\./.test(t)) return true;   // real input box, no pending selection
    if (/Enter to confirm|❯\s*\d+\./.test(t)) { pty.write('\r'); await sleep(3500); continue; }
    await sleep(1500);
  }
  return /[│|]\s*>\s/.test(tail());
}

async function repaint() {                 // Ink only redraws on change — a resize forces a full frame
  buf = ''; pty.resize(101, 30); await sleep(400); pty.resize(100, 30); await sleep(1500);
}

(async () => {
  await sleep(6000);                       // let the first frame render (trust gate or prompt)
  const reachedIdle = await drainOnboarding();
  console.log('reached input box:', reachedIdle);
  if (mode === 'idle') {
    await repaint();
    snapshot('idle', buf.slice(-4000));    // freshly-repainted settled idle prompt
  } else if (mode === 'busy') {
    buf = '';
    pty.write(prompt + '\r');
    await sleep(1200);                      // grab the spinner/footer window mid-turn
    snapshot('busy', buf.slice(0, 4000));
    await sleep(9000);                      // let it finish
    await repaint();
    snapshot('reply-then-idle', buf.slice(-4000));
  }
  try { pty.kill(); } catch { /* already gone */ }
  await sleep(300);
  process.exit(0);
})();
setTimeout(() => { try { pty.kill(); } catch { /* */ } process.exit(1); }, 90000).unref();
