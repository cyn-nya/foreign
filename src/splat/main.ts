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
import type { AnomalyKind, FloorPlan } from '../game/types.ts';
import { SplatPlayer } from './SplatPlayer.ts';
import { SplatRoom } from './SplatRoom.ts';
import { GameAudio, type AudioReport } from './audio.ts';
import { ROOM_ANCHORS, ROOM_FLOOR_OPTIONS } from './roomAnchors.ts';
import { ROOM_SPAWN, SplatScene } from './SplatScene.ts';
import { EYE_HEIGHT, HOVER_HEIGHT } from '../viewer/voxel.ts';

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
  anchorCount: number;
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
  start: (floor?: number, seed?: number, lock?: boolean, kinds?: AnomalyKind[]) => Promise<void>;
  /** Mark whatever the crosshair is on — the same path a click takes. */
  mark: () => MarkReport;
  /** Aim the camera at one of the placed objects. Returns its slot id. */
  aimAt: (index: number) => string | null;
  /**
   * The watchers, with where each is looking and where it should be looking.
   * `yawError` is the whole mechanic in one number: it must stay at zero as the
   * player moves.
   */
  watchers: () => { slotId: string; x: number; z: number; yaw: number; expectedYaw: number; yawError: number; y: number; baseY: number; elapsed: number }[];
  /** The anchors, with a ready-to-use eye position, so a harness can stand somewhere. */
  anchors: () => { id: string; floor: { x: number; y: number; z: number }; eye: { x: number; y: number; z: number } }[];
  /** Where each placed object is, in the room and on screen. */
  placements: () => { slotId: string; kind: string; assetKey?: string; x: number; y: number; z: number; rotX: number; scale: number; onScreen: boolean }[];
  /** Advance the clock by hand so a floor can be finished without waiting. */
  tick: (seconds: number) => void;
  /** Start audio. A gesture starts it in a real browser; a harness has to ask. */
  audioStart: () => boolean;
  audio: () => AudioReport;
  /** The proximity the drone is running at, and the distance behind it. */
  proximity: () => { tension: number; nearest: number | null };
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
  anchorCount: ROOM_ANCHORS.length,
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
  audioStart: () => false,
  audio: () => ({ state: 'none', gain: 0, rms: 0, tension: 0 }),
  proximity: () => ({ tension: 0, nearest: null }),
  start: async () => undefined,
  mark: () => ({ result: 'miss', slotId: null, found: 0, marksLeft: MAX_MISTAKES, state: 'menu' }),
  aimAt: () => null,
  watchers: () => [],
  anchors: () => [],
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
  const audio = new GameAudio();
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

  /**
   * The current floor's plan.
   *
   * Declared up here rather than next to `startFloor` because the autostart path
   * calls `startFloor` *synchronously* from `main`, and a `let` declared further
   * down is still in its temporal dead zone at that moment — which threw
   * `Cannot access 'plan' before initialization` and broke every demo link. The
   * menu path hid it, because a button handler runs after `main` has finished.
   */
  let plan: FloorPlan | null = null;

  // `?autostart=1` skips the menu, so a demo link opens straight into the room.
  // `?floor=` and `?seed=` make a specific floor reproducible for a screenshot.
  const params = new URLSearchParams(window.location.search);
  const requestedFloor = Number(params.get('floor') ?? Number.NaN);
  const requestedSeed = Number(params.get('seed') ?? Number.NaN);
  if (params.get('autostart') === '1') {
    await startFloor(
      Number.isFinite(requestedFloor) && requestedFloor > 0 ? requestedFloor : 1,
      Number.isFinite(requestedSeed) ? requestedSeed : undefined,
    );
  } else {
    showMenu(assetLine, () => {
      void startFloor(1, undefined, true);
    });
  }

  // The viewer owns its canvas, so cabling the layout is on us.
  function layout(): void {
    view.style.width = '100vw';
    view.style.height = '100vh';
    scene.resize();
  }
  layout();
  window.addEventListener('resize', layout);

  async function startFloor(floor = 1, seed?: number, lock = false, kinds?: AnomalyKind[]): Promise<void> {
    debug.floor = floor;
    debug.found = [];
    debug.marksLeft = MAX_MISTAKES;
    // A fixed seed keeps a floor reproducible from the URL; otherwise the floor
    // number itself seeds it, so floor 3 is always floor 3.
    const options = kinds ? { ...ROOM_FLOOR_OPTIONS, kinds } : ROOM_FLOOR_OPTIONS;
    plan = generateFloor(floor, seed ?? floor * 7919, options);
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
    // A gesture has usually just happened (the start button); on an autostart
    // link there has not been one, so the context may stay suspended until the
    // player clicks. Either way the game is playable.
    audio.ensure();
    // Each floor starts back at the way in, as the procedural game does — the
    // fiction is descending, and it also stops a lucky end-of-floor position
    // from trivialising the next one.
    player.respawn();
    debug.renderOnce();
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
      audio.sting('hit');
      toast(outcome.anomaly.label, 'good');
    } else if (outcome.result === 'repeat') {
      audio.sting('repeat');
      toast('这个你已经标记过了', 'info');
    } else {
      // A miss costs time *and* a mark: without the time cost, guessing at
      // random is free, and the game becomes a clicking exercise.
      debug.marksLeft -= 1;
      debug.timeLeft = Math.max(0, debug.timeLeft - 8);
      audio.sting('miss');
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

  /**
   * How close the nearest anomaly is, as 0..1.
   *
   * The drone is the only channel that tells the player they are getting warm
   * without telling them where the thing is, which is the difference between a
   * search and a waypoint marker.
   */
  const AUDIO_RANGE = 6.0;
  function proximity(): { tension: number; nearest: number | null } {
    const eye = player.cameraState();
    let nearest: number | null = null;
    for (const item of room.placements) {
      const d = Math.hypot(item.node.position.x - eye.x, item.node.position.z - eye.z);
      if (nearest === null || d < nearest) nearest = d;
    }
    if (nearest === null) return { tension: 0, nearest: null };
    const tension = Math.max(0, Math.min(1, 1 - nearest / AUDIO_RANGE));
    return { tension, nearest };
  }

  debug.audioStart = () => audio.ensure();
  debug.audio = () => audio.read();
  debug.proximity = () => proximity();

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
    // Re-aim the watchers as part of producing a frame, so a single rendered
    // frame is always self-consistent rather than one frame stale.
    room.update(0, player.cameraState());
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

  debug.watchers = () =>
    room.placements
      .filter((item) => item.watches)
      .map((item) => {
        const eye = player.cameraState();
        const dx = eye.x - item.node.position.x;
        const dz = eye.z - item.node.position.z;
        const expectedYaw = Math.atan2(dx, dz);
        let error = item.node.rotation.y - expectedYaw;
        while (error > Math.PI) error -= Math.PI * 2;
        while (error < -Math.PI) error += Math.PI * 2;
        return {
          slotId: item.slotId,
          x: item.node.position.x,
          z: item.node.position.z,
          yaw: item.node.rotation.y,
          expectedYaw,
          yawError: error,
          y: item.node.position.y,
          baseY: item.baseY,
          elapsed: room.elapsed,
        };
      });

  debug.anchors = () =>
    ROOM_ANCHORS.map((anchor) => ({
      id: anchor.id,
      floor: { x: anchor.pos.x, y: anchor.pos.y, z: anchor.pos.z },
      eye: { x: anchor.pos.x, y: anchor.pos.y + EYE_HEIGHT + HOVER_HEIGHT, z: anchor.pos.z },
    }));

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
        rotX: item.node.rotation.x,
        scale: item.node.scale.x,
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
    // The room animates against the player's eye: what watches you has to be
    // updated before the frame is drawn, or it lags a frame behind.
    room.update(dt, player.cameraState());
    if (debug.state === 'playing') {
      const near = proximity();
      audio.setTension(near.tension);
    }
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
