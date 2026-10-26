/**
 * Game loop, state machine and all screen rendering.
 *
 * States: menu -> playing <-> paused -> floorClear -> playing -> ... -> gameOver
 */

import * as THREE from 'three';
import { SLOTS } from './catalog';
import { Room } from './Room';
import { Player } from './Player';
import { loadForeignAssets, type AssetLoadReport } from './assets';
import {
  floorClearScore,
  formatClock,
  generateFloor,
  hitScore,
  judgeMark,
  makeSeed,
} from './rules';
import type { FloorPlan } from './types';

type State = 'boot' | 'menu' | 'howto' | 'playing' | 'paused' | 'floorClear' | 'gameOver';

const MISS_TIME_PENALTY = 8;
const REACH = 4.0;

interface RunStats {
  score: number;
  floorsCleared: number;
  hits: number;
  misses: number;
  startedAt: number;
}

export class Game {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private room = new Room();
  private player: Player;
  private clock = new THREE.Clock();
  private raycaster = new THREE.Raycaster();

  private state: State = 'boot';
  private plan: FloorPlan | null = null;
  private floor = 1;
  private timeLeft = 0;
  private found: string[] = [];
  private floorMisses = 0;
  private runSalt = Math.floor(Math.random() * 0xfffffff);
  private fixedSeed: number | null = null;
  private stats: RunStats = { score: 0, floorsCleared: 0, hits: 0, misses: 0, startedAt: 0 };
  private assetReport: AssetLoadReport = { loaded: [], missing: [] };
  private hovered: string | null = null;
  private toastTimer = 0;

  private readonly overlay: HTMLElement;
  private readonly hud: HTMLElement;
  private readonly crosshair: HTMLElement;
  private readonly el = {
    floor: document.getElementById('hud-floor') as HTMLElement,
    found: document.getElementById('hud-found') as HTMLElement,
    total: document.getElementById('hud-total') as HTMLElement,
    time: document.getElementById('hud-time') as HTMLElement,
    toast: document.getElementById('hud-toast') as HTMLElement,
  };

  constructor(canvas: HTMLCanvasElement) {
    this.overlay = document.getElementById('overlay') as HTMLElement;
    this.hud = document.getElementById('hud') as HTMLElement;
    this.crosshair = document.getElementById('crosshair') as HTMLElement;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      // only needed so the screenshot harness can read pixels back out
      preserveDrawingBuffer: new URLSearchParams(location.search).has('capture'),
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene.background = new THREE.Color(0x05070a);
    this.scene.fog = new THREE.Fog(0x05070a, 9, 26);
    this.scene.add(this.room.root);

    this.camera = new THREE.PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.05, 60);
    this.scene.add(this.camera);

    this.player = new Player(this.camera, canvas);

    window.addEventListener('resize', this.onResize);
    canvas.addEventListener('mousedown', this.onCanvasMouseDown);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', this.onLockChange);
  }

  /* ------------------------------------------------------------------ *
   * Boot
   * ------------------------------------------------------------------ */

  async init(): Promise<void> {
    const params = new URLSearchParams(location.search);
    const forcedFloor = Number(params.get('floor'));
    const seedParam = params.get('seed');
    if (seedParam) this.fixedSeed = Number(seedParam) >>> 0;

    this.room.buildShell();

    document.body.classList.add('loading');
    this.showLoading();

    this.assetReport = await loadForeignAssets(this.room);
    document.body.classList.remove('loading');

    if (params.get('autostart') === '1') {
      this.startRun();
      if (Number.isFinite(forcedFloor) && forcedFloor > 1) this.startFloor(forcedFloor);
    } else {
      this.showMenu();
    }

    this.loop();
  }

  /* ------------------------------------------------------------------ *
   * Run control
   * ------------------------------------------------------------------ */

  private startRun(): void {
    this.stats = { score: 0, floorsCleared: 0, hits: 0, misses: 0, startedAt: performance.now() };
    this.runSalt = this.fixedSeed ?? Math.floor(Math.random() * 0xfffffff);
    this.startFloor(1);
  }

  private startFloor(floor: number): void {
    this.floor = floor;
    const seed = this.fixedSeed ? makeSeed(floor, this.fixedSeed) : makeSeed(floor, this.runSalt);
    this.plan = generateFloor(floor, seed);
    this.room.applyFloor(this.plan);
    this.found = [];
    this.floorMisses = 0;
    this.timeLeft = this.plan.duration;
    this.hovered = null;

    this.player.respawn();
    this.player.requestLock();
    this.setState('playing');
    this.updateHud();

    if (floor === 1) {
      this.toast('找出不属于这个房间的东西', 'info', 3.4);
    } else {
      this.toast(`第 ${floor} 层 · 房间又变了`, 'info', 2.6);
    }
  }

  private markHovered(): void {
    if (this.state !== 'playing' || !this.plan) return;
    if (!this.hovered) {
      this.toast('这里没有问题', 'bad', 1.1);
      return;
    }

    const outcome = judgeMark(this.plan, this.hovered, this.found);
    if (outcome.result === 'miss') {
      this.floorMisses += 1;
      this.stats.misses += 1;
      this.timeLeft = Math.max(0, this.timeLeft - MISS_TIME_PENALTY);
      this.toast(`✗ 这里没有问题  −${MISS_TIME_PENALTY}s`, 'bad', 1.4);
      return;
    }
    if (outcome.result === 'repeat' || !outcome.anomaly) {
      this.toast('已经标记过了', 'info', 1.1);
      return;
    }

    this.found.push(outcome.anomaly.id);
    const gained = hitScore(this.timeLeft, this.plan.duration);
    this.stats.score += gained;
    this.stats.hits += 1;
    this.toast(`✓ ${outcome.anomaly.label}  +${gained}`, 'good', 2.0);
    this.updateHud();

    if (this.found.length >= this.plan.anomalies.length) this.clearFloor();
  }

  private clearFloor(): void {
    if (!this.plan) return;
    const bonus = floorClearScore(this.floor, this.timeLeft, this.floorMisses);
    this.stats.score += bonus;
    this.stats.floorsCleared += 1;
    this.player.releaseLock();
    this.setState('floorClear');
  }

  private failRun(): void {
    this.player.releaseLock();
    this.setState('gameOver');
  }

  /* ------------------------------------------------------------------ *
   * Loop
   * ------------------------------------------------------------------ */

  private loop = (): void => {
    requestAnimationFrame(this.loop);
    const dt = Math.min(0.05, this.clock.getDelta());

    if (this.state === 'playing') {
      this.player.update(dt, this.room.colliders());
      this.updateHover();
      this.timeLeft -= dt;
      if (this.timeLeft <= 0) {
        this.timeLeft = 0;
        this.updateClock();
        this.failRun();
      } else {
        this.updateClock();
      }
    } else if (this.state === 'floorClear' || this.state === 'paused' || this.state === 'gameOver') {
      // keep the camera where it is
    } else {
      this.player.update(dt, this.room.colliders());
    }

    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.el.toast.classList.remove('show');
    }

    this.renderer.render(this.scene, this.camera);
  };

  private updateHover(): void {
    this.raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);
    this.raycaster.far = REACH;
    const hits = this.raycaster.intersectObject(this.room.interactiveRoot(), true);
    let slot: string | null = null;
    for (const hit of hits) {
      slot = this.room.resolveSlot(hit.object);
      if (slot) break;
    }
    this.hovered = slot;

    const isNew = slot !== null && !this.found.includes(this.markIdFor(slot));
    this.crosshair.classList.toggle('hot', isNew);
  }

  /** The anomaly id a slot would resolve to, for crosshair styling only. */
  private markIdFor(slotId: string): string {
    const anomaly = this.plan?.anomalies.find((a) => a.slotId === slotId);
    return anomaly ? anomaly.id : '__none__';
  }

  /* ------------------------------------------------------------------ *
   * HUD
   * ------------------------------------------------------------------ */

  private updateHud(): void {
    this.el.floor.textContent = String(this.floor);
    this.el.found.textContent = String(this.found.length);
    this.el.total.textContent = String(this.plan?.anomalies.length ?? 0);
    this.updateClock();
  }

  private updateClock(): void {
    this.el.time.textContent = formatClock(this.timeLeft);
    this.el.time.classList.toggle('low', this.timeLeft < 30);
  }

  private toast(text: string, tone: 'good' | 'bad' | 'info', seconds = 2): void {
    this.el.toast.textContent = text;
    this.el.toast.className = `toast show ${tone}`;
    this.toastTimer = seconds;
  }

  private setState(state: State): void {
    this.state = state;
    const inGame = state === 'playing' || state === 'paused' || state === 'floorClear';
    this.hud.classList.toggle('hidden', !inGame);
    this.crosshair.classList.toggle('hidden', state !== 'playing');

    switch (state) {
      case 'playing':
        this.overlay.classList.add('hidden');
        this.overlay.innerHTML = '';
        break;
      case 'paused':
        this.showPaused();
        break;
      case 'floorClear':
        this.showFloorClear();
        break;
      case 'gameOver':
        this.showGameOver();
        break;
      default:
        break;
    }
  }

  /* ------------------------------------------------------------------ *
   * Screens
   * ------------------------------------------------------------------ */

  private renderOverlay(html: string): void {
    this.overlay.classList.remove('hidden');
    this.overlay.innerHTML = `<div class="panel">${html}</div>`;
  }

  private bind(id: string, fn: () => void): void {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', fn);
  }

  private showLoading(): void {
    this.renderOverlay(`
      <h1 class="title">FOREIGN<span class="sub">异物</span></h1>
      <p class="tagline">正在载入房间…</p>
    `);
  }

  private assetLine(): string {
    const total = this.assetReport.loaded.length + this.assetReport.missing.length;
    if (this.assetReport.loaded.length === 0) {
      return `<div class="warn">未检测到 Lux3D 资产 · 正在使用程序化占位模型（${total} 个待生成）</div>`;
    }
    return `<div class="ok">已载入 ${this.assetReport.loaded.length}/${total} 个 Lux3D 生成资产</div>`;
  }

  private showMenu(): void {
    this.setState('menu');
    this.renderOverlay(`
      <h1 class="title">FOREIGN<span class="sub">异物</span></h1>
      <p class="tagline">
        你站在一间被 3D 重建的真实房间里。<br />
        有些东西 <strong>不属于这里</strong> —— 它们是被生成出来的。<br />
        在时间耗尽之前，把它们全部找出来。
      </p>
      <div class="actions">
        <button id="btn-start" class="primary">进入房间</button>
        <button id="btn-howto" class="ghost">怎么玩</button>
      </div>
      <div class="asset-status">${this.assetLine()}</div>
    `);
    this.bind('btn-start', () => this.startRun());
    this.bind('btn-howto', () => this.showHowTo());
  }

  private showHowTo(): void {
    this.setState('howto');
    this.renderOverlay(`
      <h1 class="title" style="font-size:30px">怎么玩<span class="sub">HOW TO PLAY</span></h1>
      <p class="tagline" style="text-align:left">
        <strong>1 · 看</strong>　每次进入的走廊、客厅、厨房、卧室都是同一个房间。<br />
        <strong>2 · 找</strong>　但每一层都有东西被改过：<br />
        　　· 多了一件不该存在的东西<br />
        　　· 少了一样本来在的东西<br />
        　　· 有东西被挪动、浮空、放大、变色或复制<br />
        <strong>3 · 标记</strong>　准星对准它，左键确认。标错扣 8 秒。<br />
        <strong>4 · 下一层</strong>　全部找齐就下潜一层，房间重新排布。
      </p>
      <div class="actions"><button id="btn-back" class="primary">明白了</button></div>
      <div class="asset-status">${this.assetLine()}</div>
    `);
    this.bind('btn-back', () => this.showMenu());
  }

  private showPaused(): void {
    this.renderOverlay(`
      <h1 class="title" style="font-size:30px">暂停<span class="sub">PAUSED</span></h1>
      <p class="tagline">第 ${this.floor} 层 · 得分 <strong>${this.stats.score}</strong></p>
      <div class="actions">
        <button id="btn-resume" class="primary">继续</button>
        <button id="btn-quit" class="ghost">放弃本轮</button>
      </div>
    `);
    this.bind('btn-resume', () => {
      this.setState('playing');
      this.player.requestLock();
    });
    this.bind('btn-quit', () => this.showGameOver(true));
  }

  private showFloorClear(): void {
    const rows = (this.plan?.anomalies ?? [])
      .map((a) => `<div class="score-line">· ${a.label}</div>`)
      .join('');
    this.renderOverlay(`
      <div class="big-score">${this.stats.score}</div>
      <p class="tagline" style="margin:6px 0 18px">
        第 ${this.floor} 层清除 · 剩余 ${formatClock(this.timeLeft)}
        ${this.floorMisses ? ` · 误标 ${this.floorMisses} 次` : ' · 零误标'}
      </p>
      <div style="text-align:left;margin-bottom:22px">${rows}</div>
      <div class="actions"><button id="btn-next" class="primary">下潜到第 ${this.floor + 1} 层</button></div>
    `);
    this.bind('btn-next', () => this.startFloor(this.floor + 1));
  }

  private showGameOver(quit = false): void {
    const elapsed = (performance.now() - this.stats.startedAt) / 1000;
    this.setState('gameOver');
    this.renderOverlay(`
      <h1 class="title" style="font-size:28px">${quit ? '已放弃' : '时间到'}<span class="sub">${quit ? 'ABANDONED' : 'TIME UP'}</span></h1>
      <div class="big-score">${this.stats.score}</div>
      <div style="margin:18px 0 24px">
        <div class="score-line">抵达层数 <b>${this.floor}</b></div>
        <div class="score-line">清除层数 <b>${this.stats.floorsCleared}</b></div>
        <div class="score-line">正确标记 <b>${this.stats.hits}</b> · 误标 <b>${this.stats.misses}</b></div>
        <div class="score-line">用时 <b>${formatClock(elapsed)}</b></div>
      </div>
      <div class="actions">
        <button id="btn-again" class="primary">再来一轮</button>
        <button id="btn-menu" class="ghost">回主菜单</button>
      </div>
    `);
    this.bind('btn-again', () => this.startRun());
    this.bind('btn-menu', () => this.showMenu());
  }

  /* ------------------------------------------------------------------ *
   * Events
   * ------------------------------------------------------------------ */

  private onResize = (): void => {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  };

  private onCanvasMouseDown = (e: MouseEvent): void => {
    if (this.state !== 'playing') return;
    if (e.button !== 0) return;
    if (!this.player.isLocked) {
      this.player.requestLock();
      return;
    }
    this.markHovered();
  };

  private onLockChange = (): void => {
    if (this.state === 'playing' && !this.player.isLocked) this.setState('paused');
  };

  /* ------------------------------------------------------------------ *
   * Debug / harness hooks
   * ------------------------------------------------------------------ */

  /** Used by the screenshot harness and tests. */
  debug(): Record<string, unknown> {
    return {
      state: this.state,
      floor: this.floor,
      timeLeft: this.timeLeft,
      score: this.stats.score,
      found: this.found.length,
      anomalies: this.plan?.anomalies ?? [],
      hovered: this.hovered,
      assets: this.assetReport,
      playerPos: { x: this.player.position.x, z: this.player.position.z },
    };
  }

  /** Force the camera to a position and orientation — screenshot harness only. */
  debugPlace(x: number, z: number, yaw: number, pitch = 0): void {
    this.player.position.set(x, 0, z);
    this.player.yaw = yaw;
    this.player.pitch = pitch;
    this.player.update(0.016, this.room.colliders());
  }

  /** Mark a slot by id, bypassing the raycast — screenshot harness only. */
  debugMark(slotId: string): void {
    this.hovered = slotId;
    this.markHovered();
  }

  /**
   * Props a player is expected to be able to find. Used by the harness to
   * prove that nothing was authored into a corner nobody can ever see.
   */
  debugCoverTargets(): string[] {
    return SLOTS.filter((s) => !s.subtle && !s.anchored && s.pos.y < 0.05).map((s) => s.id);
  }

  /**
   * Exact line-of-sight test from the current camera: for each cover target,
   * cast at a few points on the prop and report those with an unobstructed
   * path. A ray fan samples too coarsely to trust for small furniture.
   */
  debugVisibleTargets(): string[] {
    const origin = this.camera.position.clone();
    const raycaster = new THREE.Raycaster();
    const visible: string[] = [];

    for (const slot of SLOTS) {
      if (slot.anchored || slot.pos.y > 0.05) continue;
      const samples: THREE.Vector3[] = [
        new THREE.Vector3(slot.pos.x, slot.pos.y + slot.size.y * 0.5, slot.pos.z),
        new THREE.Vector3(slot.pos.x, slot.pos.y + slot.size.y * 0.85, slot.pos.z),
        new THREE.Vector3(slot.pos.x + slot.size.x * 0.25, slot.pos.y + slot.size.y * 0.5, slot.pos.z),
        new THREE.Vector3(slot.pos.x, slot.pos.y + slot.size.y * 0.5, slot.pos.z + slot.size.z * 0.25),
      ];

      for (const point of samples) {
        const dir = point.clone().sub(origin);
        const distance = dir.length();
        if (distance < 0.4) {
          visible.push(slot.id);
          break;
        }
        dir.normalize();
        raycaster.set(origin, dir);
        raycaster.far = distance - 0.03;
        const hits = raycaster.intersectObject(this.room.interactiveRoot(), true);
        const blocked = hits.some((hit) => this.room.resolveSlot(hit.object) !== slot.id);
        if (!blocked) {
          visible.push(slot.id);
          break;
        }
      }
    }
    return visible;
  }

  /**
   * Fire a grid of rays through the current camera and report what they hit.
   * Lets the harness prove the room is actually furnished from a given
   * viewpoint without anyone having to look at a picture.
   */
  debugRaycastFan(cols = 9, rows = 5): {
    total: number;
    hit: number;
    slots: [string, number][];
    unnamed: number;
  } {
    const raycaster = new THREE.Raycaster();
    raycaster.far = 40;
    const counts = new Map<string, number>();
    let hit = 0;
    let unnamed = 0;

    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        const ndc = new THREE.Vector2(
          cols === 1 ? 0 : (i / (cols - 1)) * 2 - 1,
          rows === 1 ? 0 : (j / (rows - 1)) * 2 - 1,
        );
        raycaster.setFromCamera(ndc, this.camera);
        const results = raycaster.intersectObject(this.room.interactiveRoot(), true);
        if (results.length === 0) continue;
        hit += 1;
        const slot = this.room.resolveSlot(results[0].object);
        if (slot) counts.set(slot, (counts.get(slot) ?? 0) + 1);
        else unnamed += 1;
      }
    }

    return {
      total: cols * rows,
      hit,
      unnamed,
      slots: [...counts.entries()].sort((a, b) => b[1] - a[1]),
    };
  }
}
