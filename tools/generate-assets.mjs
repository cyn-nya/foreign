#!/usr/bin/env node
/**
 * Generate every foreign object with Aholo Lux3D, in one command.
 *
 *   AHOLO_API_KEY=xxxx node tools/generate-assets.mjs
 *   node tools/generate-assets.mjs --dry-run          # print the plan only
 *   node tools/generate-assets.mjs --only duck,eye --force
 *
 * For each entry in data/foreign-assets.json it runs the documented pipeline:
 *
 *   POST /lux3d/v1/generate/text-to-3d/task/create   {prompt, version:"G1", outputFormat:["glb"]}
 *     -> {c:"0", d:<taskid>}
 *   GET  /lux3d/v1/generate/task/get?taskid=<id>     -> d.status 0|1|3|4|6, d.outputs[].content
 *     G1 returns outputs as [ZIP, GLB]
 *
 * Result URLs expire two hours after the task completes, so each file is
 * downloaded immediately. Written to public/assets/foreign/<key>.glb, which is
 * exactly where src/game/assets.ts looks for them.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AholoClient, AholoError } from '../src/aholo/client.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const OUT_DIR = path.join(root, 'public', 'assets', 'foreign');
const CATALOGUE = path.join(root, 'data', 'foreign-assets.json');

/* ---------------------------------------------------------------- args --- */

function parseArgs(argv) {
  const args = { only: null, force: false, dryRun: false, style: undefined, version: 'G1', concurrency: 2, timeoutMs: 15 * 60 * 1000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--force') args.force = true;
    else if (a === '--only') args.only = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--style') args.style = argv[++i];
    else if (a === '--version') args.version = argv[++i];
    else if (a === '--concurrency') args.concurrency = Math.max(1, Number(argv[++i]) || 1);
    else if (a === '--timeout') args.timeoutMs = Math.max(60_000, Number(argv[++i]) || 0);
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a.startsWith('--key=')) args.key = a.slice(6);
  }
  return args;
}

function loadApiKey(args) {
  if (args.key) return args.key;
  if (process.env.AHOLO_API_KEY) return process.env.AHOLO_API_KEY.trim();
  for (const file of ['.env.local', '.env']) {
    const p = path.join(root, file);
    if (!fs.existsSync(p)) continue;
    const match = fs.readFileSync(p, 'utf8').match(/^\s*AHOLO_API_KEY\s*=\s*(.+)\s*$/m);
    if (match) return match[1].trim().replace(/^["']|["']$/g, '');
  }
  return '';
}

const HELP = `
Generate the Lux3D foreign-object assets.

  node tools/generate-assets.mjs [options]

Options
  --dry-run            print what would be generated, make no network calls
  --only a,b,c         restrict to these catalogue keys
  --force              regenerate even if the .glb already exists
  --style <name>       photorealistic | cartoon | anime | hand_painted
                       | cyberpunk | fantasy | glass        (default: photorealistic)
  --version <v>        G1 | G1-Turbo                        (default: G1)
  --concurrency <n>    parallel tasks                       (default: 2)
  --timeout <ms>       per-task timeout                     (default: 900000)
  --key <key>          API key (else AHOLO_API_KEY, else .env.local)

Get a key at https://labs.aholo.ai/api-keys
`;

/* ---------------------------------------------------------------- main --- */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP.trim());
    return;
  }

  const catalogue = JSON.parse(fs.readFileSync(CATALOGUE, 'utf8'));
  let assets = catalogue.assets;
  if (args.only) {
    const wanted = new Set(args.only);
    const unknown = [...wanted].filter((k) => !assets.some((a) => a.key === k));
    if (unknown.length) throw new Error(`unknown asset key(s): ${unknown.join(', ')}`);
    assets = assets.filter((a) => wanted.has(a.key));
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const target = (key) => path.join(OUT_DIR, `${key}.glb`);
  const already = assets.filter((a) => fs.existsSync(target(a.key)));
  const todo = args.force ? assets : assets.filter((a) => !fs.existsSync(target(a.key)));

  console.log(`Catalogue: ${assets.length} asset(s) · already generated: ${already.length} · to do: ${todo.length}`);
  for (const a of already) console.log(`  skip  ${a.key.padEnd(12)} ${a.name}`);

  if (args.dryRun) {
    console.log('\n--dry-run, plan only:\n');
    for (const a of todo) {
      console.log(`  ${a.key.padEnd(12)} ${String(a.height).padStart(5)} m  ${a.prompt}`);
    }
    console.log(`\nWould write ${todo.length} file(s) to public/assets/foreign/`);
    return;
  }

  if (todo.length === 0) {
    console.log('\nNothing to do. Use --force to regenerate.');
    writeManifest(catalogue.assets.filter((a) => fs.existsSync(target(a.key))));
    return;
  }

  const apiKey = loadApiKey(args);
  if (!apiKey) {
    console.error(
      '\nNo API key found.\n' +
        '  Get one at https://labs.aholo.ai/api-keys, then either\n' +
        '    AHOLO_API_KEY=xxx node tools/generate-assets.mjs\n' +
        '  or put AHOLO_API_KEY=xxx in .env.local\n' +
        '  Preview the work first with --dry-run (no key needed).\n',
    );
    process.exit(2);
  }

  const client = new AholoClient({ apiKey, onLog: (m) => console.log(m) });
  const results = [];

  const queue = todo.slice();
  const workers = Array.from({ length: Math.min(args.concurrency, queue.length) }, async () => {
    for (;;) {
      const asset = queue.shift();
      if (!asset) return;
      const started = Date.now();
      try {
        console.log(`\n▶ ${asset.key} — ${asset.name}`);
        const { taskId, glbUrl } = await client.generateGlb(
          {
            prompt: asset.prompt,
            version: args.version,
            style: args.style,
            outputFormat: ['glb'],
          },
          {
            timeoutMs: args.timeoutMs,
            onProgress: (elapsed) => {
              if (elapsed % 30_000 < 4000) {
                process.stdout.write(`\r  ${asset.key}: waiting ${Math.round(elapsed / 1000)}s   `);
              }
            },
          },
        );

        // result URLs expire after two hours — fetch it now
        const response = await fetch(glbUrl);
        if (!response.ok) throw new AholoError(`download failed: HTTP ${response.status}`, 'download');
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length < 1024) {
          throw new AholoError(`suspiciously small glb (${bytes.length} bytes)`, 'bad-glb');
        }
        // GLB magic is "glTF"
        if (bytes.subarray(0, 4).toString('ascii') !== 'glTF') {
          throw new AholoError('downloaded file is not a GLB (bad magic)', 'bad-glb');
        }
        fs.writeFileSync(target(asset.key), bytes);

        const seconds = ((Date.now() - started) / 1000).toFixed(1);
        console.log(`  ✓ ${asset.key}  ${(bytes.length / 1024).toFixed(0)} KB  task ${taskId}  ${seconds}s`);
        results.push({ key: asset.key, ok: true, taskId, bytes: bytes.length, seconds: Number(seconds) });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`  ✗ ${asset.key}: ${message}`);
        results.push({ key: asset.key, ok: false, error: message });
      }
    }
  });

  await Promise.all(workers);

  const generated = catalogue.assets.filter((a) => fs.existsSync(target(a.key)));
  writeManifest(generated);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${'='.repeat(64)}`);
  console.log(`generated ${results.filter((r) => r.ok).length}/${todo.length} · failed ${failed.length}`);
  console.log(`${generated.length}/${catalogue.assets.length} assets present in public/assets/foreign/`);
  if (generated.length) {
    console.log('\nRestart the dev server, or reload the page — the game picks up');
    console.log('any .glb it finds and falls back to placeholder geometry for the rest.');
  }
  if (failed.length) {
    for (const f of failed) console.error(`  ${f.key}: ${f.error}`);
    process.exit(1);
  }
}

function writeManifest(assets) {
  const manifest = {
    generatedWith: 'Aholo Lux3D text-to-3D (G1)',
    endpoint: 'https://api.aholo3d.cn/lux3d/v1/generate/text-to-3d/task/create',
    generatedAt: new Date().toISOString(),
    assets: assets.map((a) => ({ key: a.key, name: a.name, prompt: a.prompt, height: a.height })),
  };
  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
