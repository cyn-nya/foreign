/**
 * The room: static shell built once, props rebuilt per floor so that
 * per-floor anomalies (missing / moved / warped / duplicated / intruding)
 * can never leak into the next floor.
 */

import * as THREE from 'three';
import {
  ASSETS_BY_KEY,
  INTRUDE_ANCHORS,
  ROOM,
  SLOTS,
  SLOTS_BY_ID,
  WALLS,
} from './catalog';
import { FLAT_KINDS, rotatedFootprint } from './layout';
import { createProp, MATERIALS, tintProp } from './props';
import type { Anomaly, FloorPlan, Vec3 } from './types';

export type AABB = ReturnType<typeof rotatedFootprint>;

const DEFAULT_FOREIGN_SIZE: Vec3 = { x: 0.8, y: 1.0, z: 0.8 };

export class Room {
  readonly root = new THREE.Group();
  /** slotId -> holder. Intruders are keyed by their floor anchor id. */
  private holders = new Map<string, THREE.Object3D[]>();
  private propGeometries: THREE.BufferGeometry[] = [];
  private dynamicColliders: AABB[] = [];
  private staticColliders: AABB[] = [];
  private aholoOverride = new Map<string, THREE.Object3D>();

  /** Loaded Lux3D assets, keyed by asset key. Populated by assets.ts. */
  setAssetOverride(key: string, object: THREE.Object3D): void {
    this.aholoOverride.set(key, object);
  }

  hasAssetOverride(key: string): boolean {
    return this.aholoOverride.has(key);
  }

  buildShell(): void {
    const { minX, maxX, minZ, maxZ, wallHeight } = ROOM;
    const w = maxX - minX;
    const d = maxZ - minZ;

    const floorMat = MATERIALS.mat(0x6b4f38, 0.92);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(w, d), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set((minX + maxX) / 2, 0, (minZ + maxZ) / 2);
    floor.receiveShadow = true;
    this.root.add(floor);

    const ceilMat = MATERIALS.mat(0xd8d6cf, 1);
    const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(w, d), ceilMat);
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.set((minX + maxX) / 2, wallHeight, (minZ + maxZ) / 2);
    this.root.add(ceiling);

    // walls are colliders; the visible mesh is a hair thinner
    for (const wall of WALLS) {
      const sx = wall.max.x - wall.min.x;
      const sy = wall.max.y - wall.min.y;
      const sz = wall.max.z - wall.min.z;
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(sx, sy, sz),
        MATERIALS.mat(wall.partition ? 0xd7d2c8 : 0xcfc9be, 1),
      );
      mesh.position.set((wall.min.x + wall.max.x) / 2, sy / 2, (wall.min.z + wall.max.z) / 2);
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      this.root.add(mesh);

      // shrink the collider slightly so the player never snags on a seam
      const pad = 0.02;
      this.staticColliders.push({
        minX: wall.min.x + pad,
        maxX: wall.max.x - pad,
        minZ: wall.min.z + pad,
        maxZ: wall.max.z - pad,
      });
    }

    this.buildWindow();
    this.buildLighting();
  }

  /** One bright window on the far living-room wall — the room's only daylight. */
  private buildWindow(): void {
    const x = ROOM.minX + 0.07;
    const g = new THREE.Group();
    const frame = new THREE.Mesh(
      new THREE.BoxGeometry(0.06, 1.5, 2.2),
      MATERIALS.mat(0x8f8577, 0.9),
    );
    frame.position.set(x, 1.55, -1.8);
    g.add(frame);

    const pane = new THREE.Mesh(
      new THREE.BoxGeometry(0.03, 1.3, 2.0),
      MATERIALS.emissive(0xffe9c4, 1.1),
    );
    pane.position.set(x + 0.03, 1.55, -1.8);
    g.add(pane);

    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.04, 1.3, 0.05), MATERIALS.mat(0x6f665a));
    bar.position.set(x + 0.05, 1.55, -1.8);
    g.add(bar);
    const bar2 = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.05, 2.0), MATERIALS.mat(0x6f665a));
    bar2.position.set(x + 0.05, 1.55, -1.8);
    g.add(bar2);

    this.root.add(g);
  }

  private buildLighting(): void {
    this.root.add(new THREE.HemisphereLight(0xbfd4e8, 0x3a3228, 0.55));
    this.root.add(new THREE.AmbientLight(0xffffff, 0.16));

    const fromWindow = new THREE.DirectionalLight(0xffe6c0, 1.35);
    fromWindow.position.set(ROOM.minX - 5, 5.2, -1.8);
    fromWindow.target.position.set(0, 0.6, 0.4);
    fromWindow.castShadow = true;
    fromWindow.shadow.mapSize.set(1024, 1024);
    fromWindow.shadow.camera.left = -9;
    fromWindow.shadow.camera.right = 9;
    fromWindow.shadow.camera.top = 9;
    fromWindow.shadow.camera.bottom = -9;
    fromWindow.shadow.camera.near = 0.5;
    fromWindow.shadow.camera.far = 24;
    fromWindow.shadow.bias = -0.0009;
    this.root.add(fromWindow);
    this.root.add(fromWindow.target);

    // warm fill from the two ceiling fixtures
    const a = new THREE.PointLight(0xfff0d2, 9, 8, 2);
    a.position.set(-2.5, 2.45, 0.6);
    this.root.add(a);
    const b = new THREE.PointLight(0xfff0d2, 7, 7, 2);
    b.position.set(2.4, 2.45, 1.2);
    this.root.add(b);
  }

  /* ------------------------------------------------------------------ *
   * Per-floor props
   * ------------------------------------------------------------------ */

  applyFloor(plan: FloorPlan): void {
    this.clearProps();
    this.dynamicColliders = [];
    this.holders = new Map();

    const bySlot = new Map<string, Anomaly>();
    for (const a of plan.anomalies) bySlot.set(a.slotId, a);

    for (const slot of SLOTS) {
      const anomaly = bySlot.get(slot.id);
      // Honour the plan's contract rather than hardcoding a kind, so a future
      // anomaly that needs a slot emptied can reuse this without a code change.
      const hidden = plan.hiddenSlots.includes(slot.id);
      if (hidden) continue;

      const base = { x: slot.pos.x, y: slot.pos.y, z: slot.pos.z };
      const rotY = slot.rotY ?? 0;
      let scale = 1;
      let offset: Vec3 | undefined;
      let extraRotY = 0;

      if (anomaly?.kind === 'shift') {
        offset = anomaly.offset;
        extraRotY = anomaly.rotY ?? 0;
      } else if (anomaly?.kind === 'warp') {
        scale = anomaly.scale ?? 1;
      } else if (anomaly?.kind === 'twin') {
        offset = anomaly.offset;
        extraRotY = anomaly.rotY ?? 0;
      }

      const holder = this.makeHolder(slot.id, slot.kind, slot.size, base, rotY + extraRotY, scale);
      if (anomaly?.kind === 'shift' && anomaly.offset) {
        holder.position.set(base.x + anomaly.offset.x, base.y + anomaly.offset.y, base.z + anomaly.offset.z);
      }
      if (anomaly?.kind === 'warp' && anomaly.tint !== undefined) {
        tintProp(holder, anomaly.tint);
      }
      this.attach(holder, slot.id);

      if (anomaly?.kind === 'twin') {
        // Copies are fanned around the original on a circle, so three or more
        // of the same object read as absurd rather than as a coincidence.
        const copies = Math.max(2, anomaly.count ?? 3);
        const radius = Math.max(0.55, Math.hypot(offset?.x ?? 0.8, offset?.z ?? 0.8));
        const startAngle = Math.atan2(offset?.z ?? 0.8, offset?.x ?? 0.8);
        for (let i = 1; i < copies; i++) {
          const ang = startAngle + (i / copies) * Math.PI * 2;
          const twin = this.makeHolder(slot.id, slot.kind, slot.size, base, rotY + extraRotY, scale);
          twin.position.set(
            base.x + Math.cos(ang) * radius,
            base.y + (offset?.y ?? 0),
            base.z + Math.sin(ang) * radius,
          );
          if (anomaly.tint !== undefined) tintProp(twin, anomaly.tint);
          this.attach(twin, slot.id);
        }
      }
    }

    // objects that are placed, not furniture: 'intrude' sits on the floor,
    // 'stare' hangs at head height facing the door
    for (const a of plan.anomalies) {
      const placed = a.kind === 'intrude' || a.kind === 'stare';
      if (!placed || !a.assetKey) continue;
      const anchor = INTRUDE_ANCHORS.find((n) => n.id === a.slotId);
      if (!anchor) continue;
      const asset = ASSETS_BY_KEY.get(a.assetKey);

      const override = this.aholoOverride.get(a.assetKey);
      let object: THREE.Object3D;
      if (override) {
        object = override.clone(true);
      } else {
        const size = asset
          ? { x: DEFAULT_FOREIGN_SIZE.x * 1.0, y: DEFAULT_FOREIGN_SIZE.y * 1.05, z: DEFAULT_FOREIGN_SIZE.z }
          : DEFAULT_FOREIGN_SIZE;
        object = createProp(asset?.placeholder ?? 'duck', size);
        this.trackGeometries(object);
      }

      const lift = a.offset?.y ?? 0;
      const holder = new THREE.Group();
      holder.position.set(
        anchor.pos.x + (a.offset?.x ?? 0),
        anchor.pos.y + lift,
        anchor.pos.z + (a.offset?.z ?? 0),
      );
      // seeded, not Math.random(): the same floor must look the same every run
      holder.rotation.y = a.rotY ?? 0;
      holder.scale.setScalar(asset?.scale ?? 1);
      holder.userData.slotId = a.slotId;
      holder.userData.isIntruder = true;
      holder.add(object);
      this.attach(holder, a.slotId);

      // only floor-level objects block the player; a floating face must not
      if (lift < 0.25) {
        const footprint = override ? 0.42 : DEFAULT_FOREIGN_SIZE.x / 2;
        this.dynamicColliders.push({
          minX: anchor.pos.x - footprint,
          maxX: anchor.pos.x + footprint,
          minZ: anchor.pos.z - footprint,
          maxZ: anchor.pos.z + footprint,
        });
      }
    }
  }

  private makeHolder(
    slotId: string,
    kind: (typeof SLOTS)[number]['kind'],
    size: Vec3,
    pos: Vec3,
    rotY: number,
    scale: number,
  ): THREE.Group {
    const holder = new THREE.Group();
    holder.position.set(pos.x, pos.y, pos.z);
    holder.rotation.y = rotY;
    holder.scale.setScalar(scale);
    holder.userData.slotId = slotId;
    const prop = createProp(kind, size);
    holder.add(prop);
    this.trackGeometries(prop);
    return holder;
  }

  private attach(holder: THREE.Object3D, slotId: string): void {
    this.root.add(holder);
    const list = this.holders.get(slotId);
    if (list) list.push(holder);
    else this.holders.set(slotId, [holder]);

    const collider = this.footprintOf(holder);
    if (collider) this.dynamicColliders.push(collider);
  }

  /** Axis-aligned footprint of a holder, accounting for its Y rotation. */
  private footprintOf(holder: THREE.Object3D): AABB | null {
    if (holder.userData.isIntruder) return null;
    const slotId = holder.userData.slotId as string | undefined;
    if (!slotId) return null;
    const slot = SLOTS_BY_ID.get(slotId);
    if (!slot || FLAT_KINDS.has(slot.kind)) return null;

    return rotatedFootprint(
      holder.position.x,
      holder.position.z,
      slot.size.x,
      slot.size.z,
      holder.rotation.y,
      holder.scale.x,
    );
  }

  private trackGeometries(root: THREE.Object3D): void {
    root.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh && mesh.geometry) this.propGeometries.push(mesh.geometry);
    });
  }

  private clearProps(): void {
    for (const list of this.holders.values()) {
      for (const holder of list) this.root.remove(holder);
    }
    this.holders = new Map();
    for (const geo of this.propGeometries) geo.dispose();
    this.propGeometries = [];
  }

  /* ------------------------------------------------------------------ *
   * Queries
   * ------------------------------------------------------------------ */

  colliders(): AABB[] {
    return this.staticColliders.concat(this.dynamicColliders);
  }

  holderFor(slotId: string): THREE.Object3D | null {
    const list = this.holders.get(slotId);
    return list && list.length ? list[0] : null;
  }

  /** Walk up from a raycast hit to the holder that owns it. */
  resolveSlot(object: THREE.Object3D | null): string | null {
    let node: THREE.Object3D | null = object;
    while (node) {
      const id = node.userData?.slotId;
      if (typeof id === 'string') return id;
      node = node.parent;
    }
    return null;
  }

  /** Objects that should react to being looked at. */
  interactiveRoot(): THREE.Object3D {
    return this.root;
  }
}
