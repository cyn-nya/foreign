/**
 * Every surface that teaches the rules has to teach the current rules.
 *
 *   node tools/check-copy.mjs
 *
 * The marking rule is simple -- a correct mark costs nothing, only a wrong one
 * does -- and it has now been stated wrongly in six separate places: the in-game
 * menu, the hint line under the crosshair, the README, the slide deck, the demo
 * video's captions and the registration copy. Each time it was found by hand,
 * after shipping, and each time the wrong version was written before the rule
 * changed and simply outlived it.
 *
 * Grepping for it by hand does not scale and does not survive being forgotten,
 * so the two things that keep going wrong are checked mechanically:
 *
 *   1. No surface may describe marking as the limited resource. The limit is on
 *      *misjudgements*; a phrase like "3 次标记机会" tells the player to walk past
 *      the anomaly they are most likely to miss.
 *   2. Every surface that states the limit must also say a correct mark is free,
 *      because the limit is only meaningful next to what it is not.
 *
 * This is a real check, not a spell-check: both halves were proved to fail before
 * being relied on (see the sabotage note in the commit).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';

/** Written by tools/count-assertions.mjs from the verify log. */
const ASSERTIONS = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'data/assertions.json'), 'utf8'));
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/**
 * Surfaces that state the rule to a player or a judge. These are the ones that
 * have actually rotted; a doc that never mentions marking is not a failure.
 */
const surfaces = [
  'README.md',
  'docs/06-真实房间摆放设计.md',
  'index.html',
  'src/splat/main.ts',
  'tools/build-demo-page.mjs',
  'tools/build-deck.py',
  'data/foreign-assets.json',
  'docs/04-报名材料.md',
];

/** Ways of saying "you may only mark three times", which is never true. */
const FORBIDDEN = [
  { re: /标记机会/, what: 'calls the limited resource "marking chances"' },
  { re: /只有\s*三\s*次机会/, what: 'says there are only three chances' },
  { re: /只有\s*3\s*次机会/, what: 'says there are only three chances' },
  { re: /标记次数(有限|只有)/, what: 'limits the number of marks' },
];

/** Ways of saying a correct mark is free. */
const FREE_MARK = /标对不|标记正确不|标对了不|打中不|命中不|标错才扣|打错才罚/;

const bodies = new Map();
for (const rel of surfaces) {
  try {
    bodies.set(rel, readFileSync(join(root, rel), 'utf8'));
  } catch {
    check(`\`${rel}\` exists`, false, 'the surface named in this check is missing');
  }
}

// 1. Nobody describes marking as the limited resource.
let offenders = 0;
for (const [rel, body] of bodies) {
  for (const { re, what } of FORBIDDEN) {
    const m = re.exec(body);
    if (m) {
      offenders++;
      const line = body.slice(0, m.index).split('\n').length;
      check(`\`${rel}\` does not limit marking`, false, `line ${line}: ${what} — "${m[0]}"`);
    }
  }
}
if (offenders === 0) {
  check(
    'no surface limits marking',
    true,
    `${bodies.size} surfaces, ${FORBIDDEN.length} phrasings, none present`,
  );
}

// 2. Every surface that states the limit also says a correct mark is free. The
//    positive half is what stops this degrading into "delete the sentence".
const MENTIONS_LIMIT = /3\s*次|三次|MAX_MISTAKES/;
let stated = 0;
for (const [rel, body] of bodies) {
  if (!MENTIONS_LIMIT.test(body)) continue;
  stated++;
  check(
    `\`${rel}\` says a correct mark is free`,
    FREE_MARK.test(body),
    FREE_MARK.test(body)
      ? 'found the positive half'
      : 'states a limit without saying that a correct mark costs nothing',
  );
}
check(
  'the positive half is actually asserted somewhere',
  stated > 0,
  stated > 0
    ? `${stated} surface(s) state the limit`
    : 'no surface states the limit, so the check above proved nothing',
);

// 3. The briefing in the game and the briefing in the video must agree that the
//    room's own furniture is innocent -- the other half of the same rule.
const INNOCENT = /不是目标|永远无辜|家具.*无辜/;
for (const rel of ['src/splat/main.ts', 'tools/build-demo-page.mjs']) {
  const body = bodies.get(rel);
  if (!body) continue;
  check(`\`${rel}\` says the furniture is innocent`, INNOCENT.test(body));
}

// 4. A hand-typed assertion count in the deck builder. The rigour slide claimed
//    "52 真实房间" while the real number had grown to 62, and nothing compared the
//    two -- the same rot as the rule sentence, one layer down. Every tile on that
//    slide now reads `data/assertions.json`, so a number typed into the source is
//    a number that will drift. The shape of the mistake is a quoted count next to
//    a label.
//
// The judgement is not "was this number typed in" but "does the number on the
// slide match the number the suite produces". The first version of this check
// asked the former, line by line, and was vacuous: the rigour slide puts two
// tiles on one line, so a line that mentioned `by_step` at all was skipped --
// including the hand-typed number sitting next to it. It passed with the 52 still
// in the file.
const DECK_BUILDER = 'tools/build-deck.py';
const TYPED_COUNT = /\("(\d{1,3})",\s*"([^"]*)"\)/g;
{
  const body = bodies.get(DECK_BUILDER) ?? readFileSync(join(root, DECK_BUILDER), 'utf8');
  const counts = new Set();
  for (const step of ASSERTIONS.steps) counts.add(step.count);
  const known = (n) => counts.has(n) || n === ASSERTIONS.total;
  const wrong = [];
  let m;
  while ((m = TYPED_COUNT.exec(body)) !== null) {
    const n = Number(m[1]);
    const line = body.slice(0, m.index).split('\n').length;
    if (!known(n)) wrong.push(`line ${line}: ${m[0]} — ${n} is not a count the suite reports`);
  }
  check(
    'every number the deck prints is a number the suite actually reports',
    wrong.length === 0,
    wrong.length === 0
      ? `all quoted counts are among the ${counts.size} the suite reports`
      : wrong.join(' | '),
  );
}

// 5. The anomaly kinds. `types.ts` declares them as a union and `docs/06` and the
//    tools slide each print a number. Both said a smaller number than the union
//    has -- six and five against seven -- and neither had anything comparing them
//    to the type. The union is the source of truth, so it is parsed from source.
const typesSrc = readFileSync(join(root, 'src/game/types.ts'), 'utf8');
const unionBody = /export type AnomalyKind =([\s\S]*?);/.exec(typesSrc)?.[1] ?? '';
const kindCount = [...unionBody.matchAll(/\|\s*'([a-z]+)'/g)].length;
check('the anomaly union parses', kindCount >= 2, `${kindCount} kind(s) found in types.ts`);

const KIND_CLAIM = /(?:现有\s*)?(\d+)\s*种异常|(\d+)\s*kinds? of anomaly/g;
const claimedKinds = [];
for (const [rel, body] of [...bodies, ['docs/06-真实房间摆放设计.md', null]]) {
  const src = body ?? readFileSync(join(root, rel), 'utf8');
  for (const m of src.matchAll(KIND_CLAIM)) {
    const n = Number(m[1] ?? m[2]);
    const line = src.slice(0, m.index).split('\n').length;
    if (n !== kindCount) claimedKinds.push(`${rel}:${line} says ${n}, types.ts has ${kindCount}`);
  }
}
check(
  'every surface that counts the anomaly kinds counts them all',
  claimedKinds.length === 0,
  claimedKinds.length === 0
    ? `${kindCount} kinds, every mention agrees`
    : claimedKinds.join(' | '),
);

// 6. Per-step assertion counts in prose. The README's table of what `verify` runs
//    said "52 项" for the real-room suite long after it had grown to 62; the table
//    is the first thing a judge reads about the testing, and nothing read it back.
const STEP_COUNT = /`([a-z][\w:-]*)`\s*\|\s*\*{0,2}(\d+)\s*项/g;
// "125 个单测" is the same claim in different words, and it was stale in two
// places -- the table row and the sentence above it -- precisely because the
// pattern above only looked for "N 项" after a step name in backticks.
const UNIT_TEST_CLAIM = /(\d+)\s*个单测/g;
const stepCounts = new Map(ASSERTIONS.steps.map((s) => [s.step, s.count]));
const wrongSteps = [];
for (const [rel, body] of bodies) {
  if (!/\.md$/.test(rel)) continue;
  for (const m of body.matchAll(STEP_COUNT)) {
    const [, step, n] = m;
    if (!stepCounts.has(step)) continue;
    if (Number(n) !== stepCounts.get(step)) {
      const line = body.slice(0, m.index).split('\n').length;
      wrongSteps.push(`${rel}:${line} says ${step} = ${n}, it is ${stepCounts.get(step)}`);
    }
  }
}
// A step the record does not mention is "not recorded", not `undefined`.
//
// `data/assertions.json` is written by a full run, and a run that stops early can
// leave it thin. Reading `stepCounts.get('test')` unguarded turned that into
// "README.md:209 says 134 unit tests, there are undefined" -- a message about a
// missing record that reads like a mistake in the docs, and sends the reader to
// the wrong file. If the record is thin, say so and say which step is missing.
const testCount = stepCounts.get('test');
if (testCount === undefined) {
  wrongSteps.push(
    'data/assertions.json records no unit-test count, so the docs cannot be ' +
      'checked against it -- run `npm run verify` to write a complete record',
  );
} else {
  for (const [rel, body] of bodies) {
    if (!/\.md$/.test(rel)) continue;
    for (const m of body.matchAll(UNIT_TEST_CLAIM)) {
      const n = Number(m[1]);
      if (n !== testCount) {
        const line = body.slice(0, m.index).split('\n').length;
        wrongSteps.push(`${rel}:${line} says ${n} unit tests, there are ${testCount}`);
      }
    }
  }
}
check(
  'the per-step counts in the docs match the suite',
  wrongSteps.length === 0,
  wrongSteps.length === 0
    ? `${stepCounts.size} steps, every printed count agrees`
    : wrongSteps.join(' | '),
);

// 7. The sizes of the two files the game streams. The tools slide said the voxel
//    was "304 KB": 304,628 bytes read as thousands, then labelled KB, which means
//    1024 -- so the slide was 7 KB out and nobody could have noticed, because a
//    unit is not a thing you can check by looking. The byte counts now live in
//    data/foreign-assets.json and every printed size is compared to them.
const CATALOGUE = JSON.parse(readFileSync(join(root, 'data/foreign-assets.json'), 'utf8'));
const SIZE_CLAIM = /([\d][\d,]{3,})\s*(?:字节|bytes)/g;
const sizes = [CATALOGUE.scene?.splat?.bytes, CATALOGUE.scene?.voxel?.bytes].filter(Boolean);
check('the streamed sizes are recorded', sizes.length === 2, `${sizes.length} of 2 recorded`);

// Everything a surface is allowed to print a size for. The asset total is summed
// from the files themselves, so it needs no record -- and it was a real claim that
// nothing checked: the demo caption said "10.1 MB" for 10,602,848 bytes, which is
// 10.1 *MiB*. That is the same mistake as the voxel's "304 KB", one surface over.
const assetDir = join(root, 'public/assets/foreign');
const assetFiles = readdirSync(assetDir).filter((f) => f.endsWith('.glb'));
const assetBytes = assetFiles.reduce((sum, f) => sum + statSync(join(assetDir, f)).size, 0);
const knownSizes = new Map([
  ...sizes.map((b, i) => [b, i === 0 ? 'the splat scene' : 'the voxel field']),
  [assetBytes, `the ${assetFiles.length} catalogue models`],
]);
check(
  'the catalogue total is measurable',
  assetFiles.length > 0 && assetBytes > 0,
  `${assetFiles.length} models, ${assetBytes} bytes`,
);

const wrongSizes = [];
let claimed = 0;
for (const [rel, body] of bodies) {
  for (const m of body.matchAll(SIZE_CLAIM)) {
    claimed++;
    const n = Number(m[1].replace(/,/g, ''));
    if (!knownSizes.has(n)) {
      const line = body.slice(0, m.index).split('\n').length;
      const near = [...knownSizes.keys()].map((b) => b.toLocaleString('en-US')).join(' / ');
      wrongSizes.push(`${rel}:${line} says ${m[1]} bytes; the real sizes are ${near}`);
    }
  }
}
check(
  'every printed file size is the size of the file it names',
  wrongSizes.length === 0,
  wrongSizes.length === 0 ? `${claimed} printed size(s), all match` : wrongSizes.join(' | '),
);

// 8. The size of the catalogue. `assets:check` holds the three parts of it to the
//    disk -- generated, placeholder, household -- and never the total, so the
//    README's "34 个资产" was free to say 44 and nothing objected. The sum is the
//    number a judge is most likely to repeat.
{
  const total = CATALOGUE.assets?.length ?? 0;
  const TOTAL_CLAIM = /(\d+)\s*个资产|(\d+)\s*assets?\b/g;
  const wrong = [];
  let seen = 0;
  for (const [rel, body] of bodies) {
    for (const m of body.matchAll(TOTAL_CLAIM)) {
      const n = Number(m[1] ?? m[2]);
      seen++;
      if (n !== total) {
        const line = body.slice(0, m.index).split('\n').length;
        wrong.push(`${rel}:${line} says ${n}, the catalogue holds ${total}`);
      }
    }
  }
  check(
    'every surface that counts the catalogue counts it correctly',
    wrong.length === 0 && seen > 0,
    wrong.length ? wrong.join(' | ') : seen === 0 ? 'nothing states the total, so this proved nothing' : `${seen} mention(s), all say ${total}`,
  );
}

// "MB" in prose, checked against the file the sentence is about.
//
// Banning it outright was the first instinct and it was too blunt: "63 MB" for
// 63,022,215 bytes is right, and four surfaces say it. What was wrong was saying
// "304 KB" for 304,628 bytes and "10.1 MB" for 10.1 *MiB* -- a unit used without
// being the unit meant. So the claim is checked rather than the unit: if the
// sentence names a file whose size is known, the number must be that file's size
// in metric megabytes. A number in a sentence about nothing in particular is not a
// claim about our files and is left alone.
{
  const MB_CLAIM = /(?<![\d.,])(\d+(?:\.\d+)?)\s*MB\b/g;
  const SUBJECTS = [
    { re: /splat|泼溅|高斯|场景|scene/i, bytes: CATALOGUE.scene?.splat?.bytes },
    { re: /voxel|体素/i, bytes: CATALOGUE.scene?.voxel?.bytes },
    { re: /资产|模型|models?/i, bytes: assetBytes },
  ];
  const wrongMb = [];
  let checkedMb = 0;
  for (const [rel, body] of bodies) {
    const lines = body.split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const m of line.matchAll(MB_CLAIM)) {
        // A rate is not a total. "~16 MB per asset" is the Lux3D budget for one
        // generation, not the size of the catalogue, and comparing it to the sum
        // of 34 files is a false alarm -- which is its own kind of broken check,
        // because a guard that cries wolf gets switched off.
        const after = line.slice(m.index + m[0].length, m.index + m[0].length + 12);
        if (/^\s*(per|每|\/)/i.test(after)) continue;
        // A before-and-after is a comparison, not a claim about the size now. "254.5 MB →
        // 111.5 MB" names the old figure on the left, and it has to be sayable -- the whole
        // point of recording that the assets were shrunk is the two numbers. Carved out the
        // same way a rate is, and for the same reason the rule above gives: a guard that cries
        // wolf gets switched off. Nothing is lost, because the number on the right is the
        // current one and is checked on its own.
        const transition = line.slice(m.index + m[0].length, m.index + m[0].length + 10);
        if (/^\s*(→|->|=>|缩到|降到|减到|变为|变到)/.test(transition)) continue;
        const subject = SUBJECTS.find((s) => s.bytes && s.re.test(line));
        if (!subject) continue;
        checkedMb++;
        const n = Number(m[1]);
        if (Math.abs(subject.bytes / 1e6 - n) > 0.6) {
          wrongMb.push(
            `${rel}:${i + 1} says ${m[1]} MB where the file is ${(subject.bytes / 1e6).toFixed(1)} MB`,
          );
        }
      }
    });
  }
  check(
    'a size in MB matches the file the sentence is about',
    wrongMb.length === 0,
    wrongMb.length === 0 ? `${checkedMb} MB claim(s), all metric-correct` : wrongMb.join(' | '),
  );
}

const failed = checks.filter((c) => !c.ok);
console.log();
console.log(`${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  console.log();
  console.log('the rules changed and this prose did not follow them');
  process.exit(1);
}
