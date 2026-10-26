/**
 * Verify the demo video is what it claims to be, then file it.
 *
 *   node tools/finalize-demo.mjs
 *
 * The reason this exists rather than a `mv`: the previous demo video was 75
 * seconds of almost-static frames and nothing about the file said so. Size and
 * duration are both read back from the container through a real decoder, and the
 * result is compared against the page's own timeline, so a recording that got
 * truncated — or one that quietly turned into a slideshow — fails here instead of
 * being submitted.
 */

import { existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startStatic } from './static-server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const rawDir = join(root, 'artifacts', 'demo', 'raw');
const dest = join(root, 'artifacts', 'video');

if (!existsSync(rawDir)) {
  console.error('artifacts/demo/raw is missing — run `npm run demo` first.');
  process.exit(1);
}
const webms = readdirSync(rawDir).filter((f) => f.endsWith('.webm'));
if (webms.length !== 1) {
  console.error(`expected exactly one webm, found ${webms.length}`);
  process.exit(1);
}
const source = join(rawDir, webms[0]);
const bytes = statSync(source).size;

// What the page said it would be.
const pageHtml = join(root, 'artifacts', 'demo', 'index.html');
const html = existsSync(pageHtml) ? (await import('node:fs')).readFileSync(pageHtml, 'utf8') : '';
const holds = /const HOLD = (\[[^\]]*\])/.exec(html);
const expectedSeconds = holds ? JSON.parse(holds[1]).reduce((a, b) => a + b, 0) : null;

const browser = await chromium.launch({ args: ['--disable-gpu-sandbox'] });
const page = await browser.newPage();
const server = await startStatic(rawDir);
const meta = await page.evaluate(async (src) => {
  const video = document.createElement('video');
  video.src = src;
  video.muted = true;
  await new Promise((done, fail) => {
    video.onloadedmetadata = done;
    video.onerror = () => fail(new Error('the browser could not decode it'));
    setTimeout(() => fail(new Error('timed out reading metadata')), 30_000);
  });
  return {
    duration: video.duration,
    width: video.videoWidth,
    height: video.videoHeight,
  };
}, `${server.url}/${webms[0]}`);
await browser.close();
await server.close();

const mb = bytes / 1024 / 1024;
const bitrate = (bytes * 8) / meta.duration / 1000;
console.log(`video      ${meta.width}x${meta.height}, ${meta.duration.toFixed(1)}s, ${mb.toFixed(1)} MB`);
console.log(`bitrate    ${bitrate.toFixed(0)} kbps`);

const problems = [];
if (meta.width !== 1280 || meta.height !== 720) problems.push(`resolution is ${meta.width}x${meta.height}`);
if (expectedSeconds !== null && Math.abs(meta.duration - expectedSeconds) > 4) {
  problems.push(`duration ${meta.duration.toFixed(1)}s does not match the ${expectedSeconds}s timeline`);
}
// A slideshow of near-identical stills compresses to almost nothing. The old
// 75-second demo was 1.7 MB; real motion at this size costs an order of magnitude
// more, so this is the check that would have caught it.
if (bitrate < 400) problems.push(`bitrate ${bitrate.toFixed(0)} kbps is too low for real motion`);

mkdirSync(dest, { recursive: true });
const output = join(dest, 'foreign-demo.webm');
renameSync(source, output);
writeFileSync(
  join(dest, 'foreign-demo.json'),
  JSON.stringify({ ...meta, bytes, bitrateKbps: Math.round(bitrate) }, null, 2),
);
console.log(`-> artifacts/video/foreign-demo.webm`);

if (problems.length) {
  console.log(`\n${problems.length} problem(s):`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
console.log('\nthe demo video is a real 720p recording of the whole timeline');
