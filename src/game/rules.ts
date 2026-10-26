/**
 * Pure game rules — no three.js, no DOM. Fully unit-testable.
 *
 * Design note: floor 1 always has exactly one screamingly obvious anomaly.
 * It teaches the player the room and the verb ("mark the thing that is wrong").
 * Difficulty then ramps on two axes: how many anomalies, and how subtle they are.
 */

import { FOREIGN_ASSETS, INTRUDE_ANCHORS, SLOTS, type ForeignAsset } from './catalog';
import type { Anomaly, AnomalyKind, FloorPlan, MarkResult, RNG, SlotDef } from './types';

/* ------------------------------------------------------------------ *
 * Deterministic RNG (mulberry32) — same seed, same floor, always.
 * ------------------------------------------------------------------ */

export function mulberry32(seed: number): RNG {
  let a = seed >>> 0;
  return function rng(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeSeed(floor: number, salt = 0): number {
  // Cheap avalanche so consecutive floors look unrelated.
  let h = 0x9e3779b9 ^ (floor * 0x85ebca6b) ^ (salt * 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}

function pick<T>(rng: RNG, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length) % arr.length];
}

function shuffle<T>(rng: RNG, arr: readonly T[]): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Difficulty curve
 * ------------------------------------------------------------------ */

/** Anomalies on a given floor. Floor 1 = 1, then a slow ramp, cap 6. */
export function anomalyCountForFloor(floor: number): number {
  if (floor <= 1) return 1;
  if (floor <= 3) return floor - 1 + 1; // 2, 3
  return Math.min(6, 2 + Math.floor((floor - 2) * 0.8));
}

/** Seconds allowed. Generous early, then tight. */
export function durationForFloor(floor: number): number {
  const t = 240 - (floor - 1) * 18;
  return Math.max(105, t);
}

/** How subtle the anomaly mix is allowed to get. */
function subtletyBudget(floor: number): number {
  // 0 = only loud anomalies, 3 = anything goes
  return Math.min(3, Math.floor((floor - 1) / 2));
}

/* ------------------------------------------------------------------ *
 * Anomaly construction
 * ------------------------------------------------------------------ */

const LOUD_KINDS: AnomalyKind[] = ['intrude', 'vanish', 'shift', 'warp', 'twin'];

let anomalySerial = 0;
function nextId(kind: AnomalyKind, slotId: string): string {
  anomalySerial += 1;
  return `${kind}:${slotId}:${anomalySerial}`;
}

/** Reset the serial so tests and replays are deterministic. */
export function resetAnomalySerial(): void {
  anomalySerial = 0;
}

/** A slot can be vanished / moved / warped / duplicated. */
function mutableSlots(): SlotDef[] {
  return SLOTS.filter((s) => !s.anchored);
}

function loudSlots(): SlotDef[] {
  return mutableSlots().filter((s) => !s.subtle);
}

function buildIntrude(rng: RNG, budget: number, usedAnchors: Set<string>): Anomaly | null {
  const anchors = INTRUDE_ANCHORS.filter((a) => !usedAnchors.has(a.id));
  if (anchors.length === 0) return null;
  const anchor = pick(rng, anchors);
  usedAnchors.add(anchor.id);

  const pool: ForeignAsset[] = budget <= 0
    ? FOREIGN_ASSETS.filter((a) => a.weirdness === 1)
    : budget === 1
      ? FOREIGN_ASSETS.filter((a) => a.weirdness <= 2)
      : FOREIGN_ASSETS;
  const asset = pick(rng, pool);

  return {
    id: nextId('intrude', anchor.id),
    kind: 'intrude',
    slotId: anchor.id,
    assetKey: asset.key,
    label: `${zoneName(anchor.zone)}出现了一个${asset.name}`,
  };
}

function zoneName(zone: SlotDef['zone']): string {
  return { living: '客厅', kitchen: '厨房', bedroom: '卧室', hall: '玄关' }[zone];
}

function buildSlotAnomaly(
  rng: RNG,
  slot: SlotDef,
  budget: number,
  forcedKind?: AnomalyKind,
): Anomaly {
  const kinds: AnomalyKind[] = budget <= 0 ? ['vanish', 'shift', 'twin'] : LOUD_KINDS;
  // 'intrude' is handled separately; never picked here.
  const usable = kinds.filter((k) => k !== 'intrude');
  const kind: AnomalyKind = forcedKind && forcedKind !== 'intrude' ? forcedKind : pick(rng, usable);
  const base = { id: nextId(kind, slot.id), kind, slotId: slot.id } as Anomaly;

  switch (kind) {
    case 'vanish':
      base.label = `${zoneName(slot.zone)}少了一件东西（${slot.id}）`;
      break;
    case 'shift': {
      const ang = rng() * Math.PI * 2;
      const dist = 0.5 + rng() * 1.1;
      const lift = rng() < 0.34 ? 0.35 + rng() * 1.1 : 0;
      base.offset = { x: Math.cos(ang) * dist, y: lift, z: Math.sin(ang) * dist };
      base.rotY = (rng() - 0.5) * 1.6;
      base.label = lift > 0
        ? `有东西浮在半空（${slot.id}）`
        : `有东西被挪到了别处（${slot.id}）`;
      break;
    }
    case 'warp': {
      // either a size warp or a colour warp, never both — clearer read
      if (rng() < 0.5) {
        base.scale = rng() < 0.5 ? 0.45 + rng() * 0.2 : 1.7 + rng() * 0.9;
        base.label = `有东西的尺寸不对（${slot.id}）`;
      } else {
        base.tint = [0xff2d55, 0x00e5ff, 0xb14cff, 0x00ff6a, 0xff8a00][Math.floor(rng() * 5)];
        base.label = `有东西的颜色不对劲（${slot.id}）`;
      }
      break;
    }
    case 'twin':
      base.offset = { x: (rng() - 0.5) * 1.2, y: 0, z: (rng() - 0.5) * 1.2 };
      base.rotY = (rng() - 0.5) * Math.PI;
      base.label = `有东西被复制了一份（${slot.id}）`;
      break;
    default:
      base.label = `有东西不对劲（${slot.id}）`;
  }
  return base;
}

/* ------------------------------------------------------------------ *
 * Floor generation
 * ------------------------------------------------------------------ */

export interface GenerateOptions {
  /** Force a specific mix of kinds — used by tests. */
  kinds?: AnomalyKind[];
}

export function generateFloor(floor: number, seed: number, opts: GenerateOptions = {}): FloorPlan {
  const rng = mulberry32(seed);
  const budget = subtletyBudget(floor);
  const count = Math.max(1, Math.min(6, opts.kinds?.length ?? anomalyCountForFloor(floor)));

  const anomalies: Anomaly[] = [];
  const usedAnchors = new Set<string>();
  const usedSlots = new Set<string>();
  const hiddenSlots: string[] = [];
  const twinSlots: string[] = [];

  // Floor 1 is scripted: one unmissable intruder right on the walking path.
  if (floor === 1 && !opts.kinds) {
    const anchor = INTRUDE_ANCHORS.reduce((best, a) =>
      a.zone === 'living' && a.id === 'fx_living_centre' ? a : best, INTRUDE_ANCHORS[0]);
    const asset = FOREIGN_ASSETS.find((a) => a.key === 'duck') ?? FOREIGN_ASSETS[0];
    anomalies.push({
      id: nextId('intrude', anchor.id),
      kind: 'intrude',
      slotId: anchor.id,
      assetKey: asset.key,
      label: `客厅里有一只不该在这里的${asset.name}`,
    });
    usedAnchors.add(anchor.id);
    return { floor, seed, anomalies, hiddenSlots, twinSlots, duration: durationForFloor(floor) };
  }

  const requested = opts.kinds ? opts.kinds.slice() : null;

  // Candidate pools, ordered loud-first so early floors read clearly.
  const slotPool = shuffle(rng, budget <= 0 ? loudSlots() : mutableSlots());

  for (let i = 0; i < count; i++) {
    const forced = requested ? requested[i % requested.length] : null;
    if (forced === 'intrude' || (!forced && rng() < 0.42 && usedAnchors.size < INTRUDE_ANCHORS.length)) {
      const intrusion = buildIntrude(rng, budget, usedAnchors);
      if (intrusion) {
        anomalies.push(intrusion);
        continue;
      }
    }

    const slot = slotPool.find((s) => !usedSlots.has(s.id));
    if (!slot) break;
    usedSlots.add(slot.id);

    const anomaly = buildSlotAnomaly(rng, slot, budget, forced ?? undefined);
    if (anomaly.kind === 'vanish') hiddenSlots.push(slot.id);
    if (anomaly.kind === 'twin') twinSlots.push(slot.id);
    anomalies.push(anomaly);
  }

  return {
    floor,
    seed,
    anomalies,
    hiddenSlots,
    twinSlots,
    duration: durationForFloor(floor),
  };
}

/* ------------------------------------------------------------------ *
 * Session state machine + scoring
 * ------------------------------------------------------------------ */

export interface MarkOutcome {
  result: MarkResult;
  anomaly?: Anomaly;
}

export function judgeMark(plan: FloorPlan, slotId: string, alreadyFound: readonly string[]): MarkOutcome {
  const hit = plan.anomalies.find((a) => a.slotId === slotId);
  if (!hit) return { result: 'miss' };
  if (alreadyFound.includes(hit.id)) return { result: 'repeat', anomaly: hit };
  return { result: 'hit', anomaly: hit };
}

export const SCORE = {
  hit: 100,
  /** Bonus for marks made with plenty of time left. */
  speedBonusMax: 60,
  miss: -40,
  floorClear: 250,
} as const;

export function hitScore(secondsLeft: number, duration: number): number {
  const ratio = Math.max(0, Math.min(1, secondsLeft / duration));
  return SCORE.hit + Math.round(SCORE.speedBonusMax * ratio);
}

export function floorClearScore(floor: number, secondsLeft: number, misses: number): number {
  const timeBonus = Math.round(secondsLeft * 3);
  // SCORE.miss is negative, so adding it here subtracts per miss.
  return Math.max(0, SCORE.floorClear + floor * 50 + timeBonus + misses * SCORE.miss);
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
