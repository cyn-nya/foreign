import { describe, expect, it } from 'vitest';
import { DEFAULT_QUALITY_LEVEL, PANIC_FPS, QUALITY_LEVELS, STREAK_TO_CHANGE, TARGET_HIGH_FPS, TARGET_LOW_FPS, evaluateQuality, initialQuality, pixelRatioForLevel, qualityLabel, type QualityState } from '../src/splat/quality';

/** Feed a run of readings in and return the settled state. */
function run(readings: (number | null)[], from: QualityState = initialQuality()): QualityState {
  return readings.reduce((state, fps) => evaluateQuality(state, fps), from);
}

describe('adaptive render resolution', () => {
  it('starts in the middle, so the worst case is bounded', () => {
    // This used to assert that it started at the top, and the assertion was the design
    // talking. The design changed on evidence: the one real player's machine sat at the
    // floor and their first twenty seconds were a slideshow, which is the only impression
    // they formed. Starting mid-scale halves how long a slow machine is unplayable, and a
    // fast machine climbs back within a reading or two.
    expect(initialQuality()).toEqual({ level: DEFAULT_QUALITY_LEVEL, streak: 0, changes: 0 });
    // Neither extreme. At the top there is nothing to climb to; at the bottom the game
    // would be blurry for a good machine with no way to prove otherwise.
    expect(DEFAULT_QUALITY_LEVEL).toBeGreaterThan(0);
    expect(DEFAULT_QUALITY_LEVEL).toBeLessThan(QUALITY_LEVELS.length - 1);
    // The value of the change, stated as the property it buys: at most two steps of
    // descent before the floor, which at two readings per step is seconds, not half a minute.
    expect(DEFAULT_QUALITY_LEVEL).toBeLessThanOrEqual(2);
  });

  it('keeps the levels ordered and bounded, since pixelRatio is used as given', () => {
    for (let i = 1; i < QUALITY_LEVELS.length; i++) {
      expect(QUALITY_LEVELS[i]).toBeGreaterThan(QUALITY_LEVELS[i - 1]);
    }
    expect(QUALITY_LEVELS[0]).toBeGreaterThan(0.2);
    expect(QUALITY_LEVELS[QUALITY_LEVELS.length - 1]).toBe(1);
  });

  it('drops resolution when the frame rate stays below the floor', () => {
    const slow = TARGET_LOW_FPS - 5;
    const settled = run(Array(STREAK_TO_CHANGE).fill(slow));
    expect(settled.level).toBe(DEFAULT_QUALITY_LEVEL - 1);
    expect(settled.changes).toBe(1);
  });

  it('does not react to one bad reading', () => {
    // A floor loading or a tab being refocused is not a reason to lose
    // resolution permanently, so a single slow reading must be absorbed.
    //
    // Asserted as "the level did not fall" rather than "nothing changed at all": starting
    // mid-scale means a run of comfortable readings legitimately climbs, and a test that
    // forbade any movement was really re-asserting the old starting point.
    const one = run([TARGET_LOW_FPS - 5]);
    expect(one.level).toBe(DEFAULT_QUALITY_LEVEL);
    expect(one.changes).toBe(0);
    // Absorbed, not replaced: a good reading after it leaves the level at or above the start.
    const after = run([TARGET_LOW_FPS - 5, 60, 60]);
    expect(after.level).toBeGreaterThanOrEqual(DEFAULT_QUALITY_LEVEL);
  });

  it('climbs back up when the frame rate is comfortable', () => {
    // Every drop costs STREAK_TO_CHANGE readings, and there are this many levels
    // to fall through, so anything less than the product does not reach the floor.
    const slow = run(Array(STREAK_TO_CHANGE * QUALITY_LEVELS.length).fill(10));
    expect(slow.level).toBe(0);
    const recovered = run(Array(STREAK_TO_CHANGE).fill(TARGET_HIGH_FPS + 20), slow);
    expect(recovered.level).toBe(1);
  });

  it('never leaves the scale, however hard it is pushed', () => {
    const bottom = run(Array(50).fill(1));
    expect(bottom.level).toBe(0);
    const top = run(Array(50).fill(500), bottom);
    expect(top.level).toBe(QUALITY_LEVELS.length - 1);
    expect(pixelRatioForLevel(top.level)).toBe(1);
  });

  it('is not moved by a reading that carries no information', () => {
    // `null` is "nothing measured yet" and 0 is "no frames completed". Treating
    // either as "too slow" would drop a player to the blurriest setting during a
    // load, which is when both of them actually happen.
    expect(run([null, 0, -1, Number.NaN]).level).toBe(DEFAULT_QUALITY_LEVEL);
    // and they must also break a streak rather than extend it
    const streaked = run([TARGET_LOW_FPS - 5, null, TARGET_LOW_FPS - 5]);
    expect(streaked.level).toBe(DEFAULT_QUALITY_LEVEL);
  });

  it('settles instead of oscillating', () => {
    // A frame rate that sits between the thresholds is the common case on a
    // machine that is merely adequate, and it must produce a stable level.
    const middling = TARGET_LOW_FPS + 5;
    const settled = run([middling, middling]);
    const after = run(Array(20).fill(middling), settled);
    expect(after.level).toBe(settled.level);
    expect(after.changes).toBe(settled.changes);
  });

  it('reports the multiplier, not a vague word', () => {
    // The number is what a player can quote when they report a problem.
    expect(qualityLabel(QUALITY_LEVELS.length - 1)).toBe('1.00x');
    expect(qualityLabel(0)).toMatch(/^0\.\d{2}x$/);
  });

  it('clamps an out-of-range level rather than returning undefined', () => {
    expect(pixelRatioForLevel(-3)).toBe(QUALITY_LEVELS[0]);
    expect(pixelRatioForLevel(99)).toBe(1);
  });
});

describe('a machine that is failing badly', () => {
  it('gives up more than one level per change, because waiting is its own cost', () => {
    // Start at full resolution and feed it frames this slow. One level per change
    // would take ten readings to reach the floor; the floor should arrive sooner.
    let state = initialQuality();
    const start = state.level;
    for (let i = 0; i < STREAK_TO_CHANGE; i++) {
      state = evaluateQuality(state, PANIC_FPS - 1);
    }
    expect(state.level).toBeLessThanOrEqual(start - 2);
  });

  it('still waits for consecutive readings, so one stalled frame is not a verdict', () => {
    const start = initialQuality();
    const afterOne = evaluateQuality(start, PANIC_FPS - 1);
    expect(afterOne.level).toBe(start.level);
    expect(afterOne.changes).toBe(0);
  });

  it('does not panic over a reading that is merely below target', () => {
    // The distinction the threshold exists for: 20 fps is too slow to keep and not
    // slow enough to skip a level over.
    let state = initialQuality();
    for (let i = 0; i < STREAK_TO_CHANGE; i++) {
      state = evaluateQuality(state, TARGET_LOW_FPS - 1);
    }
    expect(state.level).toBe(initialQuality().level - 1);
  });

  it('never overshoots the floor when panicking', () => {
    let state: QualityState = { level: 1, streak: 0, changes: 0 };
    for (let i = 0; i < STREAK_TO_CHANGE; i++) {
      state = evaluateQuality(state, PANIC_FPS - 1);
    }
    expect(state.level).toBe(0);
    expect(pixelRatioForLevel(state.level)).toBe(QUALITY_LEVELS[0]);
  });

  it('a panic is still monotone: it never raises the level', () => {
    let state = initialQuality();
    let previous = state.level;
    for (const fps of [1, 1, 2, 1, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1]) {
      state = evaluateQuality(state, fps);
      expect(state.level).toBeLessThanOrEqual(previous);
      previous = state.level;
    }
    expect(state.level).toBe(0);
  });
});
