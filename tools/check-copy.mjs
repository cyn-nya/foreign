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

import { readFileSync, readdirSync } from 'node:fs';

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
  'index.html',
  'src/splat/main.ts',
  'tools/build-demo-page.mjs',
  'tools/build-deck.py',
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

const failed = checks.filter((c) => !c.ok);
console.log();
console.log(`${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  console.log();
  console.log('the rules changed and this prose did not follow them');
  process.exit(1);
}
