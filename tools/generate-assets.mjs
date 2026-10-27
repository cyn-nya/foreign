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
import { LUX3D_SOURCE, classifyAssets, lux3dKeys } from './asset-provenance.mjs';
import { AholoClient, AholoError } from '../src/aholo/client.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const OUT_DIR = path.join(root, 'public', 'assets', 'foreign');
const CATALOGUE = path.join(root, 'data', 'foreign-assets.json');
const MANIFEST = path.join(OUT_DIR, 'manifest.json');

/* ---------------------------------------------------------------- args --- */

function parseArgs(argv) {
  const args = { only: null, force: false, dryRun: false, style: undefined, version: 'G1', faceCount: undefined, concurrency: 2, timeoutMs: 15 * 60 * 1000, base: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--force') args.force = true;
    else if (a === '--only') args.only = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--style') args.style = argv[++i];
    else if (a === '--version') args.version = argv[++i];
    else if (a === '--face-count') args.faceCount = Number(argv[++i]);
    else if (a === '--concurrency') args.concurrency = Math.max(1, Number(argv[++i]) || 1);
    else if (a === '--timeout') args.timeoutMs = Math.max(60_000, Number(argv[++i]) || 0);
    else if (a === '--help' || a === '-h') args.help = true;
    // Both spellings. Only `--key=` used to be parsed while the help text
    // advertises `--key <key>`, so the spaced form was accepted, ignored, and the
    // command then failed with "No API key found" -- which reads as a wrong key
    // rather than an unparsed argument.
    else if (a.startsWith('--key=')) args.key = a.slice(6);
    else if (a === '--key') args.key = argv[++i];
    else if (a === '--region') args.region = argv[++i];
    else if (a === '--base') args.base = argv[++i];
  }
  return args;
}

/**
 * The two service regions, and the key variable the vendor documents for each.
 *
 * `manycore-research/Aholo-Lux3D` states plainly that "China and international
 * API Keys are not interchangeable", and lists the China key at
 * labs.aholo3d.cn against the international one at labs.aholo.ai. This tool
 * defaulted to the China base URL and read `AHOLO_API_KEY`, so an international
 * key was being spent against the China region with nothing anywhere saying so.
 *
 * Both regions answer `task/list` identically for either key, which is exactly
 * why this was invisible: the only way to notice is a call that costs something.
 */
export const REGIONS = {
  cn: { base: 'https://api.aholo3d.cn', keyVar: 'LUX3D_CN_API_KEY', label: 'China' },
  global: { base: 'https://api.aholo.ai/global', keyVar: 'LUX3D_GLOBAL_API_KEY', label: 'international' },
};

export function regionFor(args) {
  if (args.base) return { base: args.base, keyVar: null, label: `custom (${args.base})` };
  const name = args.region ?? ((process.env.LUX3D_REGION ?? '').trim() || 'cn');
  const region = REGIONS[name];
  if (!region) {
    throw new Error(`unknown region "${name}" — use cn or global, or pass --base`);
  }
  return { ...region, name };
}

function loadApiKey(args) {
  if (args.key) return args.key;
  // The region's own variable wins, then the generic one, so an existing
  // .env.local keeps working while the documented names take over.
  const region = regionFor(args);
  if (region.keyVar && process.env[region.keyVar]) return process.env[region.keyVar].trim();
  if (process.env.AHOLO_API_KEY) return process.env.AHOLO_API_KEY.trim();
  for (const file of ['.env.local', '.env']) {
    const p = path.join(root, file);
    if (!fs.existsSync(p)) continue;
    const match = fs.readFileSync(p, 'utf8').match(/^\s*AHOLO_API_KEY\s*=\s*(.+)\s*$/m);
    if (match) return match[1].trim().replace(/^["']|["']$/g, '');
    // The vendor's own variable name, so a .env.local written for the Skill works.
    const regionMatch = file.match(/^\s*LUX3D_(CN|GLOBAL)_API_KEY\s*=\s*(.+)\s*$/m);
    if (regionMatch) return regionMatch[2].trim().replace(/^["']|["']$/g, '');
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
  --face-count <n>     override the per-asset triangle budget   (10000-300000)
  --concurrency <n>    parallel tasks                       (default: 2)
  --timeout <ms>       per-task timeout                     (default: 900000)
  --key <key>          API key (else AHOLO_API_KEY, else .env.local)
  --region cn|global   service region (default: cn)
  --base <url>         explicit base URL, overriding --region

The regions are separate accounts and their keys are not interchangeable:
  cn      https://api.aholo3d.cn        LUX3D_CN_API_KEY
  global  https://api.aholo.ai/global   LUX3D_GLOBAL_API_KEY

Get a China key at https://labs.aholo3d.cn/api-keys
and an international one at https://labs.aholo.ai/api-keys
`;

/**
 * Create a task, tolerating the account's concurrent-task ceiling.
 *
 * The API allows only a few generations at once and answers the rest with
 * `GENERATION_CONCURRENCY_LIMIT_EXCEEDED` — "当前已有进行中的生成任务，请等待完成后再试".
 * That is a queue, not a verdict, but treating it as a failure cost 8 of 20
 * assets on the first real run: the batch reported them as errors and they were
 * simply never made. Retrying is the whole difference between "the account is
 * busy" and "these assets do not exist".
 */
async function generateWithRetry(client, asset, args) {
  const attempts = 6;
  for (let attempt = 1; ; attempt++) {
    try {
      return await client.generateGlb(
        {
          prompt: asset.prompt,
          version: args.version,
          style: args.style,
          outputFormat: ['glb'],
          // Omitting this lets Lux3D use its 300k maximum, which is ~16 MB and
          // 296k triangles for a rubber duck. The budget belongs in the
          // catalogue, next to the thing it describes.
          faceCount: args.faceCount ?? asset.faceCount ?? 20000,
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
    } catch (error) {
      const code = error instanceof AholoError ? error.code : undefined;
      const message = error instanceof Error ? error.message : String(error);

      // Permanent conditions, checked first. `c=-1` is the API's catch-all code —
      // it means both "invalid appKey" and "no credits" — so the message is the
      // only thing that distinguishes them, and a credit failure retried six
      // times over five minutes is five minutes spent learning nothing.
      const permanent =
        /no credits|insufficient|not enough credits|额度|余额|invalid appKey/i.test(message) ||
        code === 'BIZ_11003' ||
        code === 'BIZ_24002';
      const transient =
        !permanent &&
        (code === 'GENERATION_CONCURRENCY_LIMIT_EXCEEDED' ||
          code === 'BIZ_11001' ||
          /concurrency|进行中的生成任务|rate ?limit|too many requests/i.test(message));

      if (!transient || attempt >= attempts) throw error;

      // Long and growing: the ceiling clears when *another* asset finishes, and
      // those take minutes, so a short backoff would just burn attempts.
      const wait = Math.min(90_000, 15_000 * attempt);
      console.log(`  ${asset.key}: account busy, retrying in ${wait / 1000}s (${attempt}/${attempts - 1})`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

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
  const { already, todo, standIns } = classifyAssets({
    assets,
    target,
    manifestPath: MANIFEST,
    force: Boolean(args.force),
  });

  console.log(`Catalogue: ${assets.length} asset(s) · already generated: ${already.length} · to do: ${todo.length}`);
  for (const a of already) console.log(`  skip  ${a.key.padEnd(12)} ${a.name}`);
  if (standIns.length) {
    console.log(
      `
  ${standIns.length} file(s) currently hold procedural placeholders — ` +
        'they will be replaced, not skipped.',
    );
  }

  if (args.dryRun) {
    console.log('\n--dry-run, plan only:\n');
    for (const a of todo) {
      console.log(`  ${a.key.padEnd(12)} ${String(a.height).padStart(5)} m  ${String(a.faceCount ?? 20000).padStart(6)} faces  ${a.prompt}`);
    }
    console.log(`\nWould write ${todo.length} file(s) to public/assets/foreign/`);
    return;
  }

  if (todo.length === 0) {
    console.log('\nNothing to do. Use --force to regenerate.');
    // Deliberately no manifest rewrite here. Reaching this branch means the
    // catalogue is already recorded as Lux3D output, so there is nothing to add;
    // rewriting it from `already` would drop provenance for every asset excluded
    // by `--only` and quietly turn real assets back into "unknown, regenerate".
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

  const region = regionFor(args);
  console.log(`region: ${region.label} (${region.base})`);
  const client = new AholoClient({ apiKey, baseUrl: region.base, onLog: (m) => console.log(m) });
  const results = [];

  const queue = todo.slice();
  const workers = Array.from({ length: Math.min(args.concurrency, queue.length) }, async () => {
    for (;;) {
      const asset = queue.shift();
      if (!asset) return;
      const started = Date.now();
      try {
        console.log(`\n▶ ${asset.key} — ${asset.name}`);
        const { taskId, glbUrl } = await generateWithRetry(client, asset, args);

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

  // What actually came from Lux3D: the tasks that succeeded, plus anything an
  // earlier run produced. Not `fs.existsSync` — a failed generation leaves the
  // placeholder sitting at that path, and recording it here would mark it as
  // done and skip it forever.
  const produced = new Set(results.filter((r) => r.ok).map((r) => r.key));
  const previously = lux3dKeys(MANIFEST);
  const generated = catalogue.assets.filter((a) => produced.has(a.key) || previously.has(a.key));
  if (generated.length) writeManifest(generated);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${'='.repeat(64)}`);
  console.log(`generated ${results.filter((r) => r.ok).length}/${todo.length} · failed ${failed.length}`);
  console.log(`${generated.length}/${catalogue.assets.length} asset(s) now come from Lux3D (the rest are placeholders)`);
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
    source: LUX3D_SOURCE,
    generatedWith: 'Aholo Lux3D text-to-3D (G1)',
    endpoint: 'https://api.aholo3d.cn/lux3d/v1/generate/text-to-3d/task/create',
    generatedAt: new Date().toISOString(),
    assets: assets.map((a) => ({ key: a.key, name: a.name, prompt: a.prompt, height: a.height })),
  };
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
}

main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
