// Side-load the companion into VS Code's extensions dir (developer mode — no signing).
// Copies companion/{package.json,README.md,src/} into
//   ~/.vscode/extensions/<publisher>.<name>-<version>/
// and writes repo-path.json so the installed extension resolves patch/patcher.js from
// this repo. Re-run after editing the companion. `--uninstall` removes it.
//
//   node companion/install.mjs            # install / reinstall
//   node companion/install.mjs --uninstall

import { mkdirSync, copyFileSync, writeFileSync, rmSync, cpSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));      // .../claude-deck/companion
const REPO = join(HERE, '..');                            // .../claude-deck
const pkg = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8'));
const home = process.env.USERPROFILE || process.env.HOME;
if (!home) { console.error('cannot resolve home dir'); process.exit(1); }
const DEST = join(home, '.vscode', 'extensions', `${pkg.publisher}.${pkg.name}-${pkg.version}`);

if (process.argv.includes('--uninstall')) {
  rmSync(DEST, { recursive: true, force: true });
  console.log(`uninstalled: ${DEST}`);
  process.exit(0);
}

rmSync(DEST, { recursive: true, force: true });
mkdirSync(DEST, { recursive: true });
copyFileSync(join(HERE, 'package.json'), join(DEST, 'package.json'));
if (existsSync(join(HERE, 'README.md'))) copyFileSync(join(HERE, 'README.md'), join(DEST, 'README.md'));
cpSync(join(HERE, 'src'), join(DEST, 'src'), { recursive: true });
writeFileSync(join(DEST, 'repo-path.json'), JSON.stringify({ repo: REPO }, null, 2) + '\n');

console.log(`installed: ${DEST}`);
console.log(`  main:       ${pkg.main}`);
console.log(`  patcher via repo-path.json -> ${REPO}`);
console.log('Reload VS Code (Developer: Reload Window) to activate — it will re-patch on load and on every Claude Code update.');
