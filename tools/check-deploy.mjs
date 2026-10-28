/**
 * Prove the build survives being deployed.
 *
 *   node tools/check-deploy.mjs [--keep]
 *
 * Two things this catches that the normal harness cannot, because the normal
 * harness serves `dist/` from the repository root at `/`:
 *
 *   1. Absolute paths. `assets/index-abc.js` resolving to `/assets/...` works at
 *      a domain root and 404s under `/repo-name/`. The dist is served from a
 *      *copy outside the repository* under a sub-path to reproduce that.
 *   2. Missing files. Every 4xx response is recorded and fails the run, so a
 *      broken base shows up as a named URL rather than as a blank page.
 *
 * The copy also proves the build does not secretly depend on anything left in
 * the repository, which is exactly the mistake that makes a deploy fail after a
 * green local run.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startStatic } from './static-server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const dist = join(root, 'dist');

/** A GitHub Pages project site is served here, not at the domain root. */
const BASE_PATH = '/aholo-hackathon';

/**
 * Recursive copy built on `copyFileSync`.
 *
 * `fs.cpSync` on this checkout does not merely fail — it terminates the Node
 * process outright, with no error and exit code 127, which took a while to
 * attribute because it looks like a crash in the code that follows it. Copying
 * file by file works and is not worth further investigation.
 */
function copyTree(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, entry.name);
    const to = join(dst, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else copyFileSync(from, to);
  }
}

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

// `--url <url>` tests an already-published site instead of a local copy.
//
// `deploy:check` proves a local build *would* work from a sub-path; this proves
// the link that actually gets submitted does. They are different claims, and
// only the second one is the deliverable.
const liveArg = process.argv.indexOf('--url');
const liveUrl = liveArg >= 0 ? process.argv[liveArg + 1] : null;

let server;
if (liveUrl) {
  console.log(`testing the published site directly: ${liveUrl}`);
  server = { url: liveUrl.replace(/\/+$/, ''), close: async () => {} };

  // A published site can work perfectly and still be an old build. "The demo link
  // works" and "the demo link is the thing I just verified locally" are different
  // claims, and forgetting to redeploy after a change is the ordinary way to fail
  // the second one — with every other check here still green, because the old
  // build also worked fine.
  //
  // This is the check that matters most for a submission: the judges click the
  // link, not the working tree.
  const entryBundle = (html) => html.match(/assets\/index-[\w-]+\.js/)?.[0] ?? null;
  const localIndex = join(dist, 'index.html');
  const localEntry = existsSync(localIndex) ? entryBundle(readFileSync(localIndex, 'utf8')) : null;

  if (!localEntry) {
    console.log('  (skipped the build-freshness check — no local dist/index.html to compare against)');
  } else {
    let liveEntry;
    try {
      // Cache-buster: Pages caches index.html aggressively, and a stale copy here
      // would report a stale site as current.
      const response = await fetch(`${server.url}/?freshness=${Date.now()}`);
      liveEntry = entryBundle(await response.text());
    } catch (error) {
      liveEntry = `unreachable (${error instanceof Error ? error.message : error})`;
    }
    check(
      'the published site is the current build',
      liveEntry === localEntry,
      liveEntry === localEntry
        ? `both serve ${localEntry}`
        : `live=${liveEntry} local=${localEntry} — run \`npm run deploy\``,
    );
  }
} else {
  if (!existsSync(join(dist, 'index.html'))) {
    console.error('dist/index.html is missing — run `npm run build` first.');
    process.exit(1);
  }

  // A throwaway copy, deliberately outside the repository.
  //
  // Staged in the repository's *parent* directory rather than in the system temp
  // directory: writing to %TEMP% from here does not fail with an error, it kills
  // the process outright, which is a confusing way to learn that the staging path
  // is outside the sandbox. The parent directory is still outside the repository,
  // which is the property that matters — it proves the build does not depend on
  // anything left lying around in the checkout.
  const staging = join(resolve(root, '..'), `.foreign-deploy-${process.pid}`);
  // The sub-path is a URL concern, not a directory-nesting one: a Pages project
  // site maps `/repo/` onto the repository root, so the files sit at the top of
  // the served directory and only the URL carries the prefix.
  const site = join(staging, 'site');
  copyTree(dist, site);
  console.log(`staged a copy of dist/ outside the repository at ${site}`);

  server = await startStatic(site, { basePath: BASE_PATH });
  console.log(`serving it as a project site: ${server.url}/`);
}

const browser = await chromium.launch({
  args: [
    '--enable-unsafe-swiftshader',
    '--use-angle=swiftshader',
    '--use-gl=angle',
    '--disable-gpu-sandbox',
    '--autoplay-policy=no-user-gesture-required',
  ],
});

const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const pageErrors = [];
const consoleErrors = [];
const failed = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('response', (r) => {
  if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`);
});

let state = null;
try {
  await page.goto(`${server.url}/?autostart=1&floor=2&seed=4242`, {
    waitUntil: 'load',
    timeout: 60_000,
  });
  await page.waitForFunction(() => window.__splat && window.__splat.ready, null, { timeout: 240_000 });
  // The catalogue preload is started, not awaited, so the game is playable before it finishes.
  // `missing` means "failed" and would read as empty either way, so the wait is on `settled`:
  // without it this check passes while nothing has been attempted, which is the shape of a
  // check that cannot fail. The timeout is generous because the point of this assertion is the
  // slow connection, and a slow connection is exactly where it must still be able to conclude.
  await page.waitForFunction(() => window.__splat.assets.settled, null, { timeout: 300_000 });
  state = await page.evaluate(() => {
    const s = window.__splat;
    return {
      state: s.state,
      floor: s.floor,
      placed: s.placed,
      assets: s.assets,
      collision: s.collision,
      splat: s.splat,
    };
  });
} catch (error) {
  check('the deployed build boots', false, String(error).split('\n')[0]);
}

if (state) {
  check(
    'the deployed build reconstructs the room and starts a floor',
    state.state === 'playing' && state.splat && state.collision && state.placed >= 1,
    `state=${state.state} splat=${state.splat} collision=${state.collision} placed=${state.placed}`,
  );
  check(
    'every asset resolves under the sub-path',
    state.assets.loaded > 0 && state.assets.missing.length === 0,
    `${state.assets.loaded} loaded, ${state.assets.missing.length} missing`,
  );

  // Actually play it: a build that renders but cannot be played is not deployed.
  // `debug.walk` reports where it started and finished; `debug.player` is a
  // per-frame snapshot and is not updated synchronously by the simulated walk.
  // Reading the snapshot reported a 0.00 m walk from a walker that had in fact
  // moved. Start from the way in so the distance is measured over open floor.
  await page.evaluate(() => window.__splat.respawn());
  const play = await page.evaluate(() => {
    const s = window.__splat;
    const walked = s.walk(1.0, 'KeyW');
    const moved = Math.hypot(walked.to[0] - walked.from[0], walked.to[2] - walked.from[2]);
    // `aimAt` points the head at the object's bounding-box centre, and for some
    // assets the ray does not land there — so aiming at index 0 and marking made
    // this check a coin flip that failed while the game was fine. A player moves
    // the mouse until the crosshair is on the thing; do the same, and still
    // require that at least one object *can* be brought under the crosshair, or
    // the build would really be unmarkable.
    let aimed = null;
    for (let i = 0; i < s.placements().length; i++) {
      const slot = s.aimAt(i);
      if (slot && s.crosshair() === slot) {
        aimed = slot;
        break;
      }
    }
    const result = s.mark();
    return { moved, aimed, result: result?.result, found: s.found.length };
  });
  check(
    'the player can walk in the deployed build',
    play.moved > 0.3 && play.moved < 3.5,
    `moved ${play.moved.toFixed(2)} m in 1.0 s`,
  );
  check(
    'and can still find and mark something',
    play.aimed !== null && play.result === 'hit' && play.found === 1,
    `aimed=${play.aimed ?? 'nothing reachable'} result=${play.result} found=${play.found}`,
  );
}

check('no request 404s, so no path escaped the sub-directory', failed.length === 0,
  failed.length ? failed.slice(0, 4).join(' | ') : 'every request resolved');
check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | ') || 'clean');
check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | ') || 'clean');

await browser.close();
await server.close();
if (!liveUrl) rmSync(join(resolve(root, '..'), `.foreign-deploy-${process.pid}`), {
  recursive: true,
  force: true,
});

const passed = checks.filter((c) => c.ok).length;
console.log(`\n${passed}/${checks.length} checks passed`);
process.exit(passed === checks.length ? 0 : 1);
