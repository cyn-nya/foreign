/**
 * Guards the bug that would have silently disabled the whole Lux3D step.
 *
 *   node tools/check-assets.mjs
 *
 * `generate-assets.mjs` used to decide "already generated" from whether the
 * `.glb` existed. `build-placeholders.mjs` writes a procedural stand-in to
 * exactly those paths, so once the placeholders were in place the tool reported
 * "to do: 0" and generated nothing. The failure lands on the person who just
 * obtained an API key: they run the command, are told there is nothing to do,
 * and have no reason to doubt the game is running real assets.
 *
 * Written as a standalone tool rather than a vitest case because the logic needs
 * `node:fs`, and the test project deliberately carries no Node type definitions
 * — every other acceptance check here is a `.mjs` tool for the same reason.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LUX3D_SOURCE, PLACEHOLDER_SOURCE, classifyAssets, lux3dKeys } from './asset-provenance.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const ASSETS = [
  { key: 'duck', name: 'rubber duck' },
  { key: 'eye', name: 'giant eyeball' },
  { key: 'face', name: 'a face' },
];

// Inside the workspace: writing to the system temp directory from this
// environment terminates the process rather than failing with an error.
const dir = path.join(root, '.cache', `provenance-${process.pid}`);
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

const target = (key) => path.join(dir, `${key}.glb`);
const manifestPath = path.join(dir, 'manifest.json');
const keys = (list) => list.map((a) => a.key).join(',');

const plan = (force = false) => classifyAssets({ assets: ASSETS, target, manifestPath, force });

const writeFiles = (contents = 'x') => {
  for (const a of ASSETS) fs.writeFileSync(target(a.key), contents);
};
const writeManifest = (source, list) =>
  fs.writeFileSync(manifestPath, JSON.stringify({ source, assets: list.map((key) => ({ key })) }));

try {
  // --- the regression itself -------------------------------------------------
  writeFiles('placeholder');
  writeManifest(PLACEHOLDER_SOURCE, ASSETS.map((a) => a.key));
  {
    const { already, todo, standIns } = plan();
    check(
      'placeholder files are work to do, not finished work',
      already.length === 0 && todo.length === 3 && standIns.length === 3,
      `already=${already.length} todo=${todo.length} standIns=${standIns.length}`,
    );
    check(
      'and the placeholders are named, so replacing them is not a surprise',
      keys(standIns) === 'duck,eye,face',
      keys(standIns),
    );
  }

  // --- the control: real assets must actually be skipped ---------------------
  writeFiles('real');
  writeManifest(LUX3D_SOURCE, ASSETS.map((a) => a.key));
  {
    const { already, todo, standIns } = plan();
    check(
      'assets recorded as Lux3D output are skipped',
      already.length === 3 && todo.length === 0 && standIns.length === 0,
      `already=${already.length} todo=${todo.length}`,
    );
  }

  // A partly successful run is the normal case: generate fails per asset.
  writeManifest(LUX3D_SOURCE, ['duck']);
  {
    const { already, todo } = plan();
    check(
      'a partly successful run regenerates only what is missing',
      keys(already) === 'duck' && keys(todo) === 'eye,face',
      `already=${keys(already)} todo=${keys(todo)}`,
    );
  }

  // --- --force means everything -----------------------------------------------
  writeManifest(LUX3D_SOURCE, ASSETS.map((a) => a.key));
  {
    const { already, todo } = plan(true);
    check(
      '--force regenerates real assets too',
      already.length === 0 && todo.length === 3,
      `already=${already.length} todo=${todo.length}`,
    );
  }

  // --- a manifest nobody can read must mean "regenerate", not "keep" ----------
  fs.rmSync(manifestPath);
  check('a missing manifest means nothing is generated yet', lux3dKeys(manifestPath).size === 0);
  check(
    'and every asset is queued',
    plan().todo.length === 3,
    `todo=${plan().todo.length}`,
  );

  fs.writeFileSync(manifestPath, '{ this is not json');
  check(
    'an unreadable manifest also means regenerate',
    lux3dKeys(manifestPath).size === 0 && plan().todo.length === 3,
    `todo=${plan().todo.length}`,
  );

  // --- the real catalogue, right now ------------------------------------------
  const catalogue = JSON.parse(fs.readFileSync(path.join(root, 'data', 'foreign-assets.json'), 'utf8'));
  const outDir = path.join(root, 'public', 'assets', 'foreign');
  const realManifest = path.join(outDir, 'manifest.json');
  const realManifestSource = fs.existsSync(realManifest)
    ? JSON.parse(fs.readFileSync(realManifest, 'utf8')).source
    : null;
  const real = classifyAssets({
    assets: catalogue.assets,
    target: (key) => path.join(outDir, `${key}.glb`),
    manifestPath: realManifest,
  });

  // The invariant is not "all or nothing" — a partly generated catalogue is the
  // normal state while work is in progress, and asserting otherwise failed on a
  // perfectly valid repository. What must never happen is a recorded claim with
  // no file behind it, or a recorded Lux3D provenance in a manifest that is not
  // ours to read.
  const claimed = lux3dKeys(realManifest);
  const orphaned = [...claimed].filter((key) => !fs.existsSync(path.join(outDir, `${key}.glb`)));
  check(
    'no asset is recorded as Lux3D without a file behind it',
    orphaned.length === 0,
    orphaned.length ? `missing: ${orphaned.join(', ')}` : `${claimed.size} recorded, all present`,
  );
  check(
    'Lux3D provenance is only ever read from a Lux3D manifest',
    realManifestSource !== LUX3D_SOURCE || real.already.length > 0 || claimed.size === 0,
    `manifest source: ${realManifestSource ?? '(none)'}`,
  );
  // The README states this composition to a reader, and it stated it wrongly: it
  // said "21 procedural placeholders" when 21 was the count of *non-household*
  // assets and only 7 of them were still placeholders. The numbers are known
  // exactly here, so the prose is checked against the thing it describes rather
  // than trusted. Failing when the sentence is absent is deliberate -- deleting
  // the claim must not be a way to pass.
  // Not `real.standIns`: that classification runs against the throwaway directory
  // this file builds to exercise the logic, so it calls every non-generated asset
  // a placeholder and reported 20. The composition a reader cares about is the one
  // on disk, counted from the manifest and the catalogue.
  const mundaneKeys = catalogue.assets.map((a) => a.key).filter((k) => k.startsWith('mundane_'));
  const mundane = mundaneKeys.length;
  const lux3d = claimed.size;
  const placeholder = catalogue.assets.length - mundane - lux3d;
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const stated = /已生成 \*\*(\d+)\*\* 个（Lux3D 文生 3D），\s*\n?\s*\*\*(\d+)\*\* 个仍是程序化占位，另有 \*\*(\d+)\*\* 件家务家具/.exec(
    readme,
  );
  check(
    'the README states the asset composition',
    stated !== null,
    stated ? 'found the sentence' : 'the sentence stating the composition is missing from README.md',
  );
  if (stated) {
    const [gen, place, house] = [Number(stated[1]), Number(stated[2]), Number(stated[3])];
    check(
      'and the numbers in it are the numbers on disk',
      gen === lux3d && place === placeholder && house === mundane,
      `README says ${gen} generated / ${place} placeholder / ${house} household; ` +
        `disk has ${lux3d} / ${placeholder} / ${mundane}`,
    );
  }

  console.log(
    `\n  current state: ${real.already.length} from Lux3D, ${real.standIns.length} placeholders, ` +
      `${real.todo.length} to generate`,
  );
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

const passed = checks.filter((c) => c.ok).length;
console.log(`\n${passed}/${checks.length} checks passed`);
process.exit(passed === checks.length ? 0 : 1);
