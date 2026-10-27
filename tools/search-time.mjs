#!/usr/bin/env node
/**
 * How long does a floor take to *search*, and does it fit in the floor's clock?
 *
 *   node tools/search-time.mjs [--turn 60] [--json .cache/search.json]
 *
 * The complaint this answers is "must have a way to finish". The win condition
 * exists and is tested, but "there is a way to win" and "the floor is winnable"
 * are different claims, and only the second one is about a player. Floor 8 hands
 * out six anomalies, 114 seconds and a torch that lights under a third of the
 * screen, and nothing anywhere said whether that is a hard floor or an impossible
 * one.
 *
 * So this measures the search itself. A human looking for something does not aim
 * a single ray at it -- they sweep the room and notice it when it crosses their
 * attention. The model here is that an object is *noticed* when the angle between
 * the view direction and the object is smaller than the object's own angular
 * radius plus a fixed peripheral allowance. That is the honest shape of the task,
 * and it is why a crosshair-ray bot would be useless here: requiring the exact
 * centre to touch a pair of teeth would report a search time no human recognises.
 *
 * The result is a lower bound on what a player needs, because it counts only
 * looking. It does not count walking, deciding whether an ordinary chair is
 * ordinary, or recovering from a mistaken mark. A floor that fails *this* is
 * certainly unwinnable; a floor that passes it has that much headroom left over.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startStatic } from './static-server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const argOf = (name, fallback) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? fallback : Number(process.argv[at + 1]);
};

/** Degrees of yaw a player covers per second while searching a dark room. */
const TURN_DEG_PER_S = argOf('--turn', 60);
/**
 * How far off-centre an object is still noticed, before its own size is counted.
 *
 * Twenty degrees is the comfortable "I saw something there" band. It is generous
 * on purpose: the point of this tool is to find floors that are impossible, not
 * to prove that they are comfortable.
 */
const NOTICE_DEG = 20;
/** Degrees per pitch row, so a sweep covers the room's height as well as its width. */
const PITCH_ROW_DEG = 30;
const SEED = 7;

/**
 * The floor clock, mirrored from `durationForFloor` in src/game/rules.ts.
 *
 * Mirrored rather than imported because that module is TypeScript with an
 * extensionless import and cannot be loaded by plain Node. The mirror is not
 * trusted: `assertMirror` below re-derives it from the source text and fails if
 * the two disagree, so this cannot quietly drift away from the game.
 */
function durationForFloor(floor) {
  return Math.max(105, 240 - (floor - 1) * 18);
}

function assertMirror() {
  const source = fs.readFileSync(path.join(root, 'src/game/rules.ts'), 'utf8');
  const at = source.indexOf('export function durationForFloor');
  if (at === -1) throw new Error('durationForFloor is no longer in src/game/rules.ts');
  const body = source.slice(at, source.indexOf('\n}', at));
  const floorTerms = [...body.matchAll(/(\d+)\s*-\s*\(?\s*floor\s*-\s*1\s*\)?\s*\*\s*(\d+)/g)];
  const caps = [...body.matchAll(/Math\.max\(\s*(\d+)/g)];
  if (floorTerms.length !== 1 || caps.length !== 1) {
    throw new Error(`cannot read durationForFloor from source; refusing to guess:\n${body}`);
  }
  const [, base, step] = floorTerms[0].map(Number);
  const cap = Number(caps[0][1]);
  if (base !== 240 || step !== 18 || cap !== 105) {
    throw new Error(
      `durationForFloor changed in the source (base ${base}, step ${step}, cap ${cap}) — ` +
        'update the mirror in tools/search-time.mjs',
    );
  }
}

async function collect(page, floors) {
  return page.evaluate(
    async ({ floors, seed }) => {
      const s = window.__splat;
      const out = [];
      for (const floor of floors) {
        await s.start(floor, seed);
        const anchors = s.anchors();
        const list = s.placements();
        if (!list.length || !anchors.length) {
          out.push({ floor, anomalies: [], anchors: anchors.length, error: 'nothing placed' });
          continue;
        }
        // The vantage point: the anchor closest to the middle of the anomalies,
        // which is where a player searching the room naturally ends up.
        const cx = list.reduce((a, p) => a + p.x, 0) / list.length;
        const cz = list.reduce((a, p) => a + p.z, 0) / list.length;
        let best = anchors[0];
        let bestD = Infinity;
        for (const a of anchors) {
          const d = Math.hypot(a.eye.x - cx, a.eye.z - cz);
          if (d < bestD) {
            bestD = d;
            best = a;
          }
        }
        out.push({
          floor,
          eye: best.eye,
          // How many distinct things there are to find, which is not the same as
          // how many objects are in the room: a `twin` is three copies of one
          // anomaly sharing a single slot, and marking any copy resolves it.
          slots: new Set(list.map((p) => p.slotId)).size,
          anomalies: list.map((p) => ({
            key: p.assetKey,
            kind: p.kind,
            x: p.x,
            y: p.y,
            z: p.z,
          })),
        });
      }
      return out;
    },
    { floors, seed: SEED },
  );
}

/** The angular radius of an object, from its height and how far away it is. */
function angularRadius(height, distance) {
  const half = Math.max(0.05, height / 2);
  return Math.atan2(half, Math.max(0.3, distance));
}

async function main() {
  assertMirror();

  const dist = path.join(root, 'dist');
  if (!fs.existsSync(path.join(dist, 'index.html'))) {
    console.error('dist/ is missing — run npm run build first.');
    process.exit(2);
  }

  const { assets } = JSON.parse(fs.readFileSync(path.join(root, 'data/foreign-assets.json'), 'utf8'));
  const heightOf = (key) => assets.find((a) => a.key === key)?.height ?? 0.5;

  // The tool serves the build itself rather than assuming a preview is running:
  // an earlier version pointed at a fixed port and silently used whatever server
  // happened to be there, which is how a measurement ends up describing a stale
  // build.
  const server = await startStatic(dist);
  const base = server.url;

  const browser = await chromium.launch({
    args: [
      '--enable-unsafe-swiftshader',
      '--use-angle=swiftshader',
      '--use-gl=angle',
      '--disable-gpu-sandbox',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto(`${base}/`, { waitUntil: 'load', timeout: 60_000 });
  // `ready`, the same hook the acceptance harness waits on -- `settle` is a
  // function on the debug object, not a flag, so waiting for it never resolved.
  await page.waitForFunction(() => window.__splat && window.__splat.ready, null, { timeout: 240_000 });

  const raw = await collect(page, [1, 2, 3, 4, 5, 6, 7, 8]);
  await browser.close();
  await server.close();

  console.log(`notice band: ${NOTICE_DEG}° either side of centre, plus the object's own angular radius`);
  console.log(`turn rate:   ${TURN_DEG_PER_S}°/s, pitch rows every ${PITCH_ROW_DEG}°\n`);
  console.log('floor  find  objs  duration   sweep°  rows  scanning  left over  verdict');

  const rows = [];
  let worst = null;
  for (const entry of raw) {
    if (entry.error) {
      console.log(`${String(entry.floor).padStart(5)}  -  ${entry.error}`);
      continue;
    }
    const { floor, eye, anomalies } = entry;
    const slots = entry.slots ?? anomalies.length;
    const duration = durationForFloor(floor);

    let minYaw = Infinity;
    let maxYaw = -Infinity;
    let minPitch = Infinity;
    let maxPitch = -Infinity;
    for (const a of anomalies) {
      const dx = a.x - eye.x;
      const dy = a.y - eye.y;
      const dz = a.z - eye.z;
      const horizontal = Math.hypot(dx, dz);
      const distance = Math.hypot(horizontal, dy);
      const radiusDeg = (angularRadius(heightOf(a.key), distance) * 180) / Math.PI;
      // Same convention the player uses: yaw 0 looks down -z.
      const yawDeg = (Math.atan2(-dx, -dz) * 180) / Math.PI;
      const pitchDeg = (Math.atan2(dy, horizontal) * 180) / Math.PI;
      minYaw = Math.min(minYaw, yawDeg - radiusDeg);
      maxYaw = Math.max(maxYaw, yawDeg + radiusDeg);
      minPitch = Math.min(minPitch, pitchDeg - radiusDeg);
      maxPitch = Math.max(maxPitch, pitchDeg + radiusDeg);
    }

    // Only the arc that actually holds anomalies has to be swept.
    let sweep = maxYaw - minYaw;
    if (sweep < 0) sweep += 360;
    if (sweep > 360) sweep = 360;

    // Rows are only needed when the anomalies are stacked vertically.
    const vertical = Math.max(0, maxPitch - minPitch);
    const pitchRows = Math.max(1, Math.ceil(vertical / PITCH_ROW_DEG) + 1);

    // The notice band is already this wide, so only the remainder costs time.
    const effective = Math.max(0, sweep - NOTICE_DEG * 2);
    const scanning = (effective * pitchRows) / TURN_DEG_PER_S;
    const leftOver = duration - scanning;

    const verdict = leftOver <= 0 ? 'IMPOSSIBLE' : leftOver < duration * 0.35 ? 'tight' : 'ok';
    console.log(
      `${String(floor).padStart(5)}  ${String(slots).padStart(4)}  ${String(anomalies.length).padStart(4)}  ` +
        `${String(duration).padStart(7)}s  ${sweep.toFixed(0).padStart(7)}  ` +
        `${String(pitchRows).padStart(4)}  ${scanning.toFixed(1).padStart(8)}s  ` +
        `${leftOver.toFixed(1).padStart(9)}s  ${verdict}`,
    );
    rows.push({
      floor,
      anomalies: slots,
      nodes: anomalies.length,
      duration,
      sweepDeg: Number(sweep.toFixed(1)),
      pitchRows,
      scanningSeconds: Number(scanning.toFixed(1)),
      budgetLeft: Number(leftOver.toFixed(1)),
      verdict,
    });
    if (!worst || leftOver < worst.budgetLeft) worst = rows[rows.length - 1];
  }

  const at = process.argv.indexOf('--json');
  const outAt = at === -1 ? path.join(root, '.cache/search.json') : process.argv[at + 1];
  fs.mkdirSync(path.dirname(outAt), { recursive: true });
  fs.writeFileSync(
    outAt,
    JSON.stringify({ turnDegPerS: TURN_DEG_PER_S, noticeDeg: NOTICE_DEG, seed: SEED, rows }, null, 2) + '\n',
  );
  console.log(`\n-> ${outAt}`);

  if (errors.length) {
    console.log(`\n${errors.length} page error(s):`);
    for (const e of errors.slice(0, 5)) console.log(`  ${e}`);
  }

  // The gate. "There is a way to win" was already true and already tested; this
  // is the different claim that every floor's clock is long enough to find what
  // is on it. It is a lower bound on a player's time -- only looking is counted,
  // not walking, judging or recovering -- so a floor that fails this is certainly
  // unwinnable.
  const impossible = rows.filter((r) => r.verdict === 'IMPOSSIBLE');
  console.log(`\n${rows.length - impossible.length}/${rows.length} floors leave time to search`);
  if (impossible.length) {
    console.log(
      `IMPOSSIBLE: floor ${impossible.map((r) => r.floor).join(', ')} cannot be swept within its own clock`,
    );
  }
  if (worst) {
    console.log(
      `tightest: floor ${worst.floor} — ${worst.scanningSeconds.toFixed(1)}s of scanning against a ` +
        `${worst.duration}s floor, ${worst.budgetLeft.toFixed(1)}s left for walking, judging and mistakes`,
    );
  }
  process.exit(impossible.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
