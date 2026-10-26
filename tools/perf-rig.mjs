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

const CONDITIONS = [
  { name: 'scan visible', setup: () => window.__splat.setSplatVisible(true) },
  { name: 'scan hidden ', setup: () => window.__splat.setSplatVisible(false) },
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

const [visible, hidden] = summary;
const spread = Math.max(visible.max - visible.min, hidden.max - hidden.min);
const gap = hidden.median - visible.median;
console.log(
  `\nscan share: ${gap.toFixed(2)} fps (${((gap / Math.max(hidden.median, 1e-6)) * 100).toFixed(0)}% of the hidden rate)`,
);
console.log(
  gap > spread
    ? `VERDICT: the gap (${gap.toFixed(2)}) exceeds the spread (${spread.toFixed(2)}) — the scan is the bottleneck.`
    : `VERDICT: the gap (${gap.toFixed(2)}) does NOT exceed the spread (${spread.toFixed(2)}). ` +
      'The scan is not shown to be the cost; do not act on this difference.',
);

await browser.close();
await server.close();
