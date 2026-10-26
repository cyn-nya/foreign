import { describe, expect, it } from 'vitest';
import {
  MAX_DARKNESS,
  MAX_DARKNESS_FLOOR,
  MIN_DARKNESS,
  SCARE_FACES,
  SCARE_KINDS,
  SCARE_KIND_MS,
  darknessForFloor,
  nextScareDelay,
  pickScareFace,
  pickScareKind,
  scareDelayRange,
  scareKindsFor,
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


describe('how a fright is delivered', () => {
  it('keeps the shallow floors to the one kind a new player can read', () => {
    // A blackout on floor 1 reads as a bug, not a threat: the player has not
    // learnt the room yet, so losing the light teaches them nothing.
    expect(scareKindsFor(0.2)).toEqual(['flash']);
    expect(scareKindsFor(0)).toEqual(['flash']);
  });

  it('unlocks the slower and darker kinds as the floors get worse', () => {
    const mid = scareKindsFor(0.6);
    expect(mid).toContain('lunge');
    expect(mid).not.toContain('blackout');

    const deep = scareKindsFor(0.9);
    expect(deep).toContain('blackout');
    expect(deep).toContain('double');
  });

  it('only ever offers kinds that exist', () => {
    for (const intensity of [0, 0.5, 0.55, 0.72, 1, 5, -1]) {
      for (const kind of scareKindsFor(intensity)) {
        expect(SCARE_KINDS).toContain(kind);
      }
    }
  });

  it('gives every kind a duration it can be held for', () => {
    for (const kind of SCARE_KINDS) {
      expect(SCARE_KIND_MS[kind]).toBeGreaterThan(0);
      // A fright that stays on screen is a picture, not a fright.
      expect(SCARE_KIND_MS[kind]).toBeLessThan(1_000);
    }
  });

  it('never deals the same kind twice in a row when it has a choice', () => {
    // The same reasoning as the faces: two identical frights in a row read as a
    // bug rather than as dread.
    let previous: string | null = null;
    for (let i = 0; i < 200; i++) {
      const kind = pickScareKind(Math.random, 1, previous as never);
      expect(kind).not.toBe(previous);
      previous = kind;
    }
  });

  it('still returns a kind when a repeat is unavoidable', () => {
    // Floor 1 has exactly one kind. That is a repeat by construction, not a bug.
    expect(pickScareKind(Math.random, 0.1, 'flash')).toBe('flash');
  });

  it('eventually uses every kind a deep floor unlocks', () => {
    const seen = new Set<string>();
    let previous: string | null = null;
    for (let i = 0; i < 400; i++) {
      previous = pickScareKind(Math.random, 1, previous as never);
      seen.add(previous);
    }
    // Otherwise the "variety" is one kind in a rotation costume.
    for (const kind of scareKindsFor(1)) expect(seen).toContain(kind);
  });

  it('is driven by the generator it is given, not by Math.random directly', () => {
    // A deterministic rng has to give a deterministic fright, or none of this is
    // reproducible in the acceptance run.
    const alwaysZero = () => 0;
    expect(pickScareKind(alwaysZero, 1, null)).toBe(pickScareKind(alwaysZero, 1, null));
  });
});
