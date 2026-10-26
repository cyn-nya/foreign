import { describe, expect, it } from 'vitest';
import {
  MAX_DARKNESS,
  MAX_DARKNESS_FLOOR,
  MIN_DARKNESS,
  SCARE_FACES,
  darknessForFloor,
  nextScareDelay,
  pickScareFace,
  scareDelayRange,
  torchFlickerForFloor,
  torchRadiusForFloor,
} from '../src/splat/horror';

describe('the room darkens as the run goes down', () => {
  it('starts lit enough to search and never goes fully black', () => {
    expect(darknessForFloor(1)).toBeCloseTo(MIN_DARKNESS, 6);
    // The cap is what keeps it a search rather than a guess. A room at 1.0 is
    // not a harder game, it is a black screen.
    for (let floor = 1; floor <= 40; floor++) {
      const value = darknessForFloor(floor);
      expect(value).toBeLessThanOrEqual(MAX_DARKNESS);
      expect(value).toBeGreaterThan(0);
    }
  });

  it('gets strictly darker every floor until it stops', () => {
    for (let floor = 1; floor < MAX_DARKNESS_FLOOR; floor++) {
      expect(darknessForFloor(floor + 1)).toBeGreaterThan(darknessForFloor(floor));
    }
    // And then holds, so the late floors are hard but not progressively blind.
    expect(darknessForFloor(MAX_DARKNESS_FLOOR + 1)).toBe(darknessForFloor(MAX_DARKNESS_FLOOR));
  });
});

describe('the torch narrows', () => {
  it('is widest on the first floor and tightest at the end', () => {
    expect(torchRadiusForFloor(1)).toBeGreaterThan(torchRadiusForFloor(4));
    expect(torchRadiusForFloor(4)).toBeGreaterThan(torchRadiusForFloor(MAX_DARKNESS_FLOOR));
    // Two-sided: a beam that collapses to nothing is the same failure as a room
    // that is fully black.
    for (let floor = 1; floor <= 40; floor++) {
      expect(torchRadiusForFloor(floor)).toBeGreaterThan(0.2);
      expect(torchRadiusForFloor(floor)).toBeLessThanOrEqual(0.62);
    }
  });

  it('flickers more the deeper the run is', () => {
    expect(torchFlickerForFloor(1)).toBeLessThan(torchFlickerForFloor(5));
    for (let floor = 1; floor <= 40; floor++) {
      expect(torchFlickerForFloor(floor)).toBeLessThanOrEqual(1);
      expect(torchFlickerForFloor(floor)).toBeGreaterThan(0);
    }
  });
});

describe('the quiet between frights shortens', () => {
  it('draws inside its own range', () => {
    for (let floor = 1; floor <= 12; floor++) {
      const { min, max } = scareDelayRange(floor);
      for (const sample of [0, 0.5, 0.999]) {
        const delay = nextScareDelay(() => sample, floor);
        expect(delay).toBeGreaterThanOrEqual(min);
        expect(delay).toBeLessThanOrEqual(max);
      }
    }
  });

  it('leaves the first floor long gaps and the last one short', () => {
    const first = scareDelayRange(1);
    const last = scareDelayRange(MAX_DARKNESS_FLOOR);
    expect(first.min).toBeGreaterThan(last.min);
    expect(first.max).toBeGreaterThan(last.max);
    // Even the deepest floor has to breathe; a scare every second is noise.
    expect(last.min).toBeGreaterThan(5);
  });
});

describe('scare faces', () => {
  it('never repeats the previous one immediately', () => {
    for (const previous of SCARE_FACES) {
      for (const sample of [0, 0.3, 0.7, 0.999]) {
        const face = pickScareFace(() => sample, previous);
        expect(face).not.toBe(previous);
        expect(SCARE_FACES).toContain(face);
      }
    }
  });

  it('can still choose any face when there is no previous one', () => {
    const seen = new Set(SCARE_FACES.map((_, i) => pickScareFace(() => i / SCARE_FACES.length, null)));
    expect(seen.size).toBe(SCARE_FACES.length);
  });
});
