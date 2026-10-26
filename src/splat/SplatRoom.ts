/**
 * The foreign objects, placed in the reconstructed room.
 *
 * Two things here are different from the three.js room, and both follow from the
 * scan being fixed geometry:
 *
 * 1. Nothing is moved, resized or hidden — the anomalies are objects *added* to
 *    the room, so every kind ends up placing something at an anchor.
 * 2. `Object3D` has no `clone()`, so a placement cannot copy a template. The
 *    parsed GLB bytes are cached and parsed once per placement instead. These
 *    are ~30 KB single-mesh files; a floor places at most a few dozen.
 *
 * The base of each baked GLB is at y = 0 with the footprint centred on the
 * pivot, so placing one is just "put the pivot on the floor".
 */

import {
  GLTFLoader,
  Raycaster,
  Vector2,
  type Object3D,
  type PerspectiveCamera,
  type Scene3D,
  downloadTexture,
} from '@manycore/aholo-viewer';
import type { Anomaly, FloorPlan } from '../game/types.ts';
import type { AnchorDef } from '../game/rules.ts';

const { loadGLTF } = GLTFLoader;

const BASE = `${import.meta.env.BASE_URL ?? '/'}assets/foreign/`;

/** Vanilla three.js uses this refactor for a hex value into r/g/b floats. */
function tintOf(value: number): [number, number, number] {
  return [((value >> 16) & 0xff) / 255, ((value >> 8) & 0xff) / 255, (value & 0xff) / 255];
}

export interface PlacedAnomaly {
  anomaly: Anomaly;
  /** The subtree for this placement, already positioned in the room. */
  node: Object3D;
  /** The slot the player marks. Twin copies all share their anchor's id. */
  slotId: string;
  /**
   * Whether this one tracks the player.
   *
   * Chosen by kind, not by asset, because the behaviour *is* the anomaly: a
   * statue that follows you is wrong in a way no amount of looking at it
   * resolves, and it is wrong without any comparison to the room.
   */
  watches: boolean;
  /** Resting height, so the breathing animation has something to return to. */
  baseY: number;
  /** Per-instance bob offset, derived on first update from the placement. */
  phase?: number;
}

export interface AssetReport {
  loaded: string[];
  missing: string[];
}

export class SplatRoom {
  private readonly scene: Scene3D;
  private readonly bytes = new Map<string, ArrayBuffer>();
  private readonly missing = new Set<string>();
  private placed: PlacedAnomaly[] = [];

  constructor(scene: Scene3D) {
    this.scene = scene;
  }

  get placements(): readonly PlacedAnomaly[] {
    return this.placed;
  }

  get report(): AssetReport {
    return { loaded: [...this.bytes.keys()], missing: [...this.missing] };
  }

  /** Whether a real Lux3D asset exists, as opposed to a baked placeholder. */
  has(key: string): boolean {
    return this.bytes.has(key);
  }

  /** Fetch the GLB bytes for each key. Missing files are remembered, not fatal. */
  async loadAssets(keys: readonly string[], signal?: AbortSignal): Promise<AssetReport> {
    const wanted = [...new Set(keys)].filter((key) => !this.bytes.has(key) && !this.missing.has(key));
    await Promise.all(
      wanted.map(async (key) => {
        try {
          const response = await fetch(`${BASE}${key}.glb`, { signal });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          this.bytes.set(key, await response.arrayBuffer());
        } catch {
          // A missing asset is reported and skipped; the rest of the floor still
          // has to be playable, so this must never reject.
          this.missing.add(key);
        }
      }),
    );
    return this.report;
  }

  /**
   * Replace the room's contents with this floor's anomalies.
   *
   * Returns the placements it managed to make. An anomaly whose asset is
   * missing is reported by the caller rather than silently skipped, because a
   * floor the player cannot clear is worse than one that says it is degraded.
   */
  async buildFloor(plan: FloorPlan, anchors: readonly AnchorDef[]): Promise<PlacedAnomaly[]> {
    this.clear();

    const byId = new Map(anchors.map((anchor) => [anchor.id, anchor]));
    const created: PlacedAnomaly[] = [];

    for (const anomaly of plan.anomalies) {
      const anchor = byId.get(anomaly.slotId);
      if (!anchor) continue;
      const buffer = anomaly.assetKey ? this.bytes.get(anomaly.assetKey) : undefined;
      if (!buffer) continue;

      // Twins fan out around the anchor rather than stacking on it, so the
      // repetition is the thing you notice.
      const copies = anomaly.kind === 'twin' ? (anomaly.count ?? 3) : 1;
      for (let i = 0; i < copies; i++) {
        const node = await this.instantiate(buffer, anomaly, anchor, i, copies);
        this.scene.add(node as never);
        created.push({
          anomaly,
          node,
          slotId: anchor.id,
          watches: anomaly.kind === 'stare',
          baseY: node.position.y,
        });
      }
    }

    this.placed = created;
    return created;
  }

  private async instantiate(
    buffer: ArrayBuffer,
    anomaly: Anomaly,
    anchor: AnchorDef,
    copyIndex: number,
    copies: number,
  ): Promise<Object3D> {
    const parsed = await loadGLTF(buffer.slice(0), { textureLoader: downloadTexture });
    const node = parsed.scene as unknown as Object3D;

    const offset = anomaly.offset ?? { x: 0, y: 0, z: 0 };
    let x = anchor.pos.x + offset.x;
    let z = anchor.pos.z + offset.z;

    if (copies > 1) {
      // A ring of radius 0.45 m: close enough to read as one arrangement,
      // far enough apart not to z-fight.
      const angle = (copyIndex / copies) * Math.PI * 2;
      x += Math.cos(angle) * 0.45;
      z += Math.sin(angle) * 0.45;
    }

    // A reconstructed floor is not level, so the object follows the anchor
    // rather than a global ground plane.
    node.position.set(x, anchor.pos.y + offset.y, z);
    const scale = anomaly.scale ?? 1;
    node.scale.set(scale, scale, scale);
    node.rotation.set(0, (anomaly.rotY ?? 0) + (copies > 1 ? copyIndex * 0.4 : 0), 0, 'YXZ');
    node.name = `foreign:${anchor.id}:${copyIndex}`;

    if (anomaly.tint !== undefined) applyTint(node, anomaly.tint);

    return node;
  }

  /** Remove every placed object from the scene. */
  clear(): void {
    for (const item of this.placed) {
      item.node.parent?.remove(item.node);
    }
    this.placed = [];
    this.clock = 0;
  }

  /**
   * Animate the room: the ones that watch, and the ones that breathe.
   *
   * Called every frame with the player's eye. A watcher whose rotation is only
   * set when it is placed would be a static prop that happens to point at the
   * door — the whole point is that it is still following you when you turn
   * around, so this has to run continuously rather than once.
   */
  update(dt: number, player: { x: number; y: number; z: number }): void {
    this.clock += dt;
    for (const item of this.placed) {
      if (!item.watches) continue;

      // Face the player. Same convention buildStare used when it aimed the prop
      // at the way in: +z of the prop turns toward (dx, dz).
      const dx = player.x - item.node.position.x;
      const dz = player.z - item.node.position.z;
      item.node.rotation.set(0, Math.atan2(dx, dz), 0, 'YXZ');

      // A slow rise and fall, so it reads as hovering rather than as a model
      // glued to the air. Small on purpose: a big bob looks like a bounce.
      let phase = item.phase;
      if (phase === undefined) {
        // Deliberately not random-per-frame: each watcher drifts on its own
        // offset so a room with two of them does not pulse in lockstep.
        phase = item.phase = (item.baseY * 37.1 + item.node.position.x * 11.7) % (Math.PI * 2);
      }
      item.node.position.set(
        item.node.position.x,
        item.baseY + Math.sin(this.clock * 1.15 + phase) * 0.028,
        item.node.position.z,
      );
    }
  }

  /** Seconds of animation applied so far — lets a harness prove update() ran. */
  private clock = 0;
  get elapsed(): number {
    return this.clock;
  }
  /**
   * What is under the crosshair, as a slot id, or null.
   *
   * `intersectObjects` fills an out-array rather than returning one, and the hit
   * names the leaf mesh — which for a GLB is several levels below the node that
   * carries the slot id — so the parent chain is walked up until it matches.
   */
  pick(camera: PerspectiveCamera, viewHeight: number, nx = 0, ny = 0): string | null {
    if (this.placed.length === 0) return null;

    const raycaster = new Raycaster();
    raycaster.setFromCamera(new Vector2(nx, ny), camera, viewHeight);

    const hits = raycaster.intersectObjects(
      this.placed.map((item) => item.node),
      true,
    );
    const first = hits[0];
    if (!first) return null;

    let node: Object3D | null = first.object;
    while (node) {
      const match = this.placed.find((item) => item.node === node);
      if (match) return match.slotId;
      node = node.parent;
    }
    return null;
  }
}

/**
 * Recolour every mesh in a subtree, best effort.
 *
 * The viewer's material API is deep and not documented for this use, so this
 * checks for a colour that can be set and otherwise leaves the asset alone
 * rather than throwing mid-floor. A `warp` anomaly that only resized is still
 * readable; one that crashed the render loop is not.
 */
function applyTint(node: Object3D, value: number): void {
  const [r, g, b] = tintOf(value);
  const visit = (object: Object3D): void => {
    const material = (object as unknown as { material?: { color?: { set?: (x: number, y: number, z: number) => void } } })
      .material;
    if (material?.color && typeof material.color.set === 'function') {
      material.color.set(r, g, b);
    }
    for (const child of object.children) visit(child);
  };
  visit(node);
}
