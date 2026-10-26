/**
 * Where does the frame go, and can this rig tell the difference?
 *
 * The performance work stalled for two reasons. The first was guessing: three
 * theories about the bottleneck were tested and all three were backwards, and
 * one of them shipped as a default that made the room 16x slower. The second was
 * the measurement itself — the same configuration, all culling off, was measured
 * at 2.79 fps and later at 0.67 fps in different sessions, so no absolute number
 * this harness produces can be trusted on its own.
 *
 * So this rig does the two things the earlier probes did not:
 *
 *  1. Conditions are measured **interleaved and repeated**, round-robin. Anything
 *     that drifts across the run (thermal, another process, a background job)
 *     lands on every condition instead of on whichever one ran last.
 *  2. It reports the **spread**. A difference smaller than the spread is not a
 *     result, and the rig says so rather than printing two numbers and leaving
 *     the reader to assume the bigger one means something.
 *
 * It also isolates the scan, which is the question that actually matters: with
 * the splats hidden the walker, HUD, placed models, audio graph and frame loop
 * all still run, so the gap between the two conditions is the scan's share.
 *
 * Usage: node tools/perf-rig.mjs [--repeats 3] [--seconds 6] [--width 960 --height 540]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startStatic } from './static-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback;
}

const REPEATS = arg('repeats', 3);
const SECONDS = arg('seconds', 6);
const WIDTH = arg('width', 960);
const HEIGHT = arg('height', 540);

const server = await startStatic(path.join(root, 'dist'));
const browser = await chromium.launch({
  args: [
    '--enable-unsafe-swiftshader',
    '--use-angle=swiftshader',
    '--use-gl=angle',
    '--disable-gpu-sandbox',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));

await page.goto(`${server.url}/?autostart=1`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__splat && window.__splat.stage === 'ready', null, {
  timeout: 300_000,
});
// Start from a settled floor so every condition sees the same room.
await page.evaluate(() => window.__splat.start(3, 999));
await page.waitForTimeout(2_000);

/**
 * Four states of the same room, isolated one factor at a time.
 *
 * Hiding the scan changed nothing measurable, which is most likely because a
 * hidden object still pays its per-frame cost — the sort and LOD scheduling run
 * whether or not the result is drawn. So the scan is *detached* rather than
 * hidden, and the models are hidden separately, which gives a 2x2:
 *
 *   everything / no models / no scan / neither
 *
 * If neither state is faster than `everything`, the cost is in the engine and
 * the room, and no amount of asset work will touch it.
 */
const CONDITIONS = [
  {
    name: 'everything      ',
    setup: () => {
      window.__splat.restoreSplat();
      window.__splat.setObjectsVisible(true);
    },
  },
  {
    name: 'no models       ',
    setup: () => {
      window.__splat.restoreSplat();
      window.__splat.setObjectsVisible(false);
    },
  },
  {
    name: 'no scan         ',
    setup: () => {
      window.__splat.removeSplat();
      window.__splat.setObjectsVisible(true);
    },
  },
  {
    name: 'neither         ',
    setup: () => {
      window.__splat.removeSplat();
      window.__splat.setObjectsVisible(false);
    },
  },
];

/** Frames per second from the game's own counter, never the rAF cadence. */
async function measure(condition) {
  await page.evaluate((body) => {
    // eslint-disable-next-line no-new-func
    new Function('window', `(${body})()`)(window);
  }, condition.setup.toString());
  await page.waitForTimeout(700); // let the change take effect, but not warm up long
  const value = await page.evaluate(async (seconds) => {
    const s = window.__splat;
    const before = s.frames;
    const t0 = performance.now();
    await new Promise((r) => setTimeout(r, seconds * 1000));
    return (s.frames - before) / ((performance.now() - t0) / 1000);
  }, SECONDS);
  return value;
}

const samples = new Map(CONDITIONS.map((c) => [c.name, []]));
for (let round = 0; round < REPEATS; round++) {
  for (const condition of CONDITIONS) {
    samples.get(condition.name).push(await measure(condition));
  }
  process.stdout.write(`round ${round + 1}/${REPEATS} done\n`);
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return { min: sorted[0], median, max: sorted[sorted.length - 1] };
}

console.log(`\n${WIDTH}x${HEIGHT}, ${REPEATS} rounds x ${SECONDS}s, interleaved\n`);
const summary = [];
for (const condition of CONDITIONS) {
  const s = stats(samples.get(condition.name));
  summary.push({ name: condition.name, ...s });
  console.log(
    `${condition.name}  median ${s.median.toFixed(2)} fps   ` +
      `[${s.min.toFixed(2)} .. ${s.max.toFixed(2)}]   ` +
      `spread ${(s.max - s.min).toFixed(2)}   samples ${samples
        .get(condition.name)
        .map((v) => v.toFixed(2))
        .join(', ')}`,
  );
}

const [everything, noModels, noScan, neither] = summary;
const spread = Math.max(...summary.map((s) => s.max - s.min));

console.log(
  `\nengine floor: ${neither.median.toFixed(2)} fps with nothing in the room ` +
    `(spread ${spread.toFixed(2)})`,
);

/**
 * Can this environment measure performance at all?
 *
 * It usually cannot. Under SwiftShader an empty scene — no scan, no models,
 * nothing to draw — still runs at about 2 fps, so every condition lands in the
 * same 1-2 fps band whatever it contains and the comparisons above are noise
 * wearing numbers. A rig that does not say this out loud invites exactly the
 * mistake it was built to prevent: reading a 0.4 fps difference as a result and
 * changing the game because of it.
 *
 * The empty-scene rate is the control. If it is low, the environment is the
 * bottleneck, not the game.
 */
const SELF_TEST_MIN_FPS = 15;
if (neither.median < SELF_TEST_MIN_FPS) {
  console.log(
    `\n*** THIS RIG CANNOT MEASURE PERFORMANCE HERE ***\n` +
      `An empty room renders at ${neither.median.toFixed(2)} fps (needs > ${SELF_TEST_MIN_FPS}). ` +
      `The environment is the bottleneck, so every number above is dominated by\n` +
      `it and none of the comparisons mean anything. Do not change the game based\n` +
      `on this run. Measure on a machine with a real GPU, or run with GPU\n` +
      `acceleration instead of --use-angle=swiftshader.`,
  );
} else {
  console.log(
    `\nSelf-test passed: an empty room renders at ${neither.median.toFixed(2)} fps, ` +
      `so the environment is fast enough for the comparisons to be about the game.`,
  );

  // Verdicts are printed only after the environment has proved it can support
  // them. They used to print before the self-test, and with a single repeat the
  // spread was 0.00 — so every comparison was labelled REAL against an empty room
  // running at 0.5 fps. A measurement tool that reports confident nonsense is
  // worse than one that reports nothing.
  console.log('');
  if (REPEATS < 2) {
    console.log(
      `No verdicts: --repeats ${REPEATS} gives a spread of ${spread.toFixed(2)}, which ` +
        'cannot distinguish a real difference from a single sample. Use --repeats 3.',
    );
  } else {
    /** A difference is only reported as real when it clears the worst spread seen. */
    const verdict = (label, candidate, baseline) => {
      const gap = candidate.median - baseline.median;
      const real = gap > spread;
      console.log(
        `${label}: ${gap >= 0 ? '+' : ''}${gap.toFixed(2)} fps vs "${baseline.name.trim()}" ` +
          `(${real ? 'REAL' : `within the ${spread.toFixed(2)} spread — not shown to be real`})`,
      );
    };
    verdict('scan cost  (no scan vs everything)   ', noScan, everything);
    verdict('model cost (no models vs everything) ', noModels, everything);
    verdict('floor cost (neither vs everything)   ', neither, everything);
  }
}

await browser.close();
await server.close();
