/**
 * Pure game rules — no three.js, no DOM. Fully unit-testable.
 *
 * Design note: the player is never asked to remember the room. Every anomaly
 * kind this module can produce is judgeable from the frame alone — something
 * impossible is present, something is floating, something is the wrong size or
 * colour, something has been copied three or more times. An earlier 'vanish'
 * kind was removed precisely because it needed a memorised baseline, which
 * made the game a memory test rather than an observation test.
 *
 * Difficulty ramps on two axes: how many anomalies, and which kinds are in the
 * pool. Floors 1-2 only use unmistakable object-level wrongness.
 */

import { FOREIGN_ASSETS, INTRUDE_ANCHORS, ROOM, SLOTS, SPAWN, type ForeignAsset } from './catalog';
import type { Anomaly, AnomalyKind, FloorPlan, MarkResult, RNG, SlotDef } from './types';

/**
 * Wrong marks allowed before the run ends. The timer alone was not tense
 * enough: with no cost to spamming the mark button, the optimal play was to
 * click everything.
 */
export const MAX_MISTAKES = 3;

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

/**
 * Which kinds a floor may use. Repetition in these arrays is weighting.
 * Floors 1-2 get only wrongness that no one could argue with: an object that
 * cannot exist in a flat, and something watching you from head height.
 */
function allowedKinds(budget: number): AnomalyKind[] {
  if (budget <= 0) return ['intrude', 'intrude', 'stare'];
  if (budget === 1) return ['intrude', 'stare', 'stare', 'warp', 'shift'];
  return ['intrude', 'stare', 'warp', 'shift', 'twin', 'twin'];
}

/** Colours that read as wrong on a household object. */
const WRONG_TINTS = [0x8b0f14, 0x1f3a20, 0x4a4a52, 0x120b0b, 0xd9d2c4];

/** The horror pool — weirdness 3, nothing here belongs in a home. */
function horrorAssets(): ForeignAsset[] {
  return FOREIGN_ASSETS.filter((a) => a.weirdness === 3);
}

let anomalySerial = 0;
function nextId(kind: AnomalyKind, slotId: string): string {
  anomalySerial += 1;
  return `${kind}:${slotId}:${anomalySerial}`;
}

/** Reset the serial so tests and replays are deterministic. */
export function resetAnomalySerial(): void {
  anomalySerial = 0;
}

/** A slot can be moved / warped / duplicated. */
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
    // deterministic, seeded: the same floor must always look the same
    rotY: rng() * Math.PI * 2,
    label: `${zoneName(anchor.zone)}出现了一个${asset.name}`,
  };
}

/**
 * Something hanging in the air at head height, turned to face the door.
 * This is the kind that replaced 'vanish': it is impossible to miss and
 * impossible to argue with, and it needs no memory of the room.
 */
function buildStare(rng: RNG, usedAnchors: Set<string>): Anomaly | null {
  const anchors = INTRUDE_ANCHORS.filter((a) => !usedAnchors.has(a.id));
  if (anchors.length === 0) return null;
  const anchor = pick(rng, anchors);
  usedAnchors.add(anchor.id);

  const asset = pick(rng, horrorAssets());
  const height = 1.15 + rng() * 0.7;
  const dx = SPAWN.pos.x - anchor.pos.x;
  const dz = SPAWN.pos.z - anchor.pos.z;

  return {
    id: nextId('stare', anchor.id),
    kind: 'stare',
    slotId: anchor.id,
    assetKey: asset.key,
    offset: { x: 0, y: height, z: 0 },
    // atan2(dx, dz) points the prop's +z axis at the player's spawn
    rotY: Math.atan2(dx, dz),
    label: `${zoneName(anchor.zone)}半空浮着一个${asset.name}，正对着门口`,
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
  const pool = allowedKinds(budget).filter((k) => k !== 'intrude' && k !== 'stare');
  const kind: AnomalyKind = forcedKind && forcedKind !== 'intrude' && forcedKind !== 'stare'
    ? forcedKind
    : pick(rng, pool);
  const base = { id: nextId(kind, slot.id), kind, slotId: slot.id } as Anomaly;

  switch (kind) {
    case 'shift': {
      // Always obviously adrift: off the floor, or pinned to the ceiling.
      // A small lateral nudge was unreadable without a memorised baseline.
      const ang = rng() * Math.PI * 2;
      const dist = 0.4 + rng() * 1.2;
      const ceiling = rng() < 0.3;
      const lift = ceiling
        ? Math.max(0.3, ROOM.wallHeight - slot.size.y * 0.5 - slot.pos.y)
        : 0.5 + rng() * 1.2;
      base.offset = { x: Math.cos(ang) * dist, y: lift, z: Math.sin(ang) * dist };
      base.rotY = (rng() - 0.5) * Math.PI;
      base.label = ceiling
        ? `${zoneName(slot.zone)}的天花板上粘着东西`
        : `${zoneName(slot.zone)}有东西浮在半空`;
      break;
    }
    case 'warp': {
      // either absurdly resized or recoloured, never both — clearer read
      if (rng() < 0.5) {
        const huge = rng() < 0.5;
        base.scale = huge ? 2.1 + rng() * 1.2 : 0.32 + rng() * 0.16;
        base.label = huge
          ? `${zoneName(slot.zone)}有东西大得离谱`
          : `${zoneName(slot.zone)}有东西小得离谱`;
      } else {
        base.tint = pick(rng, WRONG_TINTS);
        base.label = `${zoneName(slot.zone)}有东西的颜色完全不对劲`;
      }
      break;
    }
    case 'twin': {
      // three or more copies: two could be a coincidence, five cannot
      base.count = 3 + Math.floor(rng() * 3);
      base.offset = { x: (rng() - 0.5) * 1.7, y: 0, z: (rng() - 0.5) * 1.7 };
      base.rotY = (rng() - 0.5) * Math.PI;
      base.label = `${zoneName(slot.zone)}的同一个东西出现了 ${base.count} 个`;
      break;
    }
    default:
      base.label = `${zoneName(slot.zone)}有东西不对劲`;
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
      rotY: 0,
      label: `客厅里有一只不该在这里的${asset.name}`,
    });
    usedAnchors.add(anchor.id);
    return { floor, seed, anomalies, hiddenSlots, twinSlots, duration: durationForFloor(floor) };
  }

  const requested = opts.kinds ? opts.kinds.slice() : null;
  const kinds = allowedKinds(budget);

  // Candidate pools, ordered loud-first so early floors read clearly.
  const slotPool = shuffle(rng, budget <= 0 ? loudSlots() : mutableSlots());

  for (let i = 0; i < count; i++) {
    const forced = requested ? requested[i % requested.length] : null;
    const kind = forced ?? pick(rng, kinds);

    if (kind === 'intrude' || kind === 'stare') {
      const spawned = kind === 'stare'
        ? buildStare(rng, usedAnchors)
        : buildIntrude(rng, budget, usedAnchors);
      if (spawned) {
        anomalies.push(spawned);
        continue;
      }
      // out of anchors — fall through and fill the slot with something else
    }

    const slot = slotPool.find((s) => !usedSlots.has(s.id));
    if (!slot) break;
    usedSlots.add(slot.id);

    const isObjectLevel = kind === 'intrude' || kind === 'stare';
    const anomaly = buildSlotAnomaly(rng, slot, budget, isObjectLevel ? undefined : kind);
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
