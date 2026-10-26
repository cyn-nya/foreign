/**
 * First-person walker. Pointer-lock look, WASD move, swept-AABB collision
 * against the room's wall and furniture boxes.
 *
 * Deliberately damped rather than instant: slow acceleration makes the
 * player feel like they are creeping through someone else's flat, which
 * is the whole point of the game.
 */

import * as THREE from 'three';
import { ROOM, SPAWN } from './catalog';
import type { AABB } from './Room';

const WALK_SPEED = 2.5;
const SPRINT_SPEED = 4.3;
const ACCEL = 12;
const DAMP = 11;
const LOOK_SENSITIVITY = 0.0022;
const MAX_PITCH = Math.PI / 2 - 0.06;

export class Player {
  readonly position = new THREE.Vector3(SPAWN.pos.x, SPAWN.pos.y, SPAWN.pos.z);
  yaw = SPAWN.yaw;
  pitch = 0;

  private velocity = new THREE.Vector3();
  private keys = new Set<string>();
  private bobPhase = 0;
  private locked = false;

  constructor(
    private camera: THREE.PerspectiveCamera,
    private dom: HTMLElement,
  ) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    document.addEventListener('pointerlockchange', this.onLockChange);
    document.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('blur', this.onBlur);
  }

  get isLocked(): boolean {
    return this.locked;
  }

  requestLock(): void {
    // Browsers reject this when there was no user gesture, and also for a
    // short window after Esc. An unhandled rejection here would surface as a
    // page error, so swallow it — the player can always click again.
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

  respawn(): void {
    this.position.set(SPAWN.pos.x, SPAWN.pos.y, SPAWN.pos.z);
    this.yaw = SPAWN.yaw;
    this.pitch = 0;
    this.velocity.set(0, 0, 0);
  }

  update(dt: number, colliders: AABB[]): void {
    const forward = (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? 1 : 0);
    const strafe = (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0);
    const sprinting = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    const target = sprinting ? SPRINT_SPEED : WALK_SPEED;

    // input in camera space
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    let wishX = -sin * forward + cos * strafe;
    let wishZ = -cos * forward - sin * strafe;
    const len = Math.hypot(wishX, wishZ);
    if (len > 0) {
      wishX /= len;
      wishZ /= len;
    }

    const moving = len > 0;
    const desiredX = wishX * target;
    const desiredZ = wishZ * target;
    const rate = moving ? ACCEL : DAMP;

    this.velocity.x += (desiredX - this.velocity.x) * Math.min(1, rate * dt);
    this.velocity.z += (desiredZ - this.velocity.z) * Math.min(1, rate * dt);

    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;

    this.resolve(colliders);

    // clamp to the shell
    const r = ROOM.radius;
    this.position.x = THREE.MathUtils.clamp(this.position.x, ROOM.minX + r, ROOM.maxX - r);
    this.position.z = THREE.MathUtils.clamp(this.position.z, ROOM.minZ + r, ROOM.maxZ - r);

    // head bob, scaled by actual speed
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    this.bobPhase += dt * speed * 7.4;
    const bob = Math.sin(this.bobPhase) * 0.024 * Math.min(1, speed / WALK_SPEED);

    this.camera.position.set(this.position.x, ROOM.eyeHeight + bob, this.position.z);
    this.camera.rotation.set(0, 0, 0);
    this.camera.rotateY(this.yaw);
    this.camera.rotateX(this.pitch);
  }

  /** Push the player out of any box they ended up inside. Two passes handles corners. */
  private resolve(colliders: AABB[]): void {
    const r = ROOM.radius;
    for (let pass = 0; pass < 2; pass++) {
      let pushed = false;
      for (const c of colliders) {
        const minX = c.minX - r;
        const maxX = c.maxX + r;
        const minZ = c.minZ - r;
        const maxZ = c.maxZ + r;
        const { x, z } = this.position;
        if (x <= minX || x >= maxX || z <= minZ || z >= maxZ) continue;

        const dl = x - minX;
        const dr = maxX - x;
        const db = z - minZ;
        const dt = maxZ - z;
        const m = Math.min(dl, dr, db, dt);
        if (m === dl) this.position.x = minX;
        else if (m === dr) this.position.x = maxX;
        else if (m === db) this.position.z = minZ;
        else this.position.z = maxZ;

        if (m === dl || m === dr) this.velocity.x = 0;
        else this.velocity.z = 0;
        pushed = true;
      }
      if (!pushed) break;
    }
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

  private onMouseMove = (e: MouseEvent): void => {
    if (!this.locked) return;
    this.yaw -= e.movementX * LOOK_SENSITIVITY;
    this.pitch -= e.movementY * LOOK_SENSITIVITY;
    this.pitch = THREE.MathUtils.clamp(this.pitch, -MAX_PITCH, MAX_PITCH);
  };

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    document.removeEventListener('pointerlockchange', this.onLockChange);
    document.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('blur', this.onBlur);
  }
}
