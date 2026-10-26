/**
 * Core data types for FOREIGN / 异物.
 * Kept free of three.js imports so the game rules stay unit-testable in Node.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export type RNG = () => number;

/** How a prop can be turned into something that does not belong. */
export type PropKind =
  | 'sofa'
  | 'coffee_table'
  | 'tv_stand'
  | 'tv'
  | 'rug'
  | 'floor_lamp'
  | 'bookshelf'
  | 'armchair'
  | 'plant'
  | 'wall_art'
  | 'side_table'
  | 'ceiling_light'
  | 'counter'
  | 'sink'
  | 'stove'
  | 'fridge'
  | 'upper_cabinet'
  | 'dining_table'
  | 'dining_chair'
  | 'kettle'
  | 'microwave'
  | 'trash_bin'
  | 'bed'
  | 'nightstand'
  | 'table_lamp'
  | 'wardrobe'
  | 'desk'
  | 'desk_chair'
  | 'mirror'
  | 'shoe_rack'
  | 'doormat'
  | 'coat_hook'
  | 'umbrella_stand'
  | 'key_bowl'
  // --- foreign (AI-generated) placeholder silhouettes ---
  | 'duck'
  | 'gnome'
  | 'cone'
  | 'shark'
  | 'horse'
  | 'washer'
  | 'vending'
  | 'astronaut'
  | 'flamingo'
  | 'toilet'
  | 'cactus'
  | 'eye'
  | 'mannequin'
  | 'milk'
  | 'piano'
  // --- horror placeholders (weirdness 3, the 'stare' pool) ---
  | 'face'
  | 'figure'
  | 'hand'
  | 'doll'
  | 'teeth'
  | 'stain';

export interface SlotDef {
  /** Stable id — also the id the player marks. */
  id: string;
  kind: PropKind;
  /** Centre of the prop's footprint, in metres. y is the prop's base height. */
  pos: Vec3;
  /** Rotation around Y, radians. */
  rotY?: number;
  /** Footprint size (x = width, y = height, z = depth) before rotation. */
  size: Vec3;
  /** Room label, for the post-round report. */
  zone: 'living' | 'kitchen' | 'bedroom' | 'hall';
  /** Anchored props (rugs, wall art) can be warped but not moved or removed. */
  anchored?: boolean;
  /** Hard to see — excluded from the easy pool used on early floors. */
  subtle?: boolean;
}

/**
 * How a prop is wrong.
 *
 * Every kind here is designed to be judged WITHOUT comparing against the room's
 * baseline state. That is deliberate: an earlier version had a 'vanish' kind,
 * which is only detectable by remembering what used to be there — an unfair
 * memory test rather than an observation test. It was replaced by 'stare'.
 */
export type AnomalyKind =
  /** An AI-generated object that simply should not be here. */
  | 'intrude'
  /** Something is up at head height, facing you, and it was not there before. */
  | 'stare'
  /** Something floats, is upside down, or is stuck to the ceiling. */
  | 'shift'
  /** Something is grotesquely the wrong size, or the wrong colour. */
  | 'warp'
  /** Several identical copies of one household object. */
  | 'twin'
  /**
   * The object is upside down.
   *
   * Its own kind rather than a variant of 'shift', because it is neither moved
   * nor resized — it is the wrong way up where it stands, which reads as wrong
   * in a way that has nothing to do with where it is.
   */
  | 'invert'
  /**
   * A dozen or more of one object, scattered.
   *
   * Deliberately past 'twin': three copies is a joke, and past a dozen it stops
   * being countable and becomes an infestation.
   */
  | 'swarm';

export interface Anomaly {
  id: string;
  kind: AnomalyKind;
  /** The slot the player must mark. For 'intrude'/'stare' this is a synthetic anchor id. */
  slotId: string;
  /** Which AI-generated asset to place. Used by 'intrude' and by any horror prop. */
  assetKey?: string;
  /** Reveal text shown after the round. */
  label: string;
  /** Per-anomaly transform payload. */
  offset?: Vec3;
  rotY?: number;
  scale?: number;
  tint?: number;
  /** For 'twin': how many copies to place. Always 3 or more, so it reads as absurd. */
  count?: number;
  /** Rendered upside down. Only meaningful for 'invert'. */
  flip?: boolean;
  /** For 'swarm': the radius in metres its copies are scattered over. */
  spread?: number;
}

/**
 * An object that is simply there.
 *
 * Without these the game had no judgement in it at all: the reconstruction's own
 * furniture is baked into the scan, so every crisp 3D object in the room *was* an
 * anomaly, and spotting one was a visual-search task rather than a decision. A
 * playtester put it as "没有明确说明怎么样算不该出现，如何判断" — there was nothing
 * to judge.
 *
 * A bystander looks exactly like an anomaly and does nothing. That is the whole
 * point: it is what makes "is this thing wrong?" a question with an answer.
 */
export interface Bystander {
  /** The anchor it stands on — also the id the player marks. */
  slotId: string;
  /**
   * The household prop it is.
   *
   * Deliberately drawn from the household pool rather than the generated one.
   * While bystanders were the same absurd objects as the anomalies, "does this
   * belong?" had no answer — a playtester said so directly. Innocence has to look
   * ordinary for guilt to look obvious.
   */
  assetKey: string;
  /** Shown when the player marks it, so the miss teaches instead of scolding. */
  label: string;
}

export interface FloorPlan {
  floor: number;
  seed: number;
  anomalies: Anomaly[];
  /** Objects that are present and innocent. Never counted as targets. */
  bystanders: Bystander[];
  /** Slots whose default prop must be hidden this floor. */
  hiddenSlots: string[];
  /** Slots rendered twice this floor. */
  twinSlots: string[];
  /** Seconds allowed. */
  duration: number;
}

export type MarkResult = 'hit' | 'miss' | 'repeat';
