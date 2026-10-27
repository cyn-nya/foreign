/**
 * Footsteps are a distance, not a timer.
 *
 * The failure this pins down is the one a horror game cannot afford: a player standing still,
 * holding their breath, listening — while the game clicks at them on an interval. A fixed
 * timer does exactly that, and it is invisible in a screenshot and in a frame time.
 *
 * The other half is the reason the interval floor exists: a long frame at a low frame rate
 * must not turn one stride into several, or a player who is merely walking sounds like they
 * are being chased.
 */
import { describe, expect, it } from 'vitest';
import {
  MIN_STEP_INTERVAL_S,
  STRIDE_M,
  advanceSteps,
  initialSteps,
} from '../src/splat/steps.ts';
import { musicLevelForFloor } from '../src/splat/horror.ts';
import { FINAL_FLOOR } from '../src/game/rules.ts';

/** Walk `metres` in `frames` even steps, and report how many footsteps came out. */
function walk(metres: number, frames: number, dt = 0.1, perFrame?: number) {
  let state = initialSteps();
  let count = 0;
  for (let i = 0; i < frames; i++) {
    const moved = perFrame ?? metres / frames;
    const advanced = advanceSteps(state, moved, dt);
    state = advanced.state;
    if (advanced.stepped) count += 1;
  }
  return { count, state };
}

describe('when a foot lands', () => {
  it('says nothing at all while the player is standing still', () => {
    // The whole point. A hundred frames of no movement must produce no sound, however much
    // wall-clock time passes.
    let state = initialSteps();
    for (let i = 0; i < 100; i++) {
      const advanced = advanceSteps(state, 0, 3);
      state = advanced.state;
      expect(advanced.stepped, `frame ${i} of standing still made a sound`).toBe(false);
    }
    expect(state.count).toBe(0);
  });

  it('takes about one step per stride when walking', () => {
    const { count } = walk(STRIDE_M * 10, 200, 0.05, STRIDE_M * 10 / 200);
    expect(count).toBeGreaterThanOrEqual(9);
    expect(count).toBeLessThanOrEqual(11);
  });

  it('does not fire faster than a stride, however fast the player moves', () => {
    // One enormous frame covering ten strides. Without the interval floor this is ten
    // footsteps in one frame, which sounds like a stutter, not like running.
    const advanced = advanceSteps(initialSteps(), STRIDE_M * 10, 0.02);
    expect(advanced.stepped, 'a single frame must produce a step').toBe(true);
    expect(advanced.state.count, 'a single frame must not produce a burst').toBe(1);
  });

  it('respects the interval floor across a burst of frames', () => {
    // Moving fast enough to earn a step every frame, but the frames are shorter than the
    // floor, so at most one step per MIN_STEP_INTERVAL_S is allowed.
    let state = initialSteps();
    let count = 0;
    const dt = MIN_STEP_INTERVAL_S / 4;
    for (let i = 0; i < 20; i++) {
      const advanced = advanceSteps(state, STRIDE_M * 2, dt);
      state = advanced.state;
      if (advanced.stepped) count += 1;
    }
    // 20 frames x dt is 5x the interval, so at most 5 or 6 steps, not 20.
    expect(count).toBeLessThanOrEqual(6);
    expect(count).toBeGreaterThan(0);
  });

  it('does not lose the distance past a stride, so the rate is frame-rate independent', () => {
    // Carrying the remainder is what makes 20 small frames and 2 big ones agree.
    const small = walk(STRIDE_M * 4, 40, 0.05, STRIDE_M * 0.1);
    const large = walk(STRIDE_M * 4, 4, 0.5, STRIDE_M);
    expect(small.count).toBe(large.count);
  });

  it('ignores a nonsense frame time rather than counting a step from it', () => {
    const nan = advanceSteps(initialSteps(), Number.NaN, Number.NaN);
    expect(nan.stepped).toBe(false);
    expect(nan.state.count).toBe(0);
    const negative = advanceSteps(initialSteps(), -5, -5);
    expect(negative.stepped).toBe(false);
    expect(negative.state.count).toBe(0);
  });
});

describe('the musical bed deepens with the descent', () => {
  it('starts at nothing and reaches full on the last floor', () => {
    expect(musicLevelForFloor(1)).toBe(0);
    expect(musicLevelForFloor(FINAL_FLOOR)).toBe(1);
  });

  it('never goes backwards, so a floor is never a step up in comfort', () => {
    let previous = -1;
    for (let floor = 1; floor <= FINAL_FLOOR; floor++) {
      const level = musicLevelForFloor(floor);
      expect(level, `floor ${floor}`).toBeGreaterThanOrEqual(previous);
      previous = level;
    }
  });

  it('crosses the tritone threshold on the same floor the ghosts arrive', () => {
    // `setMusic` adds the tritone above 0.35. That has to be a floor the player reaches
    // before the last one, or the interval exists only in the endgame.
    const firstWithTritone = Array.from({ length: FINAL_FLOOR }, (_, i) => i + 1).find(
      (floor) => musicLevelForFloor(floor) > 0.35,
    );
    expect(firstWithTritone, 'the tritone never arrives').toBeDefined();
    expect(firstWithTritone).toBeLessThan(FINAL_FLOOR);
  });

  it('stays inside 0..1 outside the floor range', () => {
    expect(musicLevelForFloor(0)).toBe(0);
    expect(musicLevelForFloor(-3)).toBe(0);
    expect(musicLevelForFloor(99)).toBe(1);
  });
});
