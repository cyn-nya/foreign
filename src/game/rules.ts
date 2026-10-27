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

import { FOREIGN_ASSETS, INTRUDE_ANCHORS, ROOM, SLOTS, SLOTS_BY_ID, SPAWN, type ForeignAsset } from './catalog';
import type {
  Anomaly,
  AnomalyKind,
  Bystander,
  FloorPlan,
  MarkResult,
  PropKind,
  RNG,
  SlotDef,
  Vec3,
} from './types';

/**
 * Wrong marks allowed before the run ends. The timer alone was not tense
 * enough: with no cost to spamming the mark button, the optimal play was to
 * click everything.
 */
export const MAX_MISTAKES = 3;

/**
 * The floor that ends the run.
 *
 * The game was endless: every cleared floor started the next one, so the only
 * ending was running out of marks or time. A horror game with no way out is not
 * a game with a goal, it is a treadmill, and the player never finds out whether
 * they were good at it. Clearing this floor wins.
 *
 * Eight is where the difficulty stops rising — floor 8 is the last one that is
 * harder than the one before it (114 s, six anomalies), so the run ends at the
 * top of the curve rather than on an arbitrary number.
 */
export const FINAL_FLOOR = 8;

/** True when clearing this floor ends the run in the player's favour. */
export function isFinalFloor(floor: number): boolean {
  return floor >= FINAL_FLOOR;
}

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
/**
 * The floor from which a stare is a figure rather than a floating household object.
 *
 * Floors one to three are where the game is learnt, and a chair in mid-air is the most
 * legible possible statement of what is wrong. Later floors can afford to be less
 * legible, and the ghost models were generated for precisely this kind -- a shape that
 * hangs and faces you. Before this they were unreachable in the reconstructed room: the
 * `stare` builder was pinned to household geometry there, so four generated models could
 * never appear in the build that ships.
 */
export const GHOST_FROM_FLOOR = 4;

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
/**
 * Kinds that only make sense for an object placed into the room.
 *
 * They are defined in terms of the placed object — its attitude, and how many
 * copies of it are scattered — and there is no furniture equivalent wired up.
 * Listing them here rather than leaving them in the shared pool matters: the
 * procedural room would otherwise roll them, fall through to the default branch
 * of its builder, and quietly produce an ordinary-looking prop labelled as
 * something it is not.
 */
const FOREIGN_ONLY_KINDS: ReadonlySet<AnomalyKind> = new Set<AnomalyKind>(['invert', 'swarm']);

function allowedKinds(budget: number, foreignOnly = false): AnomalyKind[] {
  const all: AnomalyKind[] =
    budget <= 0
      ? ['intrude', 'intrude', 'stare']
      : budget === 1
        ? ['intrude', 'stare', 'stare', 'warp', 'shift', 'invert']
        : ['intrude', 'stare', 'warp', 'shift', 'twin', 'twin', 'invert', 'swarm'];
  if (foreignOnly) {
    // 'intrude' cannot survive a room that also contains bystanders.
    //
    // It means "an object that should not be here", which is a claim about what
    // the object *is*. A bystander is an object of exactly the same kind standing
    // in exactly the same sort of place, so once both exist the two are
    // indistinguishable and marking either one is a coin flip. Every other kind
    // is a claim about what the object *does* — it watches, it moved, it is
    // duplicated, it is the wrong size, it is upside down — and those survive
    // having innocent company, because innocence does nothing.
    //
    // Dropping it also resolves it: the player's question stops being "does this
    // belong?" (unanswerable, and what the playtest complained about) and becomes
    // "is this one behaving?" (answerable from the frame alone, which is the rule
    // the rest of this file is built on).
    // 'intrude' is back, and it is answerable now.
    //
    // It could not survive a room whose innocent objects were drawn from the same
    // generated catalogue: a bystander and an intruder were then the same picture,
    // and marking either was a coin flip. The fix was not to drop the kind but to
    // change what innocence looks like — bystanders are household furniture now,
    // so "this thing is not furniture" is a claim the frame can actually settle.
    // It is also the one kind the player can judge with no reference point at all,
    // which makes it the right thing to teach first.
    return all;
  }
  const shared = all.filter((kind) => !FOREIGN_ONLY_KINDS.has(kind));
  // A floor with no kinds left would produce nothing at all.
  return shared.length > 0 ? shared : ['intrude'];
}

/**
 * The household objects the room is furnished with.
 *
 * These are the room's *normal*. Everything the player is asked to judge is
 * judged against them, so they have to be things nobody would look at twice: a
 * plant, a bin, a chair, a lamp. They come from the procedural furniture library
 * rather than the generated catalogue, because the generated catalogue is all
 * horror — and while the innocent objects were drawn from it too, a bystander and
 * an intruder were the same picture and "does this belong" had no answer.
 *
 * Sizes are real furniture sizes in metres. A household object at the wrong size
 * would be an anomaly by accident.
 */
/**
 * The horror pool — weirdness 3, nothing here belongs in a home.
 *
 * Still used by the procedural room, which has no household furniture to contrast
 * against and so still tells its anomalies apart by what they are.
 */
function horrorAssets(): ForeignAsset[] {
  return FOREIGN_ASSETS.filter((a) => a.weirdness === 3);
}

/**
 * What a staring anomaly is made of.
 *
 * The ghost role exists for this kind: something suspended, still, and facing the way in.
 * A giant eye hanging at head height is strange, but it is not the thing that watches you,
 * and the four models generated to be that thing were being picked a quarter as often as
 * they should have been.
 */
function hangableHorror(): ForeignAsset[] {
  const ghosts = horrorAssets().filter((a) => a.horrorTag === 'ghost');
  return ghosts.length > 0 ? ghosts : horrorAssets();
}

function householdAssets(): ForeignAsset[] {
  return FOREIGN_ASSETS.filter((a) => a.weirdness === 0);
}

/**
 * The smallest household object that is fair to hide.
 *
 * The catalogue contains a 0.07 m key bowl, a 0.2 m kettle and a 0.3 m microwave. The
 * first floor pins its single anomaly to the one spot nearest the way in and expects the
 * player to notice it from across the room; at head height in a dark reconstruction,
 * rendered at 0.40x, none of those three is noticeable. A player reported walking almost
 * the whole floor and finding nothing, which is this constant missing.
 */
const MIN_VISIBLE_HEIGHT = 0.6;

/**
 * The shortest object that still reads as an object when it is hung in mid-air.
 *
 * A stare anomaly floats at 1.15-1.85 m facing the door. Anything flat -- `stain` is 5 cm
 * -- becomes a line seen edge-on and is invisible from the floor, so the floor's anomaly
 * cannot be found at all. `search:time` reported exactly that: `stance=none ray=[]`.
 *
 * Lower than `MIN_VISIBLE_HEIGHT` because the two are different questions: that one asks
 * whether a piece of furniture is too small to notice at all, this one asks whether an
 * object has enough vertical extent to have a silhouette in the air.
 */
const STARE_MIN_HEIGHT = 0.35;

/** Anomaly assets with enough height to hang. Falls back to all if a pass finds none. */
/**
 * The generated models built for one horror role, or everything if none were.
 *
 * The fallback matters: a catalogue whose horror entries predate the tags, or one where a
 * role was never generated, has to keep working. Returning an empty pool instead would make
 * `pick` fail or hand out `undefined`, which is how a missing tag turns into a crash rather
 * than into the plainer model it should be.
 */
function taggedHorrorPool(tag: string, budget: number): ForeignAsset[] {
  const pool = foreignPool(budget);
  const tagged = pool.filter((a) => a.horrorTag === tag);
  return tagged.length > 0 ? tagged : pool;
}

function hangableAssets(): ForeignAsset[] {
  // The ghost role first: the models generated to hang and face the way in. Then the height
  // filter, because a hanging object thinner than a hand is invisible edge-on from the
  // floor -- which is how floor one once came to hold an anomaly nobody could find.
  const all = hangableHorror();
  const tall = all.filter((a) => (a.height ?? 0) >= STARE_MIN_HEIGHT);
  return tall.length > 0 ? tall : all;
}

/** A household object big enough to be found, as an anomaly payload. */
function mundanePayload(rng: RNG): { key: string; name: string } {
  const all = householdAssets();
  const large = all.filter((a) => (a.height ?? 0) >= MIN_VISIBLE_HEIGHT);
  // Fall back rather than return nothing: a floor with no anomaly is worse than a floor
  // with a small one, because it cannot be cleared at all.
  const pool = large.length > 0 ? large : all;
  const item = pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))];
  return { key: item.key, name: item.name };
}

/** Colours that read as wrong on a household object. */
const WRONG_TINTS = [0x8b0f14, 0x1f3a20, 0x4a4a52, 0x120b0b, 0xd9d2c4];

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

/**
 * A place a foreign object can be put.
 *
 * The procedural room names its spaces, so its anchors carry a `zone`. A
 * reconstruction has no room labels — nobody ever told the scanner which part
 * was the kitchen — so its anchors carry a `place` phrase instead, and the
 * anchors themselves are measured out of the scan by `tools/build-anchors.mjs`.
 */
export interface AnchorDef {
  id: string;
  /** Base of the object. `y` is the floor at that spot, which is not level. */
  pos: Vec3;
  zone?: SlotDef['zone'];
  place?: string;
}

function placeOf(anchor: AnchorDef): string {
  if (anchor.place) return anchor.place;
  if (anchor.zone) return zoneName(anchor.zone);
  return '房间里';
}

function buildIntrude(
  rng: RNG,
  budget: number,
  usedAnchors: Set<string>,
  anchors: readonly AnchorDef[],
): Anomaly | null {
  const free = anchors.filter((a) => !usedAnchors.has(a.id));
  if (free.length === 0) return null;
  const anchor = pick(rng, free);
  usedAnchors.add(anchor.id);

  // The one kind that is a presence rather than a behaviour, so it draws from the dressed
  // figures and the objects that should not be objects -- not from the household pool,
  // which is what every other kind is built from.
  const asset = pick(rng, taggedHorrorPool('doppel', budget));

  return {
    id: nextId('intrude', anchor.id),
    kind: 'intrude',
    slotId: anchor.id,
    assetKey: asset.key,
    // deterministic, seeded: the same floor must always look the same
    rotY: rng() * Math.PI * 2,
    label: `${placeOf(anchor)}出现了一个${asset.name}`,
  };
}

/** Which assets a floor is allowed to draw from, by how strange it may get. */
function foreignPool(budget: number): ForeignAsset[] {
  // Household props are excluded. This is the intruder's pool, and an intruder
  // that was household furniture would collapse the split the game rests on.
  const generated = FOREIGN_ASSETS.filter((a) => a.weirdness > 0);
  if (budget <= 0) return generated.filter((a) => a.weirdness === 1);
  if (budget === 1) return generated.filter((a) => a.weirdness <= 2);
  return generated;
}

/**
 * Something hanging in the air at head height, turned to face the way in.
 * This is the kind that replaced 'vanish': it is impossible to miss and
 * impossible to argue with, and it needs no memory of the room.
 */
function buildStare(
  rng: RNG,
  usedAnchors: Set<string>,
  anchors: readonly AnchorDef[],
  spawn: Vec3,
  /** Pin it to one anchor — floor 1 needs the spot nearest the way in. */
  pinned?: AnchorDef,
  /**
   * Build it from household geometry instead of a generated asset.
   *
   * Only the reconstruction passes this. The procedural room places its
   * anomalies by asset key, so a household prop handed to it would render as
   * nothing at all — and a floor that is quietly empty is worse than one that is
   * ugly.
   */
  mundane = false,
): Anomaly | null {
  const free = pinned ? [pinned] : anchors.filter((a) => !usedAnchors.has(a.id));
  if (free.length === 0) return null;
  const anchor = pinned ?? pick(rng, free);
  usedAnchors.add(anchor.id);

  // In the reconstruction this is a household chair, floating at head height,
  // turned to face the way in — and that is the point. A chair hanging in the air
  // and tracking you is far worse than a face, because the face was never going
  // to be innocent and the chair was.
  const asset = mundane ? mundanePayload(rng) : pick(rng, hangableAssets());
  const height = 1.15 + rng() * 0.7;
  const dx = spawn.x - anchor.pos.x;
  const dz = spawn.z - anchor.pos.z;

  return {
    id: nextId('stare', anchor.id),
    kind: 'stare',
    slotId: anchor.id,
    assetKey: asset.key,
    offset: { x: 0, y: height, z: 0 },
    // atan2(dx, dz) points the prop's +z axis back at the way in
    rotY: Math.atan2(dx, dz),
    label: `${placeOf(anchor)}半空浮着一个${asset.name}，正对着门口`,
  };
}

function zoneName(zone: SlotDef['zone']): string {
  return { living: '客厅', kitchen: '厨房', bedroom: '卧室', hall: '玄关' }[zone];
}

/** What to call each prop when the player has just marked the wrong one. */
const PROP_NAMES: Record<PropKind, string> = {
  sofa: '沙发', coffee_table: '茶几', tv_stand: '电视柜', tv: '电视', rug: '地毯',
  floor_lamp: '落地灯', bookshelf: '书架', armchair: '扶手椅', plant: '盆栽',
  wall_art: '挂画', side_table: '边桌', ceiling_light: '吊灯', counter: '台面',
  sink: '水槽', stove: '灶台', fridge: '冰箱', upper_cabinet: '吊柜',
  dining_table: '餐桌', dining_chair: '餐椅', kettle: '水壶', microwave: '微波炉',
  trash_bin: '垃圾桶', bed: '床', nightstand: '床头柜', table_lamp: '台灯',
  wardrobe: '衣柜', desk: '书桌', desk_chair: '书桌椅', mirror: '镜子',
  shoe_rack: '鞋架', doormat: '门垫', coat_hook: '衣帽钩',
  umbrella_stand: '伞架', key_bowl: '钥匙碗',
  duck: '橡皮鸭', gnome: '花园地精', cone: '路锥', shark: '鲨鱼',
  horse: '马', washer: '洗衣机', vending: '自动售货机',
  astronaut: '宇航员', flamingo: '火烈鸟', toilet: '马桶', cactus: '仙人掌',
  eye: '眼球', mannequin: '人台', milk: '牛奶盒', piano: '钢琴',
  face: '人脸', figure: '人影', hand: '手', doll: '玩偶', teeth: '牙', stain: '污渍',
};

/**
 * Why the thing you just marked was ordinary.
 *
 * The playtest note was that the game kept saying "mark what does not belong"
 * without ever saying how to tell. A miss is the one moment the player is
 * certainly paying attention, so it is where the answer belongs: name the object
 * they marked, then name the two tests every anomaly in this room passes and that
 * object does not. "Wrong" on its own teaches nothing, and an unexplained rule is
 * the thing that was actually complained about.
 */
export function explainMiss(plan: FloorPlan, slotId: string | null): string {
  if (!slotId) return '那里什么都没有';

  const bystander = plan.bystanders.find((b) => b.slotId === slotId);
  if (bystander) return bystander.label;

  // A slot the plan knows about but did not fill: still worth saying which test
  // it failed, rather than falling back to a shrug.
  const anchor = INTRUDE_ANCHORS.find((a) => a.id === slotId);
  if (anchor) return `${placeOf(anchor)}这个东西 —— 待在原位，也没在看你`;

  const slot = SLOTS_BY_ID.get(slotId);
  if (slot) return `${zoneName(slot.zone)}的${PROP_NAMES[slot.kind] ?? '这个东西'} —— 待在原位，也没在看你`;

  return '这个属于这个房间';
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

/**
 * The kinds that are about *where* something is rather than that it exists,
 * built at an anchor instead of on a furniture slot.
 *
 * In a reconstruction this is the only way they can work: the furniture is
 * baked into the scan, so there is nothing to lift, resize or duplicate. What
 * can be lifted, resized or duplicated is the object placed into the room — so
 * all five kinds end up operating on the same thing, which is also easier to
 * read as a player: every anomaly is about an object that does not belong.
 */
function buildForeignAnomaly(rng: RNG, anchor: AnchorDef, kind: AnomalyKind): Anomaly {
  // A household object doing something a household object does not do.
  //
  // Every kind except 'intrude' is a claim about behaviour, and behaviour is only
  // legible against something ordinary. A chair hanging upside down in a room of
  // chairs is a judgement; the same chair among giant eyes is just more weirdness.
  const payload = mundanePayload(rng);
  const asset = { key: payload.key, name: payload.name };
  const base = {
    id: nextId(kind, anchor.id),
    kind,
    slotId: anchor.id,
    assetKey: asset.key,
    rotY: rng() * Math.PI * 2,
  } as Anomaly;

  switch (kind) {
    case 'shift': {
      // Either adrift, or pinned up near the ceiling. Both are unmistakable
      // without any memory of where the object used to be.
      const pinned = rng() < 0.35;
      base.offset = {
        x: (rng() - 0.5) * 0.8,
        y: pinned ? 1.95 + rng() * 0.25 : 0.55 + rng() * 1.1,
        z: (rng() - 0.5) * 0.8,
      };
      base.label = pinned
        ? `${placeOf(anchor)}的天花板上粘着一个${asset.name}`
        : `${placeOf(anchor)}有个${asset.name}浮在半空`;
      break;
    }
    case 'warp': {
      if (rng() < 0.5) {
        const huge = rng() < 0.5;
        base.scale = huge ? 2.1 + rng() * 1.2 : 0.32 + rng() * 0.16;
        base.label = huge
          ? `${placeOf(anchor)}有个${asset.name}大得离谱`
          : `${placeOf(anchor)}有个${asset.name}小得离谱`;
      } else {
        base.tint = pick(rng, WRONG_TINTS);
        base.label = `${placeOf(anchor)}有个${asset.name}的颜色完全不对劲`;
      }
      break;
    }
    case 'twin': {
      base.count = 3 + Math.floor(rng() * 3);
      base.label = `${placeOf(anchor)}的同一个${asset.name}出现了 ${base.count} 个`;
      break;
    }
    case 'invert': {
      // Just off the ground, so it is plainly not standing on its head — it is
      // hanging, wrong way up, where nothing is holding it.
      base.flip = true;
      base.offset = { x: 0, y: 0.15 + rng() * 0.35, z: 0 };
      base.rotY = rng() * Math.PI * 2;
      base.label = `${placeOf(anchor)}有个${asset.name}倒挂着`;
      break;
    }
    case 'swarm': {
      // Past the point of counting. Shrunk so the group reads as a swarm of one
      // thing rather than a solid mass of intersecting geometry.
      base.count = 12 + Math.floor(rng() * 7);
      base.spread = 1.1 + rng() * 0.7;
      base.scale = 0.4 + rng() * 0.2;
      base.offset = { x: 0, y: 0.5 + rng() * 0.9, z: 0 };
      base.label = `${placeOf(anchor)}有一群${asset.name}，数不清有多少个`;
      break;
    }
    default:
      base.label = `${placeOf(anchor)}有东西不对劲`;
  }
  return base;
}

/** Consume a free anchor and build a non-object anomaly there. */
function buildForeignAtAnchor(
  rng: RNG,
  usedAnchors: Set<string>,
  anchors: readonly AnchorDef[],
  kind: AnomalyKind,
): Anomaly | null {
  const free = anchors.filter((a) => !usedAnchors.has(a.id));
  if (free.length === 0) return null;
  const anchor = pick(rng, free);
  usedAnchors.add(anchor.id);
  return buildForeignAnomaly(rng, anchor, kind);
}

/* ------------------------------------------------------------------ *
 * Floor generation
 * ------------------------------------------------------------------ */

export interface GenerateOptions {
  /** Force a specific mix of kinds — used by tests. */
  kinds?: AnomalyKind[];
  /** Where foreign objects may be placed. Defaults to the procedural room's. */
  anchors?: readonly AnchorDef[];
  /** The way in, which 'stare' turns to face. Defaults to the procedural room's. */
  spawn?: Vec3;
  /**
   * The room is a fixed reconstruction: its furniture is baked into the scan and
   * cannot be moved, duplicated or hidden. So every anomaly is one of the objects
   * placed into it, and all five kinds are built at an anchor.
   */
  foreignOnly?: boolean;
}

export function generateFloor(floor: number, seed: number, opts: GenerateOptions = {}): FloorPlan {
  const rng = mulberry32(seed);
  const budget = subtletyBudget(floor);
  const count = Math.max(1, Math.min(6, opts.kinds?.length ?? anomalyCountForFloor(floor)));

  const anchors = opts.anchors ?? INTRUDE_ANCHORS;
  const spawn = opts.spawn ?? SPAWN.pos;
  const foreignOnly = opts.foreignOnly === true;

  const anomalies: Anomaly[] = [];
  const usedAnchors = new Set<string>();
  const usedSlots = new Set<string>();
  const hiddenSlots: string[] = [];
  const twinSlots: string[] = [];

  // Floor 1 is scripted: one unmissable intruder right on the walking path.
  if (floor === 1 && !opts.kinds) {
    // In the procedural room that means a named spot; in a reconstruction there
    // are no names, so it means whichever anchor is nearest the way in — which
    // is the one the player is already facing.
    const anchor = foreignOnly
      ? anchors.reduce((best, a) =>
          distance2d(a.pos, spawn) < distance2d(best.pos, spawn) ? a : best, anchors[0])
      : anchors.reduce((best, a) =>
          a.zone === 'living' && a.id === 'fx_living_centre' ? a : best, anchors[0]);
    const asset = FOREIGN_ASSETS.find((a) => a.key === 'duck') ?? FOREIGN_ASSETS[0];
    // In a reconstruction the scripted first anomaly is a 'stare': it is the one
    // kind that needs no reference point at all, which is what a first floor
    // should teach. It cannot be an 'intrude' any more — see allowedKinds — and
    // building it through the real builder rather than by hand is what keeps it
    // airborne, facing the way in, and labelled like every other stare.
    const first = foreignOnly
      ? buildStare(rng, usedAnchors, anchors, spawn, anchor, floor < GHOST_FROM_FLOOR)
      : null;
    anomalies.push(
      first ?? {
        id: nextId('intrude', anchor.id),
        kind: 'intrude',
        slotId: anchor.id,
        assetKey: asset.key,
        rotY: 0,
        label: `${placeOf(anchor)}有一只不该在这里的${asset.name}`,
      },
    );
    usedAnchors.add(anchor.id);
    const firstFloorBystanders = foreignOnly
      ? buildBystanders(rng, anchors, usedAnchors, floor, 1)
      : [];
    return {
      floor,
      seed,
      anomalies,
      bystanders: firstFloorBystanders,
      hiddenSlots,
      twinSlots,
      duration: durationForFloor(floor),
    };
  }

  const requested = opts.kinds ? opts.kinds.slice() : null;
  const kinds = allowedKinds(budget, foreignOnly);

  // In a reconstruction there is no furniture to move, duplicate or hide, so
  // every kind is built on an anchor and the slot pools simply do not apply.
  if (foreignOnly) {
    for (let i = 0; i < count; i++) {
      const forced = requested ? requested[i % requested.length] : null;
      const kind = forced ?? pick(rng, kinds);
      const built = kind === 'stare'
        ? buildStare(rng, usedAnchors, anchors, spawn, undefined, floor < GHOST_FROM_FLOOR)
        : kind === 'intrude'
          ? buildIntrude(rng, budget, usedAnchors, anchors)
          : buildForeignAtAnchor(rng, usedAnchors, anchors, kind);
      // Running out of anchors ends the floor rather than repeating a place:
      // two anomalies at one spot read as one anomaly.
      if (!built) break;
      anomalies.push(built);
    }
    return {
      floor,
      seed,
      anomalies,
      bystanders: buildBystanders(rng, anchors, usedAnchors, floor, count),
      hiddenSlots,
      twinSlots,
      duration: durationForFloor(floor),
    };
  }

  // Candidate pools, ordered loud-first so early floors read clearly.
  const slotPool = shuffle(rng, budget <= 0 ? loudSlots() : mutableSlots());

  for (let i = 0; i < count; i++) {
    const forced = requested ? requested[i % requested.length] : null;
    const kind = forced ?? pick(rng, kinds);

    if (kind === 'intrude' || kind === 'stare') {
      const spawned = kind === 'stare'
        ? buildStare(rng, usedAnchors, anchors, spawn)
        : buildIntrude(rng, budget, usedAnchors, anchors);
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
    // The procedural room supplies its own furniture, so it needs no bystanders.
    bystanders: [],
    hiddenSlots,
    twinSlots,
    duration: durationForFloor(floor),
  };
}

/**
 * Ordinary objects for the reconstruction, one per free anchor.
 *
 * One bystander per anomaly, so the room is roughly half innocent: enough that
 * seeing a crisp 3D object is not by itself an answer, not so many that the
 * anomalies get lost in clutter. Floor 1 gets a single one, because teaching the
 * distinction is the point of that floor and two things to compare is enough.
 *
 * Household furniture, standing still. Not drawn from the generated catalogue:
 * that was the earlier design and it made the game unanswerable, because a
 * bystander and an intruder were then the same absurd object and "does this
 * belong?" had no truth to it. A room furnished with ordinary things is what
 * gives "this does not belong" a meaning — and it is also what makes an object
 * behaving impossibly legible, since the thing misbehaving is plainly innocent.
 */
function buildBystanders(
  rng: RNG,
  anchors: readonly AnchorDef[],
  usedAnchors: ReadonlySet<string>,
  floor: number,
  anomalyCount: number,
): Bystander[] {
  const wanted = Math.max(1, Math.min(4, floor === 1 ? 1 : anomalyCount));
  const free = anchors.filter((a) => !usedAnchors.has(a.id));
  const chosen = shuffle(rng, free).slice(0, wanted);

  return chosen.map((anchor) => {
    const payload = mundanePayload(rng);
    return {
      slotId: anchor.id,
      assetKey: payload.key,
      label: `${placeOf(anchor)}这个${payload.name} —— 待在原位，也没在看你`,
    };
  });
}

function distance2d(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
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
