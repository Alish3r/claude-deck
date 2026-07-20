// Build + side-load the Lang Cycle Stream Deck plugin.
//   node langdeck/build.mjs            # bundle -> assemble .sdPlugin -> install into SD Plugins
//   node langdeck/build.mjs --no-install
//
// Same shape as plugin/build.mjs (the Claude Deck dials), but this is a SEPARATE plugin with
// its own UUID, so deploying the language key never touches the dials and vice versa (#29).
// esbuild bundles src/plugin.js into one self-contained file; the .sdPlugin has no repo-relative
// imports. sharp stays external (native addon) and its dependency closure is copied below.

import { build } from 'esbuild';
import sharp from 'sharp';
import { mkdirSync, rmSync, cpSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));            // .../langdeck
const UUID = 'com.alisher.langcycle';
const STAGE = join(HERE, 'dist', `${UUID}.sdPlugin`);
const home = process.env.USERPROFILE || process.env.HOME;
const SD_PLUGINS = join(home, 'AppData', 'Roaming', 'Elgato', 'StreamDeck', 'Plugins');
const install = !process.argv.includes('--no-install');

// --- icons (SVG; Claude clay #d97757, teal #4fd6be on dark) ---
const svg = (inner, bg = true) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72">` +
  (bg ? `<rect width="72" height="72" rx="14" fill="#141518"/>` : '') + inner + `</svg>`;
const GLOBE = `<circle cx="36" cy="36" r="17" fill="none" stroke="#4fd6be" stroke-width="3.2"/><ellipse cx="36" cy="36" rx="7.5" ry="17" fill="none" stroke="#4fd6be" stroke-width="2.6"/><path d="M19.5 30h33M19.5 42h33" stroke="#d97757" stroke-width="2.6" stroke-linecap="round"/>`;
// Elgato requires PNG icons at @1x + @2x. Rasterize the branded SVGs with sharp.
const ICONS = [
  { base: 'imgs/plugin/marketplace', svg: svg(GLOBE), size: 288 },
  { base: 'imgs/plugin/category', svg: svg(GLOBE), size: 28 },
  { base: 'imgs/actions/lang/icon', svg: svg(GLOBE), size: 20 },
  { base: 'imgs/actions/lang/key', svg: svg(GLOBE), size: 72 },
];

// Every file a loadable bundle MUST contain. A partial install (interrupted cpSync, a locked
// dir, a missed icon) ships a green build that shows "?" on the key — exactly the failure
// this guards against. Verified on BOTH the stage and the installed copy; missing anything
// throws instead of silently shipping. Icons come from ICONS so the list can't drift.
const EXPECT = [
  'manifest.json',
  'bin/bootstrap.js', 'bin/plugin.js',
  'bin/node_modules/sharp/package.json',
  'bin/node_modules/@img/sharp-win32-x64/package.json',
  'ui/inspector.html',
  ...ICONS.flatMap(({ base }) => [`${base}.png`, `${base}@2x.png`]),
];
function verifyBundle(root, label) {
  const missing = EXPECT.filter((p) => !existsSync(join(root, ...p.split('/'))));
  if (missing.length) {
    throw new Error(`${label} is INCOMPLETE — ${missing.length} file(s) missing:\n  ${missing.join('\n  ')}\n`
      + `A partial bundle shows "?" on the key. Stop the plugin first (npx @elgato/cli stop ${UUID}) and re-run the build.`);
  }
  console.log(`${label}: ${EXPECT.length} expected files present ✓`);
}

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
  // This plugin is Windows-only by design (winlang.js posts WM_INPUTLANGCHANGEREQUEST via
  // PowerShell); there is no macOS/Linux build to add sharp binaries for. See README.
  if (missing.length) throw new Error(`bin/node_modules is missing required packages: ${missing.join(', ')} — run npm install in langdeck/`);
  console.log(`bin/node_modules: ${[...copied].sort().join(', ')}`);

  // 1c. bootstrap.js is hand-written (not bundled) — copy verbatim; it becomes CodePath
  //     so crash-handler registration always runs before the real bundle is imported.
  cpSync(join(HERE, 'src', 'bootstrap.js'), join(STAGE, 'bin', 'bootstrap.js'));

  // 1d. property inspector — plain HTML, no build step, copied verbatim (#36). It is in
  //     EXPECT above: a missing PI is a silent partial install (the key still works, the
  //     colour panel is just blank), which is exactly the drift verifyBundle exists to catch.
  cpSync(join(HERE, 'ui'), join(STAGE, 'ui'), { recursive: true });

  // 2. manifest (CodePath -> the bootstrap, which imports the bundle). No layouts/: this
  //    plugin has a single Keypad action.
  const manifest = JSON.parse(readFileSync(join(HERE, 'manifest.json'), 'utf8'));
  manifest.CodePath = 'bin/bootstrap.js';
  writeFileSync(join(STAGE, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // 3. icons — PNG @1x + @2x
  for (const { base, svg: data, size } of ICONS) {
    mkdirSync(dirname(join(STAGE, base)), { recursive: true });
    const buf = Buffer.from(data);
    await sharp(buf, { density: 384 }).resize(size, size).png().toFile(join(STAGE, `${base}.png`));
    await sharp(buf, { density: 384 }).resize(size * 2, size * 2).png().toFile(join(STAGE, `${base}@2x.png`));
  }

  verifyBundle(STAGE, 'staged bundle');
  console.log(`staged: ${STAGE}`);

  if (install) {
    if (!existsSync(SD_PLUGINS)) { console.error(`Stream Deck Plugins dir not found: ${SD_PLUGINS}`); process.exit(1); }
    const dest = join(SD_PLUGINS, `${UUID}.sdPlugin`);
    // A RUNNING plugin locks its dir: a throwing rmSync used to abort AFTER gutting part
    // of the install. Try the clean swap; if locked, fall back to copy-over-in-place
    // (cpSync overwrites files without deleting the dir) and tell the user to restart:
    //   npx @elgato/cli stop com.alisher.langcycle   (before building) avoids this.
    let cleanSwap = true;
    try { rmSync(dest, { recursive: true, force: true }); } catch { cleanSwap = false; }
    cpSync(STAGE, dest, { recursive: true });
    verifyBundle(dest, 'installed bundle'); // catch a partial copy (locked/interrupted) before it shows "?" on the key
    console.log(`installed: ${dest}${cleanSwap ? '' : ' (dir was locked — overwrote in place; stale files may remain)'}`);
    console.log('Restart the plugin to load it: npx @elgato/cli restart com.alisher.langcycle');
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
