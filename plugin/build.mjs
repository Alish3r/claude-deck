// Build + side-load the Claude Deck Stream Deck plugin.
//   node plugin/build.mjs            # bundle -> assemble .sdPlugin -> install into SD Plugins
//   node plugin/build.mjs --no-install
//
// esbuild bundles src/plugin.js into one self-contained file (inlines @elgato/streamdeck
// and the patch/effort.js dep), so the .sdPlugin has no node_modules and no repo-relative
// imports. Icons are branded SVGs (Claude clay + teal).

import { build } from 'esbuild';
import sharp from 'sharp';
import { mkdirSync, rmSync, cpSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));            // .../plugin
const UUID = 'com.alisher.claude-deck';
const STAGE = join(HERE, 'dist', `${UUID}.sdPlugin`);
const home = process.env.USERPROFILE || process.env.HOME;
const SD_PLUGINS = join(home, 'AppData', 'Roaming', 'Elgato', 'StreamDeck', 'Plugins');
const install = !process.argv.includes('--no-install');

// --- icons (SVG; Claude clay #d97757, teal #4fd6be on dark) ---
const svg = (inner, bg = true) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72">` +
  (bg ? `<rect width="72" height="72" rx="14" fill="#141518"/>` : '') + inner + `</svg>`;
const SPARK = `<path d="M36 16l4.5 13.5L54 34l-13.5 4.5L36 52l-4.5-13.5L18 34l13.5-4.5z" fill="none" stroke="#d97757" stroke-width="3.2" stroke-linejoin="round"/>`;
const GAUGE = `<path d="M20 46a16 16 0 1 1 32 0" fill="none" stroke="#4fd6be" stroke-width="3.4" stroke-linecap="round"/><path d="M36 46l9-9" stroke="#d97757" stroke-width="3.4" stroke-linecap="round"/><circle cx="36" cy="46" r="2.6" fill="#d97757"/>`;
const SLIDERS = `<g stroke="#d97757" stroke-width="3.2" stroke-linecap="round"><path d="M22 24h28M22 48h28"/></g><circle cx="30" cy="24" r="4.4" fill="#141518" stroke="#4fd6be" stroke-width="3"/><circle cx="44" cy="48" r="4.4" fill="#141518" stroke="#4fd6be" stroke-width="3"/>`;
// Elgato requires PNG icons at @1x + @2x. Rasterize the branded SVGs with sharp.
const ICONS = [
  { base: 'imgs/plugin/marketplace', svg: svg(SLIDERS), size: 288 },
  { base: 'imgs/plugin/category', svg: svg(SLIDERS), size: 28 },
  { base: 'imgs/actions/model/icon', svg: svg(SPARK), size: 20 },
  { base: 'imgs/actions/model/key', svg: svg(SPARK), size: 72 },
  { base: 'imgs/actions/effort/icon', svg: svg(GAUGE), size: 20 },
  { base: 'imgs/actions/effort/key', svg: svg(GAUGE), size: 72 },
];

async function main() {
  // Best-effort clean; if the SD app holds the linked dir (Windows lock), just overwrite.
  try { rmSync(STAGE, { recursive: true, force: true }); } catch { /* locked — overwrite in place */ }
  mkdirSync(join(STAGE, 'bin'), { recursive: true });

  // 1. bundle the entry (self-contained; node built-ins + sharp stay external — sharp is
  //    a native addon and can't be bundled by esbuild, so its resolved package is copied
  //    into bin/node_modules below for Node's normal require() resolution at runtime).
  await build({
    entryPoints: [join(HERE, 'src', 'plugin.js')],
    outfile: join(STAGE, 'bin', 'plugin.js'),
    bundle: true, platform: 'node', format: 'esm', target: 'node20',
    external: ['sharp'],
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    logLevel: 'info',
  });

  // 1b. copy sharp + the full dependency closure it resolves at runtime (sharp is a
  //     native addon — esbuild can't bundle it, so bin/node_modules must satisfy every
  //     transitive require()/import: detect-libc, semver, @img/colour, … A hand-picked
  //     list here shipped without detect-libc once and the plugin died at import time.
  //     Platform binary: win32-x64 only; the wasm32 fallback is deliberately not shipped
  //     to keep the package small.
  const nm = join(STAGE, 'bin', 'node_modules');
  try { rmSync(nm, { recursive: true, force: true }); } catch { /* locked — cpSync overwrites in place */ }
  const copied = new Set();
  const missing = [];
  // `required`: a missing package must FAIL the build — silently skipping a required dep
  // ships a green build that dies at import time (exactly the detect-libc incident).
  // Only platform-foreign optionals may be absent (we never walk those).
  const copyPkg = (name, { required = true } = {}) => {
    if (copied.has(name)) return;
    copied.add(name);
    const src = join(HERE, 'node_modules', ...name.split('/'));
    if (!existsSync(src)) { if (required) missing.push(name); return; }
    cpSync(src, join(nm, ...name.split('/')), { recursive: true });
    const pkg = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8'));
    for (const dep of Object.keys(pkg.dependencies ?? {})) copyPkg(dep);
  };
  copyPkg('sharp');
  copyPkg('@img/sharp-win32-x64'); // the win32 native binary IS required on this platform
  if (missing.length) throw new Error(`bin/node_modules is missing required packages: ${missing.join(', ')} — run npm install in plugin/`);
  console.log(`bin/node_modules: ${[...copied].sort().join(', ')}`);

  // 1c. bootstrap.js is hand-written (not bundled) — copy verbatim; it becomes CodePath
  //     so crash-handler registration always runs before the real bundle is imported.
  cpSync(join(HERE, 'src', 'bootstrap.js'), join(STAGE, 'bin', 'bootstrap.js'));

  // 2. manifest (CodePath -> the bootstrap, which imports the bundle) + layout
  const manifest = JSON.parse(readFileSync(join(HERE, 'manifest.json'), 'utf8'));
  manifest.CodePath = 'bin/bootstrap.js';
  writeFileSync(join(STAGE, 'manifest.json'), JSON.stringify(manifest, null, 2));
  mkdirSync(join(STAGE, 'layouts'), { recursive: true });
  cpSync(join(HERE, 'layouts'), join(STAGE, 'layouts'), { recursive: true });

  // 3. icons — PNG @1x + @2x
  for (const { base, svg: data, size } of ICONS) {
    mkdirSync(dirname(join(STAGE, base)), { recursive: true });
    const buf = Buffer.from(data);
    await sharp(buf, { density: 384 }).resize(size, size).png().toFile(join(STAGE, `${base}.png`));
    await sharp(buf, { density: 384 }).resize(size * 2, size * 2).png().toFile(join(STAGE, `${base}@2x.png`));
  }

  console.log(`staged: ${STAGE}`);

  if (install) {
    if (!existsSync(SD_PLUGINS)) { console.error(`Stream Deck Plugins dir not found: ${SD_PLUGINS}`); process.exit(1); }
    const dest = join(SD_PLUGINS, `${UUID}.sdPlugin`);
    // A RUNNING plugin locks its dir: a throwing rmSync used to abort AFTER gutting part
    // of the install. Try the clean swap; if locked, fall back to copy-over-in-place
    // (cpSync overwrites files without deleting the dir) and tell the user to restart:
    //   npx @elgato/cli stop com.alisher.claude-deck   (before building) avoids this.
    let cleanSwap = true;
    try { rmSync(dest, { recursive: true, force: true }); } catch { cleanSwap = false; }
    cpSync(STAGE, dest, { recursive: true });
    console.log(`installed: ${dest}${cleanSwap ? '' : ' (dir was locked — overwrote in place; stale files may remain)'}`);
    console.log('Restart the plugin to load it: npx @elgato/cli restart com.alisher.claude-deck');
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
