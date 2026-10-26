import { describe, expect, it } from 'vitest';
import {
  anomalyCountForFloor,
  durationForFloor,
  floorClearScore,
  formatClock,
  generateFloor,
  hitScore,
  judgeMark,
  makeSeed,
  MAX_MISTAKES,
  mulberry32,
  resetAnomalySerial,
  SCORE,
} from '../src/game/rules';
import { ANCHORS_BY_ID, FOREIGN_ASSETS, SLOTS, SLOTS_BY_ID } from '../src/game/catalog';
import type { AnomalyKind } from '../src/game/types';

const ANOMALY_KINDS = ['intrude', 'stare', 'shift', 'warp', 'twin'] as const;

describe('rng', () => {
  it('is deterministic for a given seed', () => {
    const a = mulberry32(1234);
    const b = mulberry32(1234);
    const seqA = Array.from({ length: 8 }, () => a());
    const seqB = Array.from({ length: 8 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it('produces values in [0, 1)', () => {
    const rng = mulberry32(99);
    for (let i = 0; i < 500; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('gives different streams for different floors', () => {
    expect(makeSeed(1, 7)).not.toBe(makeSeed(2, 7));
  });
});

describe('difficulty curve', () => {
  it('never asks for zero anomalies', () => {
    for (let f = 1; f <= 40; f++) expect(anomalyCountForFloor(f)).toBeGreaterThanOrEqual(1);
  });

  it('caps the anomaly count', () => {
    for (let f = 1; f <= 200; f++) expect(anomalyCountForFloor(f)).toBeLessThanOrEqual(6);
  });

  it('never forces a humanly impossible clock', () => {
    for (let f = 1; f <= 200; f++) expect(durationForFloor(f)).toBeGreaterThanOrEqual(105);
  });
});

describe('floor generation', () => {
  it('replays identically for the same seed', () => {
    resetAnomalySerial();
    const a = generateFloor(5, makeSeed(5, 42));
    resetAnomalySerial();
    const b = generateFloor(5, makeSeed(5, 42));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('opens with one unmissable intruder on floor 1', () => {
    resetAnomalySerial();
    const plan = generateFloor(1, makeSeed(1, 1));
    expect(plan.anomalies).toHaveLength(1);
    expect(plan.anomalies[0].kind).toBe('intrude');
    expect(plan.anomalies[0].assetKey).toBe('duck');
  });

  it('only ever references real slots and real assets', () => {
    resetAnomalySerial();
    for (let floor = 2; floor <= 30; floor++) {
      const plan = generateFloor(floor, makeSeed(floor, 2026));
      for (const a of plan.anomalies) {
        expect(ANOMALY_KINDS).toContain(a.kind);
        if (a.kind === 'intrude' || a.kind === 'stare') {
          // placed objects hang off a synthetic anchor, not a furniture slot
          expect(ANCHORS_BY_ID.has(a.slotId)).toBe(true);
          expect(FOREIGN_ASSETS.some((f) => f.key === a.assetKey)).toBe(true);
        } else {
          expect(SLOTS_BY_ID.has(a.slotId)).toBe(true);
          // anchored props (wall art, rugs, ceiling lights) must not be
          // floated or duplicated — they are part of the architecture
          expect(SLOTS_BY_ID.get(a.slotId)?.anchored).toBeFalsy();
        }
      }
    }
  });

  it('never marks the same slot twice in one floor', () => {
    resetAnomalySerial();
    for (let floor = 2; floor <= 40; floor++) {
      const plan = generateFloor(floor, makeSeed(floor, 5));
      const slots = plan.anomalies.map((a) => a.slotId);
      expect(new Set(slots).size).toBe(slots.length);
    }
  });

  it('keeps hiddenSlots and twinSlots consistent with the anomalies', () => {
    resetAnomalySerial();
    const plan = generateFloor(12, makeSeed(12, 3));
    for (const a of plan.anomalies) {
      if (a.kind === 'twin') expect(plan.twinSlots).toContain(a.slotId);
    }
  });

  it('honours forced kinds (used by the harness)', () => {
    resetAnomalySerial();
    const plan = generateFloor(9, makeSeed(9, 11), { kinds: ['warp', 'warp'] });
    expect(plan.anomalies.map((a) => a.kind)).toEqual(['warp', 'warp']);
  });

  it('gives every anomaly a readable label', () => {
    resetAnomalySerial();
    for (let floor = 2; floor <= 20; floor++) {
      const plan = generateFloor(floor, makeSeed(floor, 77));
      for (const a of plan.anomalies) expect(a.label.length).toBeGreaterThan(3);
    }
  });

  it('respects the slot catalogue size', () => {
    // a floor must never demand more anomalies than there are distinct slots
    resetAnomalySerial();
    const plan = generateFloor(99, makeSeed(99, 1));
    expect(plan.anomalies.length).toBeLessThanOrEqual(Math.min(6, SLOTS.length));
  });
});

/**
 * The redesign contract.
 *
 * Playtest feedback: the old anomaly set was not judgeable. 'vanish' and the
 * small 'shift' nudge could only be spotted by remembering the room's baseline,
 * which made the game a memory test. Every kind is now self-evident, and these
 * tests keep it that way — a regression here is a design regression, not a
 * cosmetic one.
 */
describe('every anomaly is judgeable without memorising the room', () => {
  const EVIDENT: AnomalyKind[] = ['intrude', 'stare', 'shift', 'warp', 'twin'];

  it('never produces a kind that needs a memorised baseline', () => {
    resetAnomalySerial();
    for (let floor = 1; floor <= 30; floor++) {
      const plan = generateFloor(floor, makeSeed(floor, 21));
      for (const a of plan.anomalies) expect(EVIDENT).toContain(a.kind);
      // nothing is ever removed from the room any more
      expect(plan.hiddenSlots).toEqual([]);
    }
  });

  it('uses only unmissable object-level wrongness on the first two floors', () => {
    resetAnomalySerial();
    for (let floor = 1; floor <= 2; floor++) {
      for (let salt = 0; salt < 12; salt++) {
        const plan = generateFloor(floor, makeSeed(floor, salt));
        for (const a of plan.anomalies) expect(['intrude', 'stare']).toContain(a.kind);
      }
    }
  });

  it('always leaves real air under a shifted prop', () => {
    resetAnomalySerial();
    let checked = 0;
    for (let floor = 3; floor <= 30; floor++) {
      const plan = generateFloor(floor, makeSeed(floor, 4));
      for (const a of plan.anomalies) {
        if (a.kind !== 'shift') continue;
        checked++;
        expect(a.offset?.y ?? 0).toBeGreaterThanOrEqual(0.3);
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('always makes a warp either absurdly sized or wrongly coloured', () => {
    resetAnomalySerial();
    let checked = 0;
    for (let floor = 3; floor <= 30; floor++) {
      const plan = generateFloor(floor, makeSeed(floor, 6));
      for (const a of plan.anomalies) {
        if (a.kind !== 'warp') continue;
        checked++;
        const extremeSize = a.scale !== undefined && (a.scale <= 0.6 || a.scale >= 2);
        expect(extremeSize || a.tint !== undefined).toBe(true);
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('always makes at least three copies of a twinned prop', () => {
    resetAnomalySerial();
    let checked = 0;
    for (let floor = 5; floor <= 30; floor++) {
      const plan = generateFloor(floor, makeSeed(floor, 9));
      for (const a of plan.anomalies) {
        if (a.kind !== 'twin') continue;
        checked++;
        expect(a.count ?? 0).toBeGreaterThanOrEqual(3);
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('parks a stare at head height, facing the spawn, using a horror asset', () => {
    resetAnomalySerial();
    let checked = 0;
    for (let floor = 1; floor <= 30; floor++) {
      const plan = generateFloor(floor, makeSeed(floor, 13));
      for (const a of plan.anomalies) {
        if (a.kind !== 'stare') continue;
        checked++;
        expect(a.offset?.y ?? 0).toBeGreaterThan(1);
        expect(typeof a.rotY).toBe('number');
        expect(FOREIGN_ASSETS.find((x) => x.key === a.assetKey)?.weirdness).toBe(3);
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('offers a small, finite budget of wrong marks', () => {
    expect(MAX_MISTAKES).toBeGreaterThan(0);
    expect(MAX_MISTAKES).toBeLessThanOrEqual(5);
  });
});

describe('marking', () => {
  it('scores a correct mark', () => {
    resetAnomalySerial();
    const plan = generateFloor(2, makeSeed(2, 8));
    const target = plan.anomalies[0];
    const outcome = judgeMark(plan, target.slotId, []);
    expect(outcome.result).toBe('hit');
    expect(outcome.anomaly?.id).toBe(target.id);
  });

  it('rejects a slot with nothing wrong with it', () => {
    resetAnomalySerial();
    const plan = generateFloor(2, makeSeed(2, 8));
    const clean = SLOTS.find((s) => !plan.anomalies.some((a) => a.slotId === s.id));
    expect(clean).toBeDefined();
    expect(judgeMark(plan, clean!.id, []).result).toBe('miss');
  });

  it('does not pay twice for the same anomaly', () => {
    resetAnomalySerial();
    const plan = generateFloor(2, makeSeed(2, 8));
    const target = plan.anomalies[0];
    expect(judgeMark(plan, target.slotId, [target.id]).result).toBe('repeat');
  });
});

describe('scoring', () => {
  it('pays a speed bonus that never exceeds the cap', () => {
    const fast = hitScore(240, 240);
    const slow = hitScore(0, 240);
    expect(fast).toBe(SCORE.hit + SCORE.speedBonusMax);
    expect(slow).toBe(SCORE.hit);
    expect(hitScore(9999, 240)).toBeLessThanOrEqual(SCORE.hit + SCORE.speedBonusMax);
  });

  it('penalises misses on the floor bonus', () => {
    expect(floorClearScore(3, 60, 2)).toBeLessThan(floorClearScore(3, 60, 0));
  });

  it('formats the clock', () => {
    expect(formatClock(240)).toBe('04:00');
    expect(formatClock(59.2)).toBe('01:00');
    expect(formatClock(-5)).toBe('00:00');
  });
});
