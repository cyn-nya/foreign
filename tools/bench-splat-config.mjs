/**
 * Which splatting knob actually costs the frame?
 *
 * `bench:sort` asked whether the *frequency* cap on sorting helped, and it did not --
 * the renderer already sorts once per frame, so a minimum interval never binds on a
 * machine slow enough to need it. That was the wrong question. The renderer exposes
 * several settings that change what a frame *costs* rather than how often it runs, and
 * none of them had been measured at all:
 *
 *   pack.highPrecisionEnabled    sort/raster at full precision vs reduced
 *   raster.maxPixelRadius        how many pixels one gaussian may cover
 *   raster.maxStdDev             how far a gaussian is allowed to spread
 *   raster.detailCullingThreshold  when a gaussian is dropped for being too small
 *   sort.highPrecisionEnabled    precision of the per-frame depth sort
 *
 * Those are the candidates for the reported "7 fps at 0.40x on a good machine", where
 * the resolution has already been spent and the scene holds a single placed object.
 *
 * Correctness notes, because a benchmark that lies is worse than none:
 *
 *   * the camera is pinned to one pose and the floor, seed and quality level are fixed,
 *     so every condition renders the same image;
 *   * each condition samples for SAMPLE_MS and keeps a trimmed median, so one long
 *     frame at the start of a condition cannot decide the result;
 *   * a condition that draws fewer than MIN_FRAMES is not reported as a result. This
 *     machine renders the real room at about 0.5 fps, so a short sample is a few
 *     frames and a few frames is not a measurement;
 *   * no verdict is printed unless every condition qualified. A ranking built from
 *     unqualified numbers is how the last two performance conclusions went wrong.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startStatic } from '../tools/static-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE_MS = Number(process.env.SAMPLE_MS ?? 60_000);
const REPEATS = Number(process.env.REPEATS ?? 1);
const MIN_FRAMES = 20;

const POSE = { x: -4.148, y: 1.0, z: 1.232, yaw: -1.786, pitch: 0.082 };

/**
 * Each condition is a patch merged into the Splatting plugin config. `null` means
 * leave the viewer's own default alone, which is what "baseline" has to mean for the
 * comparison to say anything.
 */
const CONDITIONS = [
  // The control. This does not test a knob -- it tests the benchmark. The room is 63 MB
  // over the network, and the first version of this file opened a fresh page per
  // condition with a 45 s sample and measured a room that had not arrived yet: the
  // baseline came out at 74 ms against 2017 ms for the identical view in bench-render,
  // `maxStdDev` "made the frame slower", and the winner was exactly the time a frame
  // takes with the reconstruction hidden. Every one of those readings was a reading of
  // an empty room. A condition that hides the splats and must therefore be much cheaper
  // is how that gets caught here rather than in a conclusion.
  { name: 'CONTROL: splats hidden', hidden: true },
  { name: 'baseline (defaults)', patch: null },
  // What IS the reset value for the two knobs the ladder wants to move?
  //
  // The viewer merges its config and exposes no getter, so a setting cannot be read back
  // once it has been changed: `IViewerConfig` has only `pixelRatio` and `pipeline`, and
  // the raster fields carry no documented default. Restoring a level by writing a
  // plausible-looking number is a guess, and a guessed reset is how a quality ladder
  // silently keeps its cheapest settings forever.
  //
  // So the candidates are measured. If zero is the default, these two conditions match
  // the baseline; if they come out cheaper, zero means something else and the ladder
  // must not use it to restore anything.
  { name: 'detailCulling=0 (reset?)', patch: { raster: { detailCullingThreshold: 0 } } },
  { name: 'maxPixelRadius=0 (reset?)', patch: { raster: { maxPixelRadius: 0 } } },
  { name: 'sort.highPrecision=false', patch: { sort: { highPrecisionEnabled: false } } },
  { name: 'pack.highPrecision=false', patch: { pack: { highPrecisionEnabled: false } } },
  { name: 'raster.maxPixelRadius=2', patch: { raster: { maxPixelRadius: 2 } } },
  { name: 'raster.maxStdDev=1.5', patch: { raster: { maxStdDev: 1.5 } } },
  { name: 'raster.detailCulling=0.02', patch: { raster: { detailCullingThreshold: 0.02 } } },
  {
    name: 'all cheap knobs together',
    patch: {
      sort: { highPrecisionEnabled: false },
      raster: { maxPixelRadius: 2, maxStdDev: 1.5, detailCullingThreshold: 0.02 },
    },
  },
];

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/** Drop the slowest 10% -- start-up and GC land there, and they are not signal. */
function trimmedMedian(times) {
  const s = [...times].sort((a, b) => a - b);
  const keep = s.slice(0, Math.max(1, Math.floor(s.length * 0.9)));
  return median(keep);
}

async function main() {
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
  const errors = [];

  // Warm-up. The room is 63 MB and the first page that asks for it pays for the whole
  // download; every later page gets it from the HTTP cache. Without this the first
  // condition is measured during the transfer and is not comparable with the rest.
  {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    await page.goto(`${server.url}/?autostart=1&floor=4&seed=11`, {
      waitUntil: 'load',
      timeout: 180_000,
    });
    await page.waitForFunction(() => window.__splat && window.__splat.ready, null, {
      timeout: 300_000,
    });
    const warm = await page.evaluate(async () => {
      const s = window.__splat;
      // Wait until the frame is expensive, which only happens once the reconstruction is
      // in the scene. The thresholds are relative to this machine's own empty-scene
      // time, so they do not encode a speed this hardware does not have.
      const until = performance.now() + 240_000;
      let slow = 0;
      while (performance.now() < until) {
        const t0 = performance.now();
        await new Promise((r) => requestAnimationFrame(r));
        if (performance.now() - t0 > 200) slow += 1;
        else slow = 0;
        if (slow >= 3) return { ready: true, ms: performance.now() - t0 };
      }
      return { ready: false, ms: 0 };
    });
    process.stdout.write(
      warm.ready
        ? `warm-up: the reconstruction is in the scene (${warm.ms.toFixed(0)} ms/frame)\n`
        : 'warm-up: THE ROOM NEVER LOADED — every number below would be a measurement of an empty scene\n',
    );
    await page.close();
  }

  const results = [];
  for (const condition of CONDITIONS) {
    const samples = [];
    for (let rep = 0; rep < REPEATS; rep++) {
      // A new page per sample, because the viewer config merges: a condition cannot be
      // undone, and a leaked setting would be measured as part of the next condition.
      const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
      page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
      await page.goto(`${server.url}/?autostart=1&floor=4&seed=11`, {
        waitUntil: 'load',
        timeout: 180_000,
      });
      await page.waitForFunction(() => window.__splat && window.__splat.ready, null, {
        timeout: 300_000,
      });

      const out = await page.evaluate(
        async ({ patch, pose, sampleMs, hidden }) => {
          const s = window.__splat;

          // Wait for the reconstruction to be in the scene before measuring anything.
          // `ready` means the viewer exists; `anchors()` is already non-empty before the
          // 63 MB has arrived. The frame getting expensive is the event itself, so that
          // is what to wait for -- an empty scene renders in tens of milliseconds and
          // the reconstruction cannot. A sample that decided not to wait is how the
          // first version of this file reported an empty room as a 77% win.
          const settleUntil = performance.now() + 240_000;
          let slow = 0;
          let frameMs = 0;
          while (performance.now() < settleUntil && slow < 3) {
            const t0 = performance.now();
            await new Promise((r) => requestAnimationFrame(r));
            frameMs = performance.now() - t0;
            slow = frameMs > 200 ? slow + 1 : 0;
          }

          // Pin everything that is not the variable under test.
          s.setQuality(5);
          s.teleport(pose.x, pose.y, pose.z, pose.yaw, pose.pitch);
          if (hidden) s.setSplatsVisible(false);
          else s.applySplatPatch(patch ?? {});

          const times = [];
          let last = performance.now();
          const until = last + sampleMs;
          await new Promise((resolve) => {
            const step = () => {
              const now = performance.now();
              times.push(now - last);
              last = now;
              if (now >= until) resolve();
              else requestAnimationFrame(step);
            };
            requestAnimationFrame(step);
          });
          if (hidden) s.setSplatsVisible(true);
          return { times: times.slice(1), ready: slow >= 3, frameMs, ratio: s.quality().ratio };
        },
        { patch: condition.patch, pose: POSE, sampleMs: SAMPLE_MS, hidden: !!condition.hidden },
      );
      samples.push(out);
      await page.close();
    }

    const all = samples.flatMap((s) => s.times);
    results.push({
      name: condition.name,
      frames: all.length,
      ready: samples.every((s) => s.ready),
      median: all.length ? trimmedMedian(all) : null,
    });
    process.stdout.write(
      `  ${condition.name.padEnd(30)} ${String(all.length).padStart(5)} frames  ` +
        `median ${all.length ? trimmedMedian(all).toFixed(0).padStart(5) : '    —'} ms\n`,
    );
  }

  const qualified = results.filter((r) => r.frames >= MIN_FRAMES && r.median !== null);
  const base = qualified.find((r) => r.name === 'baseline (defaults)');
  const control = qualified.find((r) => r.name === 'CONTROL: splats hidden');
  // The room must be present, and the reconstruction must be what is being paid for.
  // Without both, these numbers describe something other than the game.
  // The control is the exception: it hides the splats, so its frame is *supposed* to
  // be cheap once it is running. What it must not be is cheap because the room never
  // arrived, and that is what `ready` records -- it is measured before the hiding.
  const roomWasLoaded = results.every((r) => r.ready);
  const controlSeparates = !!base && !!control && base.median >= control.median * 3;

  process.stdout.write('\ncondition                        median frame\n');
  for (const r of results) {
    process.stdout.write(
      `  ${r.name.padEnd(30)} ${r.median === null ? '—' : `${r.median.toFixed(0)} ms`}` +
        `${r.frames < MIN_FRAMES ? `   (only ${r.frames} frames — not a measurement)` : ''}\n`,
    );
  }

  if (!roomWasLoaded) {
    process.stdout.write(
      `\nNO VERDICT: the room never loaded in at least one condition ` +
        `(anchor counts: ${results.map((r) => r.anchors).join(', ')}). These frame times ` +
        `describe an empty scene, not the game.\n`,
    );
  } else if (!controlSeparates) {
    process.stdout.write(
      `\nNO VERDICT: hiding the reconstruction did not make the frame dramatically ` +
        `cheaper (${base ? base.median.toFixed(0) : '—'} ms with it, ` +
        `${control ? control.median.toFixed(0) : '—'} ms without). If the splats are not ` +
        `the dominant cost, none of these knobs is what to look at, and the ranking below ` +
        `would be a ranking of noise.\n`,
    );
  } else if (qualified.length !== CONDITIONS.length || !base) {
    process.stdout.write(
      `\nNO VERDICT: ${qualified.length}/${CONDITIONS.length} conditions drew at least ` +
        `${MIN_FRAMES} frames and one of them was the baseline. Raising SAMPLE_MS is the ` +
        `fix; reading a ranking off the numbers above is not.\n`,
    );
  } else {
    const better = qualified
      .filter((r) => r !== base)
      .map((r) => ({ ...r, gain: (base.median - r.median) / base.median }))
      .sort((a, b) => b.gain - a.gain);
    const best = better[0];
    process.stdout.write(
      `\nVERDICT: best single change is "${best.name}" at ${(best.gain * 100).toFixed(1)}% ` +
        `off the frame (${base.median.toFixed(0)} -> ${best.median.toFixed(0)} ms).\n`,
    );
    const combined = qualified.find((r) => r.name === 'all cheap knobs together');
    if (combined) {
      const gain = (base.median - combined.median) / base.median;
      process.stdout.write(
        `         all of them together: ${(gain * 100).toFixed(1)}% ` +
          `(${base.median.toFixed(0)} -> ${combined.median.toFixed(0)} ms). ` +
          (gain < 0.1
            ? 'Under 10% — none of these knobs is the bottleneck, and the honest next ' +
              'step is to read the GPU the browser actually used rather than guess again.\n'
            : 'Worth wiring into the quality ladder at the low end.\n'),
      );
    }
  }

  if (errors.length) process.stdout.write(`\npage errors: ${errors.slice(0, 3).join(' | ')}\n`);
  await browser.close();
  await server.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
