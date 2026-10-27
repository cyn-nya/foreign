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
  Box3,
  GLTFLoader,
  Raycaster,
  Vector2,
  Vector3,
  type Object3D,
  type PerspectiveCamera,
  type Scene3D,
  downloadTexture,
} from '@manycore/aholo-viewer';
import type { Anomaly, FloorPlan } from '../game/types.ts';
import type { AnchorDef } from '../game/rules.ts';

const { loadGLTF } = GLTFLoader;

/**
 * How far off centre the crosshair may sit when the ray passes through an object's holes.
 *
 * See `pickThroughHoles`. Two degrees is roughly a fingertip at arm's length.
 */
const PICK_TOLERANCE_DEG = 2;

const BASE = `${import.meta.env.BASE_URL ?? '/'}assets/foreign/`;

/**
 * One asset may not hold a floor hostage.
 *
 * See the note in `loadAssets`: the guard against re-fetching a missing asset was added
 * because retrying hung the page, and the timeout it called for was never written. A
 * fetch that opens a connection and then stalls therefore never settles, and because
 * floors run through a serial chain, the whole game stops between two of them with no
 * error shown.
 */
const ASSET_TIMEOUT_MS = 20_000;

/** The caller's signal, plus a deadline. Either one aborts. */
function withTimeout(signal?: AbortSignal): AbortSignal {
  const deadline = AbortSignal.timeout(ASSET_TIMEOUT_MS);
  if (!signal) return deadline;
  // `any` is the right tool and is available everywhere this game runs; the fallback
  // exists because a thrown ReferenceError here would be a load failure, and a load
  // failure is the thing being prevented.
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, deadline]) : deadline;
}

// Kept in its own module so the decision can be unit-tested without the viewer.
import { hasGlbMagic } from './glb.ts';


/** Vanilla three.js uses this refactor for a hex value into r/g/b floats. */
function tintOf(value: number): [number, number, number] {
  return [((value >> 16) & 0xff) / 255, ((value >> 8) & 0xff) / 255, (value & 0xff) / 255];
}

/**
 * A stable 0..1 from a placement and a channel.
 *
 * Used instead of `Math.random` so a swarm lands in the same arrangement every
 * time the floor is generated. FNV-1a over the characters, which is enough
 * spread for scattering objects and needs no state.
 */
function hash01(seed: string, index: number, channel: number): number {
  let h = 0x811c9dc5;
  const text = `${seed}:${index}:${channel}`;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) % 100000) / 100000;
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
  /** Innocent objects. Kept apart from `placed` so they can never score. */
  private readonly bystanderNodes: Object3D[] = [];

  constructor(scene: Scene3D) {
    this.scene = scene;
  }

  get placements(): readonly PlacedAnomaly[] {
    return this.placed;
  }

  /**
   * Hide every placed model at once, for measuring what they cost.
   *
   * Anomalies and bystanders together, because the question is the price of the
   * floor rather than of either role.
   */
  setVisible(visible: boolean): void {
    for (const item of this.placed) item.node.visible = visible;
    for (const node of this.bystanderNodes) node.visible = visible;
  }

  /** The innocent objects, for the acceptance check to aim at. */
  get bystanders(): readonly { node: Object3D; slotId: string }[] {
    return this.bystanderNodes.map((node) => ({ node, slotId: String(node.userData.slotId) }));
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
    // `missing` is a veto for the rest of the session. That is deliberate but not
    // free: one failed fetch removes that asset from the game until reload, and
    // every later floor needing it silently places nothing. Retrying it on every
    // floor was tried and hung the page (`await Promise.all` never settles when a
    // fetch does not return), so the fix has to come with a timeout on the fetch
    // itself rather than by removing the guard.
    const wanted = [...new Set(keys)].filter((key) => !this.bytes.has(key) && !this.missing.has(key));
    await Promise.all(
      wanted.map(async (key) => {
        try {
          const response = await fetch(`${BASE}${key}.glb`, { signal: withTimeout(signal) });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const buffer = await response.arrayBuffer();
          // `ok` is not enough. A static host answers 200 with the app's own
          // `index.html` for any path it does not have, so a missing asset arrives as
          // a perfectly successful response containing a web page. That page was then
          // handed to the model loader, which tried to parse it as a glTF header and
          // threw -- killing the whole session, on a floor the player could otherwise
          // have played, because one file was absent.
          //
          // A GLB starts with the ASCII magic `glTF`. Anything else is not one, and
          // the honest response is the same as a 404: report it and fall back.
          if (!hasGlbMagic(buffer)) throw new Error('not a GLB (served as a fallback page)');
          this.bytes.set(key, buffer);
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
      // repetition is the thing you notice. A swarm is the same idea taken past
      // the point where counting is possible.
      const copies =
        anomaly.kind === 'twin'
          ? (anomaly.count ?? 3)
          : anomaly.kind === 'swarm'
            ? (anomaly.count ?? 12)
            : 1;
      for (let i = 0; i < copies; i++) {
        const node = await this.instantiate(buffer, anomaly, anchor, i, copies);
        // Tagged like the bystanders so `pick` resolves both the same way. An
        // anomaly that resolves by object identity and an innocent object that
        // resolves by tag is two mechanisms where one will do, and the one that
        // is forgotten is the one that silently stops working.
        node.userData.slotId = anchor.id;
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

  /**
   * Put the innocent objects in the room.
   *
   * Nothing here watches, floats, duplicates or resizes — that is the entire
   * distinction the player has to make. They load through the same path and sit
   * at the same anchors as the anomalies, so a crisp object in the scan is no
   * longer a giveaway.
   */
  async buildBystanders(plan: FloorPlan, anchors: readonly AnchorDef[]): Promise<void> {
    const byId = new Map(anchors.map((anchor) => [anchor.id, anchor]));

    for (const bystander of plan.bystanders) {
      const anchor = byId.get(bystander.slotId);
      if (!anchor) continue;

      // Placed for its looks only: no entry in `placed`, so it can never be
      // counted as found, cannot be the target of a hit, and is never animated.
      //
      const buffer = this.bytes.get(bystander.assetKey);
      if (!buffer) continue;
      const parsed = await loadGLTF(buffer.slice(0), { textureLoader: downloadTexture });
      const node = parsed.scene as unknown as Object3D;
      node.position.set(anchor.pos.x, anchor.pos.y, anchor.pos.z);
      node.userData.slotId = bystander.slotId;
      this.scene.add(node as never);
      this.bystanderNodes.push(node);
    }
  }

  private async instantiate(
    buffer: ArrayBuffer,
    anomaly: Anomaly,
    anchor: AnchorDef,
    copyIndex: number,
    copies: number,
  ): Promise<Object3D> {
    // Household props arrive through the same path as the generated assets. They
    // are built offline as GLB rather than with three.js at runtime, because this
    // scene only accepts the Aholo viewer's own objects.
    const parsed = await loadGLTF(buffer.slice(0), { textureLoader: downloadTexture });
    const node = parsed.scene as unknown as Object3D;

    const offset = anomaly.offset ?? { x: 0, y: 0, z: 0 };
    let x = anchor.pos.x + offset.x;
    let y = anchor.pos.y + offset.y;
    let z = anchor.pos.z + offset.z;

    if (anomaly.kind === 'swarm' && copies > 1) {
      // Deterministic scatter, seeded from the placement rather than Math.random,
      // so the same floor always looks the same. Uniform in a ball: without the
      // cube root the copies bunch at the centre and stop reading as spread out.
      const spread = anomaly.spread ?? 1.4;
      const theta = hash01(anchor.id, copyIndex, 1) * Math.PI * 2;
      const phi = Math.acos(2 * hash01(anchor.id, copyIndex, 2) - 1);
      const radius = spread * Math.cbrt(hash01(anchor.id, copyIndex, 3));
      x += radius * Math.sin(phi) * Math.cos(theta);
      z += radius * Math.sin(phi) * Math.sin(theta);
      y += radius * Math.cos(phi) * 0.55;
    } else if (copies > 1) {
      // A ring of radius 0.45 m: close enough to read as one arrangement,
      // far enough apart not to z-fight.
      const angle = (copyIndex / copies) * Math.PI * 2;
      x += Math.cos(angle) * 0.45;
      z += Math.sin(angle) * 0.45;
    }

    // A reconstructed floor is not level, so the object follows the anchor
    // rather than a global ground plane.
    node.position.set(x, y, z);
    const scale = anomaly.scale ?? 1;
    node.scale.set(scale, scale, scale);
    // 'invert' is the only kind that changes the object's attitude rather than
    // its position: it is the wrong way up where it is.
    node.rotation.set(
      anomaly.flip ? Math.PI : 0,
      (anomaly.rotY ?? 0) + (copies > 1 && anomaly.kind === 'twin' ? copyIndex * 0.4 : 0),
      0,
      'YXZ',
    );
    node.name = `foreign:${anchor.id}:${copyIndex}`;

    if (anomaly.tint !== undefined) applyTint(node, anomaly.tint);

    return node;
  }

  /** Remove every placed object from the scene. */
  clear(): void {
    for (const item of this.placed) {
      item.node.parent?.remove(item.node);
    }
    for (const node of this.bystanderNodes) {
      node.parent?.remove(node);
    }
    this.bystanderNodes.length = 0;
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
  pick(camera: PerspectiveCamera, viewHeight: number, nx?: number, ny?: number): string | null {
    if (this.placed.length === 0) return null;

    // (0, 0) is the centre of the view here, not a corner: the viewer's
    // `setFromCamera` takes normalised device coordinates and uses `viewHeight`
    // only for the projection. Passing pixels returns null for everything.
    const raycaster = new Raycaster();
    raycaster.setFromCamera(new Vector2(nx ?? 0, ny ?? 0), camera, viewHeight);

    // Bystanders are in the raycast, and this matters more than it looks. When
    // they were left out, aiming at an innocent object found nothing at that
    // spot and the ray carried on through it to whatever stood behind — so
    // marking a bystander scored a hit on an anomaly the player could not see.
    // The objects have to be equally solid to the crosshair or the distinction
    // between them is not one the player can act on.
    const hits = raycaster.intersectObjects(
      [...this.placed.map((item) => item.node), ...this.bystanderNodes],
      true,
    );
    const first = hits[0];
    if (!first) return this.pickThroughHoles(raycaster);

    let node: Object3D | null = first.object;
    while (node) {
      const match = this.placed.find((item) => item.node === node);
      if (match) return match.slotId;
      const id = node.userData?.slotId;
      if (typeof id === 'string') return id;
      node = node.parent;
    }
    return null;
  }

  /**
   * As `pick`, but also saying whether the mesh belongs to a placed anomaly.
   *
   * `judgeMark` receives a slot id and nothing else, so it can only be as correct as the
   * claim that one slot holds one object. When a mark landed on a bystander and still
   * scored -- because the id it reported was also an anomaly's -- the assumption was the
   * bug, and the fix is to stop relying on it: a mark scores by reaching the anomaly's own
   * node, which is what the player did or did not do.
   *
   * The ray distance is deliberately not returned. Whether a wall was in the way is
   * already answered by the fact that the ray hit something at all.
   */
  pickDetail(
    camera: PerspectiveCamera,
    viewHeight: number,
    nx?: number,
    ny?: number,
  ): { slotId: string | null; reachedAnomaly: boolean } {
    if (this.placed.length === 0 && this.bystanderNodes.length === 0) {
      return { slotId: null, reachedAnomaly: false };
    }
    const raycaster = new Raycaster();
    raycaster.setFromCamera(new Vector2(nx ?? 0, ny ?? 0), camera, viewHeight);
    const hits = raycaster.intersectObjects(
      [...this.placed.map((item) => item.node), ...this.bystanderNodes],
      true,
    );
    const first = hits[0];
    if (!first) {
      // Nothing solid was reached, so the only thing that can be under the crosshair is a
      // thin object seen through its own holes -- and that is always one of the placed
      // anomalies, because the hole fallback exists to make marking them possible.
      const throughHoles = this.pickThroughHoles(raycaster);
      return { slotId: throughHoles, reachedAnomaly: throughHoles !== null };
    }
    // Walked by identity, never by comparing slot ids: two objects reporting one id is
    // exactly the case that has to stay a miss, and comparing ids is what made it a hit.
    let node: Object3D | null = first.object;
    while (node) {
      const match = this.placed.find((item) => item.node === node);
      if (match) return { slotId: match.slotId, reachedAnomaly: true };
      const id = node.userData?.slotId;
      if (typeof id === 'string') return { slotId: id, reachedAnomaly: false };
      node = node.parent;
    }
    return { slotId: null, reachedAnomaly: false };
  }

  /**
   * The frontmost object the crosshair is on, allowing for holes in thin geometry.
   *
   * Only called when the ray hit no geometry at all -- see the note at the call site.
   *
   * A bearing alone is not enough to choose between candidates, and choosing wrongly is
   * not a cosmetic error: picking the smallest angle reported a mark on an anomaly while
   * the player was aiming at the innocent object in front of it, which is precisely the
   * judgement the game exists to make. So candidates are ordered the way the raycast
   * orders them -- by distance along the ray -- and the tolerance only decides whether a
   * candidate counts as being under the crosshair at all.
   */
  private pickThroughHoles(raycaster: Raycaster): string | null {
    const direction = raycaster.ray.direction.clone().normalize();
    const origin = raycaster.ray.origin;
    const centre = new Vector3();
    const toObject = new Vector3();
    const tan = Math.tan((PICK_TOLERANCE_DEG * Math.PI) / 180);

    let bestId: string | null = null;
    let bestAlong = Infinity;
    // Bystanders are candidates too. Leaving them out would make a thin innocent object
    // un-markable, which is the same unfairness in the other direction: the room would
    // refuse to accept a mark the player clearly aimed at.
    for (const item of [...this.placed, ...this.bystanders]) {
      const box = new Box3().setFromObject(item.node);
      if (box.isEmpty()) continue;
      box.getCenter(centre);
      toObject.copy(centre).sub(origin);
      const along = toObject.dot(direction);
      // Behind the player is not a match.
      if (along <= 0) continue;
      // The perpendicular distance from the centre to the ray.
      const perpendicular = toObject.addScaledVector(direction, -along).length();
      if (perpendicular > along * tan) continue;
      if (along < bestAlong) {
        bestAlong = along;
        bestId = item.slotId;
      }
    }
    return bestId;
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
