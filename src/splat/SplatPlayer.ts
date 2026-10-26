/**
 * First-person walker for a reconstructed 3DGS room.
 *
 * Same feel as `game/Player` (damped acceleration, pointer-lock look, head bob)
 * but a completely different collision model: a splat has no geometry to test
 * against, so movement is resolved with the scan's voxel occupancy field
 * (`viewer/voxel.ts`) instead of swept AABBs.
 *
 * The ground is found by casting down through the voxels rather than assuming a
 * flat floor, because a reconstructed room's floor is not level — it is whatever
 * the capture rig actually saw.
 */

import { resolveCapsule, EYE_HEIGHT, HOVER_HEIGHT, type Vec3Like } from '../viewer/voxel.ts';
import type { VoxelCollision } from '../viewer/VoxelCollision.ts';

const WALK_SPEED = 2.5;
const SPRINT_SPEED = 4.3;
const ACCEL = 12;
const DAMP = 11;
const LOOK_SENSITIVITY = 0.0022;
const MAX_PITCH = Math.PI / 2 - 0.06;
const BOB_AMPLITUDE = 0.024;
const BOB_RATE = 7.4;

/** How far below the eye the floor may be before we stop snapping to it. */
const GROUND_PROBE_REACH = 3.0;
/** Vertical speed while settling onto the floor, m/s. */
const GROUND_SNAP_RATE = 6.0;

export interface SplatSpawn {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch?: number;
}

export class SplatPlayer {
  /** Eye position, in the scan's own world units. */
  x = 0;
  y = 1;
  z = 0;
  yaw = 0;
  pitch = 0;

  private velocityX = 0;
  private velocityZ = 0;
  private keys = new Set<string>();
  private bobPhase = 0;
  private locked = false;
  private collision: VoxelCollision | null = null;
  private spawn: SplatSpawn | null = null;
  private readonly pushed: Vec3Like = { x: 0, y: 0, z: 0 };

  constructor(private readonly dom: HTMLElement) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    document.addEventListener('pointerlockchange', this.onLockChange);
    document.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('blur', this.onBlur);
  }

  get isLocked(): boolean {
    return this.locked;
  }

  get hasCollision(): boolean {
    return this.collision !== null;
  }

  get speed(): number {
    return Math.hypot(this.velocityX, this.velocityZ);
  }

  setCollision(collision: VoxelCollision | null): void {
    this.collision = collision;
  }

  /**
   * Drop the player at a pose. When a collision field is present the pose is
   * settled onto the floor first, so a spawn that is slightly off-level — or
   * inside a wall — ends up somewhere legal instead of falling through.
   */
  spawnAt(pose: SplatSpawn): void {
    this.spawn = { ...pose };
    this.x = pose.x;
    this.y = pose.y;
    this.z = pose.z;
    this.yaw = pose.yaw;
    this.pitch = pose.pitch ?? 0;
    this.velocityX = 0;
    this.velocityZ = 0;
    this.bobPhase = 0;
    this.settle(1);
  }

  respawn(): void {
    if (this.spawn) this.spawnAt(this.spawn);
  }

  requestLock(): void {
    // Browsers reject this without a user gesture, and for a moment after Esc.
    // An unhandled rejection would surface as a page error, so swallow it.
    try {
      const result = this.dom.requestPointerLock?.() as unknown;
      if (result && typeof (result as Promise<void>).catch === 'function') {
        (result as Promise<void>).catch(() => undefined);
      }
    } catch {
      /* ignore */
    }
  }

  releaseLock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  update(dt: number): void {
    // Input, in camera space, using the same yaw convention as the walk demo:
    // forward = (-sin yaw, 0, -cos yaw).
    const forward = (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? 1 : 0);
    const strafe = (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0);
    const sprinting = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    const target = sprinting ? SPRINT_SPEED : WALK_SPEED;

    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    let wishX = -sin * forward + cos * strafe;
    let wishZ = -cos * forward - sin * strafe;
    const len = Math.hypot(wishX, wishZ);
    if (len > 0) {
      wishX /= len;
      wishZ /= len;
    }

    const rate = len > 0 ? ACCEL : DAMP;
    this.velocityX += (wishX * target - this.velocityX) * Math.min(1, rate * dt);
    this.velocityZ += (wishZ * target - this.velocityZ) * Math.min(1, rate * dt);

    this.x += this.velocityX * dt;
    this.z += this.velocityZ * dt;

    this.settle(dt);

    this.bobPhase += dt * this.speed * BOB_RATE;
  }

  /**
   * Put the player on the floor and out of any wall.
   *
   * `dt` of 1 settles instantly, which is what a spawn wants.
   */
  private settle(dt: number): void {
    const collision = this.collision;
    if (!collision) return;

    // Ground: cast down from the eye, ignoring the cell we are standing in.
    const ground = collision.queryRay(this.x, this.y, this.z, 0, -1, 0, GROUND_PROBE_REACH);
    if (ground) {
      const wanted = ground.y + EYE_HEIGHT + HOVER_HEIGHT;
      const blend = Math.min(1, GROUND_SNAP_RATE * dt);
      this.y += (wanted - this.y) * blend;
    }

    // Walls, ceiling, and anything else solid. `resolveCapsule` always reports
    // a displacement, so this is an add, not an assignment.
    if (resolveCapsule(collision, this.x, this.y, this.z, this.pushed)) {
      this.x += this.pushed.x;
      this.y += this.pushed.y;
      this.z += this.pushed.z;
      // A push means we are against something; kill the speed into it so the
      // player does not keep accelerating while pinned.
      this.velocityX *= 0.2;
      this.velocityZ *= 0.2;
    }
  }

  /** Eye transform for the renderer, including head bob. */
  cameraState(): { x: number; y: number; z: number; yaw: number; pitch: number } {
    const bob = Math.sin(this.bobPhase) * BOB_AMPLITUDE * Math.min(1, this.speed / WALK_SPEED);
    return { x: this.x, y: this.y + bob, z: this.z, yaw: this.yaw, pitch: this.pitch };
  }

  /** Unit forward vector for the current yaw and pitch. */
  forwardVector(): { x: number; y: number; z: number } {
    const cosPitch = Math.cos(this.pitch);
    return {
      x: -Math.sin(this.yaw) * cosPitch,
      y: Math.sin(this.pitch),
      z: -Math.cos(this.yaw) * cosPitch,
    };
  }

  /** Feed movement without a keyboard, for the acceptance harness. */
  setKey(code: string, down: boolean): void {
    if (down) this.keys.add(code);
    else this.keys.delete(code);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    this.keys.add(e.code);
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  private onBlur = (): void => {
    this.keys.clear();
  };

  private onLockChange = (): void => {
    this.locked = document.pointerLockElement === this.dom;
    if (!this.locked) this.keys.clear();
  };

  /**
   * Apply a look delta, in the same units a mouse reports.
   *
   * The mousemove handler is a thin wrapper over this, so a recording driven by
   * `look()` goes through exactly the code the player's mouse goes through —
   * rather than through a second, parallel way of aiming the camera that could
   * drift from the real one.
   */
  look(movementX: number, movementY: number): void {
    this.yaw -= movementX * LOOK_SENSITIVITY;
    this.pitch -= movementY * LOOK_SENSITIVITY;
    this.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this.pitch));
  }

  private onMouseMove = (e: MouseEvent): void => {
    if (!this.locked) return;
    this.look(e.movementX, e.movementY);
  };

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    document.removeEventListener('pointerlockchange', this.onLockChange);
    document.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('blur', this.onBlur);
  }
}
