/**
 * Entry point for the 3DGS backend — FOREIGN played in a real reconstructed room.
 *
 * This is deliberately a separate page from `index.html` (the procedurally built
 * room on three.js): the two renderers cannot share a canvas, and keeping them
 * side by side means the working game keeps passing acceptance while this one is
 * built up to the same standard.
 *
 * All the rules come from `src/game/`, unchanged — the generator, the judging,
 * the scoring. What differs is only the room: fixed scanned geometry instead of
 * authored walls, and every anomaly is an object placed into it.
 */

import { FOREIGN_ASSETS } from '../game/catalog.ts';
import { MAX_MISTAKES, formatClock, generateFloor, hitScore, judgeMark } from '../game/rules.ts';
import type { FloorPlan } from '../game/types.ts';
import { SplatPlayer } from './SplatPlayer.ts';
import { SplatRoom } from './SplatRoom.ts';
import { ROOM_ANCHORS, ROOM_FLOOR_OPTIONS } from './roomAnchors.ts';
import { ROOM_SPAWN, SplatScene } from './SplatScene.ts';

/** Every asset a floor could ever ask for. */
const ASSET_KEYS = FOREIGN_ASSETS.map((asset) => asset.key);

interface MarkReport {
  result: 'hit' | 'miss' | 'repeat';
  slotId: string | null;
  found: number;
  marksLeft: number;
  state: GameState;
  label?: string;
}

type GameState = 'loading' | 'menu' | 'playing' | 'floorClear' | 'gameOver' | 'failed';

interface SplatDebug {
  ready: boolean;
  stage: string;
  error: string | null;
  collision: boolean;
  splat: boolean;
  spawn: typeof ROOM_SPAWN;
  state: GameState;
  floor: number;
  score: number;
  found: string[];
  marksLeft: number;
  timeLeft: number;
  anomalyCount: number;
  /** How many objects are actually in the room this floor. */
  placed: number;
  anchors: number;
  assets: { loaded: number; missing: string[] };
  player: {
    x: number;
    y: number;
    z: number;
    yaw: number;
    pitch: number;
    speed: number;
    locked: boolean;
  };
  frames: number;
  setKey: (code: string, down: boolean) => void;
  respawn: () => void;
  teleport: (x: number, y: number, z: number, yaw?: number, pitch?: number) => void;
  setCollision: (enabled: boolean) => void;
  setAutoRender: (enabled: boolean) => void;
  renderOnce: () => void;
  walk: (seconds: number, code?: string) => { from: [number, number, number]; to: [number, number, number] };
  /** Start a floor without needing a pointer lock, which headless has no way to give. */
  start: (floor?: number, seed?: number, lock?: boolean) => Promise<void>;
  /** Mark whatever the crosshair is on — the same path a click takes. */
  mark: () => MarkReport;
  /** Aim the camera at one of the placed objects. Returns its slot id. */
  aimAt: (index: number) => string | null;
  /** Where each placed object is, in the room and on screen. */
  placements: () => { slotId: string; kind: string; assetKey?: string; x: number; y: number; z: number; onScreen: boolean }[];
  /** Advance the clock by hand so a floor can be finished without waiting. */
  tick: (seconds: number) => void;
  log: string[];
}

const view = document.getElementById('view') as HTMLElement;
const overlay = document.getElementById('overlay') as HTMLElement;
const hud = document.getElementById('hud') as HTMLElement;

const el = {
  floor: document.getElementById('hud-floor') as HTMLElement,
  found: document.getElementById('hud-found') as HTMLElement,
  total: document.getElementById('hud-total') as HTMLElement,
  time: document.getElementById('hud-time') as HTMLElement,
  marks: document.getElementById('hud-marks') as HTMLElement,
  toast: document.getElementById('hud-toast') as HTMLElement,
};

const debug: SplatDebug = {
  ready: false,
  stage: 'boot',
  error: null,
  collision: false,
  splat: false,
  spawn: ROOM_SPAWN,
  state: 'loading',
  floor: 1,
  score: 0,
  found: [],
  marksLeft: MAX_MISTAKES,
  timeLeft: 0,
  anomalyCount: 0,
  placed: 0,
  anchors: ROOM_ANCHORS.length,
  assets: { loaded: 0, missing: [] },
  player: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, speed: 0, locked: false },
  frames: 0,
  setKey: () => undefined,
  respawn: () => undefined,
  teleport: () => undefined,
  setCollision: () => undefined,
  setAutoRender: () => undefined,
  renderOnce: () => undefined,
  walk: () => ({ from: [0, 0, 0], to: [0, 0, 0] }),
  start: async () => undefined,
  mark: () => ({ result: 'miss', slotId: null, found: 0, marksLeft: MAX_MISTAKES, state: 'menu' }),
  aimAt: () => null,
  placements: () => [],
  tick: () => undefined,
  log: [],
};
(window as unknown as { __splat: SplatDebug }).__splat = debug;

/** Matches the overlay markup the three.js game uses, so both share its CSS. */
function panel(html: string): void {
  overlay.classList.remove('hidden');
  overlay.innerHTML = `<div class="panel">${html}</div>`;
}

function showProgress(fraction: number, label: string): void {
  const percent = Math.round(fraction * 100);
  panel(`
    <h1 class="title">FOREIGN<span class="sub">异物</span></h1>
    <p class="tagline">正在重建现场</p>
    <div class="progress"><div class="progress-bar" style="width:${percent}%"></div></div>
    <p class="progress-note">${label} · ${percent}%</p>
    <p class="progress-note dim">首次进入需下载约 63 MB 的重建场景</p>
  `);
}

function showFailure(message: string): void {
  panel(`
    <h1 class="title">FOREIGN<span class="sub">异物</span></h1>
    <p class="tagline">场景加载失败</p>
    <p class="progress-note bad">${message}</p>
    <p class="progress-note dim">检查网络后刷新页面重试</p>
  `);
}

/**
 * The one rule of this room, stated once.
 *
 * There is no baseline to memorise: the scan is fixed, so anything in here that
 * was not part of the apartment is the anomaly.
 */
function showMenu(assetLine: string, onStart: () => void): void {
  debug.state = 'menu';
  panel(`
    <h1 class="title">FOREIGN<span class="sub">异物</span></h1>
    <p class="tagline">
      这是一间被 3D 重建出来的<strong>真实房间</strong>。<br />
      它原本是什么样就永远是什么样 —— 所以<strong>多出来的东西</strong>，就是异常。<br />
      找到它们，但别乱点：<strong>你只有 ${MAX_MISTAKES} 次标记机会</strong>。
    </p>
    <div class="actions">
      <button id="start-btn" class="primary">进入现场</button>
    </div>
    <p class="progress-note dim">点击后锁定鼠标 · WASD 移动 · 左键标记 · Esc 释放</p>
    <p class="progress-note dim">${assetLine}</p>
  `);
  document.getElementById('start-btn')?.addEventListener('click', onStart);
}

function toast(message: string, kind: 'good' | 'bad' | 'info' = 'info'): void {
  el.toast.textContent = message;
  el.toast.className = `toast show ${kind}`;
  window.setTimeout(() => {
    el.toast.className = 'toast';
  }, 2600);
}

function syncHud(): void {
  el.floor.textContent = String(debug.floor);
  el.found.textContent = String(debug.found.length);
  el.total.textContent = String(debug.anomalyCount);
  el.time.textContent = formatClock(debug.timeLeft);
  el.time.classList.toggle('low', debug.timeLeft <= 30);
  el.marks.textContent = '●'.repeat(debug.marksLeft) || '—';
  el.marks.classList.toggle('low', debug.marksLeft <= 1);
}

async function main(): Promise<void> {
  debug.stage = 'viewer';
  showProgress(0, '初始化渲染器');
  const scene = SplatScene.create({
    container: view,
    onProgress: (fraction, label) => showProgress(fraction, label),
  });
  const room = new SplatRoom(scene.viewer.getScene());
  const player = new SplatPlayer(view);
  player.spawnAt(ROOM_SPAWN);

  debug.stage = 'splat';
  await scene.loadSplat();
  debug.splat = true;

  debug.stage = 'collision';
  try {
    await scene.loadCollision();
    player.setCollision(scene.collision);
    debug.collision = scene.collision !== null;
  } catch (error) {
    // The room still renders without collision; say so rather than dying.
    console.warn('[splat] collision unavailable', error);
  }
  player.respawn();

  // Preload every asset a floor could ask for, so a floor never stalls halfway.
  debug.stage = 'assets';
  showProgress(1, '载入异物');
  const report = await room.loadAssets(ASSET_KEYS);
  debug.assets = { loaded: report.loaded.length, missing: report.missing };

  debug.stage = 'ready';
  debug.ready = true;
  const assetLine = report.missing.length
    ? `未检测到 ${report.missing.length} 个资产的 Lux3D 原模型 · 正在使用烘焙占位模型`
    : `已载入 ${report.loaded.length} 个异物模型`;
  showMenu(assetLine, () => {
    void startFloor(1, undefined, true);
  });

  // The viewer owns its canvas, so cabling the layout is on us.
  function layout(): void {
    view.style.width = '100vw';
    view.style.height = '100vh';
    scene.resize();
  }
  layout();
  window.addEventListener('resize', layout);

  let plan: FloorPlan | null = null;

  async function startFloor(floor = 1, seed?: number, lock = false): Promise<void> {
    debug.floor = floor;
    debug.found = [];
    debug.marksLeft = MAX_MISTAKES;
    // A fixed seed keeps a floor reproducible from the URL; otherwise the floor
    // number itself seeds it, so floor 3 is always floor 3.
    plan = generateFloor(floor, seed ?? floor * 7919, ROOM_FLOOR_OPTIONS);
    debug.anomalyCount = plan.anomalies.length;
    debug.timeLeft = plan.duration;
    debug.state = 'playing';

    // Make sure anything this floor needs is present before it appears.
    await room.loadAssets(plan.anomalies.map((a) => a.assetKey ?? ''));
    const placed = await room.buildFloor(plan, ROOM_ANCHORS);
    debug.placed = placed.length;

    overlay.classList.add('hidden');
    overlay.innerHTML = '';
    hud.classList.remove('hidden');
    syncHud();
    if (lock) player.requestLock();
    scene.render();
  }

  function endRun(): void {
    debug.state = 'gameOver';
    panel(`
      <h1 class="title">FOREIGN<span class="sub">异物</span></h1>
      <p class="tagline">标记用完了，但房间里还有东西。</p>
      <div class="big-score">${debug.score}</div>
      <p class="score-line">到达第 <b>${debug.floor}</b> 层 · 找到 <b>${debug.found.length}</b> 个异物</p>
      <div class="actions"><button id="again-btn" class="primary">再来一次</button></div>
    `);
    document.getElementById('again-btn')?.addEventListener('click', () => {
      debug.score = 0;
      void startFloor(1, undefined, true);
    });
  }

  async function nextFloor(): Promise<void> {
    debug.state = 'floorClear';
    toast(`第 ${debug.floor} 层清理完毕`, 'good');
    await new Promise((resolve) => window.setTimeout(resolve, 900));
    await startFloor(debug.floor + 1);
    player.requestLock();
  }

  /** The single path a mark takes, whether from a click or the harness. */
  function mark(): MarkReport {
    const slotId = room.pick(scene.camera, scene.viewer.getSize().height);
    if (!plan || debug.state !== 'playing') {
      return { result: 'miss', slotId, found: debug.found.length, marksLeft: debug.marksLeft, state: debug.state };
    }

    const outcome = judgeMark(plan, slotId ?? '', debug.found);

    if (outcome.result === 'hit' && outcome.anomaly) {
      debug.found.push(outcome.anomaly.id);
      debug.score += hitScore(debug.timeLeft, plan.duration);
      toast(outcome.anomaly.label, 'good');
    } else if (outcome.result === 'repeat') {
      toast('这个你已经标记过了', 'info');
    } else {
      // A miss costs time *and* a mark: without the time cost, guessing at
      // random is free, and the game becomes a clicking exercise.
      debug.marksLeft -= 1;
      debug.timeLeft = Math.max(0, debug.timeLeft - 8);
      toast(slotId ? '这个属于这个房间' : '那里什么都没有', 'bad');
    }

    syncHud();

    if (debug.found.length >= plan.anomalies.length) {
      debug.score += Math.round(debug.timeLeft * 3) + 250 + debug.floor * 50;
      void nextFloor();
    } else if (debug.marksLeft <= 0) {
      endRun();
    }

    return {
      result: outcome.result,
      slotId,
      found: debug.found.length,
      marksLeft: debug.marksLeft,
      state: debug.state,
      label: outcome.anomaly?.label,
    };
  }

  view.addEventListener('click', () => {
    if (debug.state === 'playing') mark();
    else player.requestLock();
  });

  debug.setKey = (code, down) => player.setKey(code, down);
  debug.respawn = () => player.respawn();
  debug.setCollision = (enabled) => player.setCollision(enabled ? scene.collision : null);
  debug.start = startFloor;
  debug.mark = mark;

  /**
   * Advance the walker by a fixed simulated time at a fixed step, so a movement
   * assertion does not depend on the harness's frame pacing.
   */
  debug.walk = (seconds, code = 'KeyW') => {
    const from: [number, number, number] = [player.x, player.y, player.z];
    player.setKey(code, true);
    const step = 1 / 60;
    for (let elapsed = 0; elapsed < seconds; elapsed += step) player.update(step);
    player.setKey(code, false);
    debug.renderOnce();
    return { from, to: [player.x, player.y, player.z] };
  };
  debug.tick = (seconds) => {
    debug.timeLeft = Math.max(0, debug.timeLeft - seconds);
    syncHud();
    if (debug.timeLeft <= 0 && debug.state === 'playing') endRun();
  };

  debug.renderOnce = () => {
    scene.applyPose(player.cameraState());
    scene.render();
  };

  debug.teleport = (x, y, z, yaw, pitch) => {
    player.spawnAt({ x, y, z, yaw: yaw ?? player.yaw, pitch: pitch ?? player.pitch });
    debug.renderOnce();
  };

  debug.aimAt = (index) => {
    const target = room.placements[index];
    if (!target) return null;
    const eye = player.cameraState();
    const dx = target.node.position.x - eye.x;
    const dy = target.node.position.y + 0.5 - eye.y;
    const dz = target.node.position.z - eye.z;
    const horizontal = Math.hypot(dx, dz);
    // forward = (-sin yaw, 0, -cos yaw) in this build's convention
    player.spawnAt({
      x: eye.x,
      y: eye.y,
      z: eye.z,
      yaw: Math.atan2(-dx, -dz),
      pitch: Math.atan2(dy, horizontal),
    });
    debug.renderOnce();
    return target.slotId;
  };

  debug.placements = () =>
    room.placements.map((item) => {
      const state = player.cameraState();
      const dx = item.node.position.x - state.x;
      const dz = item.node.position.z - state.z;
      const yawTo = Math.atan2(-dx, -dz);
      let delta = yawTo - state.yaw;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      return {
        slotId: item.slotId,
        kind: item.anomaly.kind,
        assetKey: item.anomaly.assetKey,
        x: item.node.position.x,
        y: item.node.position.y,
        z: item.node.position.z,
        onScreen: Math.abs(delta) < 0.55,
      };
    });

  let autoRender = true;
  debug.setAutoRender = (enabled) => {
    autoRender = enabled;
  };

  let previous = performance.now();
  function frame(now: number): void {
    const dt = Math.min(0.05, (now - previous) / 1000);
    previous = now;
    player.update(dt);
    scene.applyPose(player.cameraState());
    if (autoRender) scene.render();

    if (debug.state === 'playing' && autoRender) {
      debug.timeLeft = Math.max(0, debug.timeLeft - dt);
      if (debug.timeLeft <= 0) endRun();
      else syncHud();
    }

    const state = player.cameraState();
    debug.player = {
      x: state.x,
      y: state.y,
      z: state.z,
      yaw: state.yaw,
      pitch: state.pitch,
      speed: player.speed,
      locked: player.isLocked,
    };
    debug.frames++;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

void main().catch((error: unknown) => {
  debug.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  debug.stage = 'failed';
  debug.state = 'failed';
  debug.ready = true;
  console.error('[splat]', error);
  showFailure(debug.error);
});
