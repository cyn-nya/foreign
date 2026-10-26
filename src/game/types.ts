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
  | 'piano';

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

export type AnomalyKind =
  /** An AI-generated object that simply should not be here. */
  | 'intrude'
  /** Something that was here is gone. */
  | 'vanish'
  /** Something was moved, floated or rotated. */
  | 'shift'
  /** Something changed size, colour, or turned into something else. */
  | 'warp'
  /** Something was duplicated. */
  | 'twin';

export interface Anomaly {
  id: string;
  kind: AnomalyKind;
  /** The slot the player must mark. For 'intrude' this is a synthetic anchor id. */
  slotId: string;
  /** Only for 'intrude': which AI-generated asset to place. */
  assetKey?: string;
  /** Reveal text shown after the round. */
  label: string;
  /** Per-anomaly transform payload. */
  offset?: Vec3;
  rotY?: number;
  scale?: number;
  tint?: number;
}

export interface FloorPlan {
  floor: number;
  seed: number;
  anomalies: Anomaly[];
  /** Slots whose default prop must be hidden this floor. */
  hiddenSlots: string[];
  /** Slots rendered twice this floor. */
  twinSlots: string[];
  /** Seconds allowed. */
  duration: number;
}

export type MarkResult = 'hit' | 'miss' | 'repeat';
