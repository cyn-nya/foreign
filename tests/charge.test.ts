import { describe, expect, it } from 'vitest';
import {
  CHARGE_FIRST_FLOOR,
  chargeChanceForFloor,
  chargeWindowForFloor,
} from '../src/splat/horror.ts';

describe('the charge window', () => {
  it('does not exist before the floor that introduces it', () => {
    // Floors 1 and 2 are about looking. A charge there would be a test of reflexes
    // before the game has taught what to react to.
    for (let floor = 1; floor < CHARGE_FIRST_FLOOR; floor++) {
      expect(chargeChanceForFloor(floor), `floor ${floor}`).toBe(0);
    }
    expect(chargeChanceForFloor(CHARGE_FIRST_FLOOR)).toBeGreaterThan(0);
  });

  it('shortens with depth and never goes below what a person can answer', () => {
    const first = chargeWindowForFloor(CHARGE_FIRST_FLOOR);
    expect(first).toBe(2200);
    // Monotone: a deeper floor is never more forgiving than a shallower one. A curve
    // that went back up would make the deepest floors the easiest places to be caught.
    for (let floor = CHARGE_FIRST_FLOOR; floor <= 20; floor++) {
      expect(chargeWindowForFloor(floor + 1)).toBeLessThanOrEqual(chargeWindowForFloor(floor));
    }
    // The floor of 1000 ms is the point of the clamp, and it is a design decision
    // rather than an accident: below roughly a second this stops being a test of the
    // player and becomes a coin toss they cannot win.
    expect(chargeWindowForFloor(50)).toBe(1000);
    expect(first).toBeGreaterThan(1000);
  });

  it('gets more common with depth but never becomes the only thing that happens', () => {
    let previous = 0;
    for (let floor = CHARGE_FIRST_FLOOR; floor <= 20; floor++) {
      const chance = chargeChanceForFloor(floor);
      expect(chance).toBeGreaterThanOrEqual(previous);
      expect(chance).toBeLessThan(0.7);
      previous = chance;
    }
    // The quiet between frights is what makes them land, so a floor made only of
    // charges would be a worse floor.
    expect(chargeChanceForFloor(20)).toBeLessThan(1);
  });
});
