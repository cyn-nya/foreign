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
  mulberry32,
  resetAnomalySerial,
  SCORE,
} from '../src/game/rules';
import { ANCHORS_BY_ID, FOREIGN_ASSETS, SLOTS, SLOTS_BY_ID } from '../src/game/catalog';

const ANOMALY_KINDS = ['intrude', 'vanish', 'shift', 'warp', 'twin'] as const;

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
        if (a.kind === 'intrude') {
          expect(ANCHORS_BY_ID.has(a.slotId)).toBe(true);
          expect(FOREIGN_ASSETS.some((f) => f.key === a.assetKey)).toBe(true);
        } else {
          expect(SLOTS_BY_ID.has(a.slotId)).toBe(true);
          // anchored props (wall art, rugs, ceiling lights) must not be
          // vanished or teleported — they are part of the architecture
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
      if (a.kind === 'vanish') expect(plan.hiddenSlots).toContain(a.slotId);
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
