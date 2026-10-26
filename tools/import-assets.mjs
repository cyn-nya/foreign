/**
 * Place Lux3D assets downloaded from the web UI.
 *
 *   node tools/import-assets.mjs <dir>              interactive mapping
 *   node tools/import-assets.mjs <dir> --order      assign in catalogue order
 *   node tools/import-assets.mjs <dir> --set duck=~/Downloads/abc.glb
 *   node tools/import-assets.mjs <dir> --dry-run
 *
 * `npm run assets:generate` needs an API key. The Lux3D web UI does not — it
 * needs only an account — so this exists so that "I have the models but not a
 * key" is not a dead end. Download the exports, point this at the folder, and
 * it validates, names and records them exactly as the API path would.
 *
 * The catalogue order matters and is not guessable from the filenames Lux3D
 * produces, which are task ids. Interactive mode prints the prompt for each
 * remaining key so the mapping can be made by reading rather than by recalling;
 * `--order` exists for the case where the exports were made in catalogue order.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { LUX3D_SOURCE, lux3dKeys, validateGlbBytes } from './asset-provenance.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(root, 'public', 'assets', 'foreign');
const CATALOGUE = path.join(root, 'data', 'foreign-assets.json');
const MANIFEST = path.join(OUT_DIR, 'manifest.json');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);

// Explicit parse: the positional directory and the value of --set both look like
// bare arguments, so deciding by position is the only reliable way to tell them
// apart.
const sets = [];
let sourceDir = null;
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--set') {
    const pair = argv[++i] ?? '';
    const at = pair.indexOf('=');
    if (at < 1) {
      console.error(`--set needs key=path, got "${pair}"`);
      process.exit(2);
    }
    sets.push({ key: pair.slice(0, at), file: pair.slice(at + 1) });
  } else if (arg.startsWith('--')) {
    continue;
  } else if (sourceDir === null) {
    sourceDir = arg;
  }
}

const HELP = `
Place Lux3D assets downloaded from the web UI.

  node tools/import-assets.mjs <dir> [options]

Options
  --order              assign files to catalogue keys in order (no prompts)
  --set key=path       map one key explicitly; repeatable
  --dry-run            show what would happen, write nothing
  --force              overwrite an asset that came from Lux3D

Get models at https://lux3d.aholo.ai/lux3d/home — an account is enough, no API
key is required for the web UI.
`;

if (flag('help') || argv.length === 0) {
  console.log(HELP.trim());
  process.exit(argv.length === 0 ? 2 : 0);
}

const catalogue = JSON.parse(fs.readFileSync(CATALOGUE, 'utf8'));
const assets = catalogue.assets;
const byKey = new Map(assets.map((a) => [a.key, a]));

function collectFiles(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.glb$/i.test(entry.name)) out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}

const incoming = collectFiles(sourceDir);
const alreadyLux3d = lux3dKeys(MANIFEST);

/** key -> absolute file path */
const mapping = new Map();

for (const { key, file } of sets) {
  if (!byKey.has(key)) {
    console.error(`unknown asset key "${key}". Known keys: ${assets.map((a) => a.key).join(', ')}`);
    process.exit(2);
  }
  const resolved = path.resolve(file.replace(/^~/, process.env.HOME ?? '~'));
  if (!fs.existsSync(resolved)) {
    console.error(`no such file: ${resolved}`);
    process.exit(2);
  }
  mapping.set(key, resolved);
}

if (flag('order')) {
  const free = assets.filter((a) => !mapping.has(a.key));
  if (incoming.length > free.length) {
    console.error(`--order got ${incoming.length} file(s) but only ${free.length} key(s) are unmapped.`);
    process.exit(2);
  }
  incoming.forEach((file, i) => {
    if (![...mapping.values()].includes(file)) mapping.set(free[i].key, file);
  });
} else if (!sets.length) {
  const free = assets.filter((a) => !mapping.has(a.key));
  const unmapped = incoming.filter((f) => ![...mapping.values()].includes(f));
  if (!unmapped.length) {
    console.error(`no .glb files found in ${sourceDir ?? '(no directory given)'}`);
    process.exit(2);
  }
  if (!process.stdin.isTTY) {
    console.error(
      'Not a terminal, so the interactive mapping cannot run.\n' +
        '  Use --order (files in catalogue order) or --set key=path.',
    );
    process.exit(2);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  for (const file of unmapped) {
    const remaining = free.filter((a) => !mapping.has(a.key));
    if (!remaining.length) break;
    console.log(`\n${path.basename(file)}  (${(fs.statSync(file).size / 1024).toFixed(0)} KB)`);
    for (const a of remaining) console.log(`   ${a.key.padEnd(11)} ${a.name.padEnd(8)} ${a.prompt}`);
    const answer = (await rl.question('\n  key (or blank to skip): ')).trim();
    if (!answer) continue;
    if (!byKey.has(answer)) {
      console.log(`  "${answer}" is not a catalogue key — skipped`);
      continue;
    }
    if (mapping.has(answer)) {
      console.log(`  "${answer}" is already mapped — skipped`);
      continue;
    }
    mapping.set(answer, file);
  }
  await rl.close();
}

if (!mapping.size) {
  console.log('nothing mapped; no changes made');
  process.exit(1);
}

console.log('');
let placed = 0;
let skipped = 0;
for (const [key, file] of mapping) {
  const asset = byKey.get(key);
  const bytes = fs.readFileSync(file);
  const problem = validateGlbBytes(bytes);
  if (problem) {
    console.log(`  ✗ ${key.padEnd(11)} ${path.basename(file)} — ${problem}`);
    continue;
  }
  if (alreadyLux3d.has(key) && !flag('force') && !flag('dry-run')) {
    console.log(`  · ${key.padEnd(11)} already from Lux3D — use --force to replace`);
    skipped++;
    continue;
  }
  if (flag('dry-run')) {
    console.log(`  would place ${key.padEnd(11)} ${(bytes.length / 1024).toFixed(0)} KB from ${path.basename(file)}`);
    placed++;
    continue;
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.copyFileSync(file, path.join(OUT_DIR, `${key}.glb`));
  console.log(`  ✓ ${key.padEnd(11)} ${(bytes.length / 1024).toFixed(0)} KB  ${asset.name}`);
  placed++;
}

if (flag('dry-run')) {
  console.log(`\n--dry-run: ${placed} file(s) would be placed, nothing written`);
  process.exit(0);
}

if (!placed) {
  console.log(`\nplaced nothing (${skipped} already present)`);
  process.exit(1);
}

// Merge with whatever was already recorded, so importing three assets does not
// erase the provenance of the other eighteen.
const recorded = assets.filter((a) => mapping.has(a.key) || alreadyLux3d.has(a.key));
fs.writeFileSync(
  MANIFEST,
  JSON.stringify(
    {
      source: LUX3D_SOURCE,
      generatedWith: 'Aholo Lux3D text-to-3D (G1, web UI export)',
      importedAt: new Date().toISOString(),
      assets: recorded.map((a) => ({ key: a.key, name: a.name, prompt: a.prompt, height: a.height })),
    },
    null,
    2,
  ),
);

console.log(`\nplaced ${placed}/${mapping.size}`);
console.log(`${recorded.length}/${assets.length} asset(s) now come from Lux3D (the rest are placeholders)`);
console.log('\nRun `npm run assets:plan` to see what is left, then `npm run verify`.');
