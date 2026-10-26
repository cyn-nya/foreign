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
import {
  FINAL_FLOOR,
  MAX_MISTAKES,
  explainMiss,
  formatClock,
  generateFloor,
  hitScore,
  isFinalFloor,
  judgeMark,
} from '../game/rules.ts';
import type { AnomalyKind, FloorPlan } from '../game/types.ts';
import { SplatPlayer } from './SplatPlayer.ts';
import { SplatRoom } from './SplatRoom.ts';
import { GameAudio, type AudioReport } from './audio.ts';
import { ROOM_ANCHORS, ROOM_FLOOR_OPTIONS } from './roomAnchors.ts';
import { Box3, Vector3, type Object3D } from '@manycore/aholo-viewer';
import { ROOM_SPAWN, SplatScene } from './SplatScene.ts';
import { EYE_HEIGHT, HOVER_HEIGHT } from '../viewer/voxel.ts';

/**
 * Floors are built one at a time; see startFloor. Declared at module scope
 * because the autostart floor runs before the boot function reaches the
 * declaration, and a `let` inside it would throw on the temporal dead zone.
 */
let floorChain: Promise<void> = Promise.resolve();

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

type GameState = 'loading' | 'menu' | 'playing' | 'floorClear' | 'gameOver' | 'won' | 'failed';

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
  /**
   * Run totals, not floor totals.
   *
   * `found` is reset by every floor, so the end-of-run screen that read it
   * reported only the last floor's count — "found 6" after eight floors of
   * work. These accumulate across the run and reset when a new run starts.
   */
  foundTotal: number;
  mistakes: number;
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
  /** Look at an innocent object. Returns its slot id, for the miss assertion. */
  aimAtBystander: (index: number) => string | null;
  bystanderCount: number;
  /**
   * The watchers, with where each is looking and where it should be looking.
   * `yawError` is the whole mechanic in one number: it must stay at zero as the
   * player moves.
   */
  watchers: () => { slotId: string; x: number; z: number; yaw: number; expectedYaw: number; yawError: number; y: number; baseY: number; elapsed: number }[];
  /** The anchors, with a ready-to-use eye position, so a harness can stand somewhere. */
  crosshair: () => string | null;
  autoplay: () => GameState;
  setCulling: (patch: Record<string, boolean>) => void;
  culling: () => Record<string, boolean>;
  setSplatVisible: (visible: boolean) => void;
  fps: () => number | null;
  togglePerf: () => void;
  perfVisible: () => boolean;
  splatVisible: () => boolean;
  removeSplat: () => void;
  restoreSplat: () => void;
  splatPresent: () => boolean;
  setObjectsVisible: (visible: boolean) => void;
  lookBy: (dx: number, dy: number) => void;

  anchors: () => { id: string; floor: { x: number; y: number; z: number }; eye: { x: number; y: number; z: number } }[];
  /** Where each placed object is, in the room and on screen. */
  placements: () => { slotId: string; kind: string; assetKey?: string; x: number; y: number; z: number; rotX: number; scale: number; onScreen: boolean }[];
  /** Turn the camera by a mouse-sized delta. */
  look: (movementX: number, movementY: number) => void;
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
  perf: document.getElementById('hud-perf') as HTMLElement,
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
  foundTotal: 0,
  mistakes: 0,
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
  look: () => undefined,
  audioStart: () => false,
  audio: () => ({ state: 'none', gain: 0, rms: 0, tension: 0 }),
  proximity: () => ({ tension: 0, nearest: null }),
  start: async () => undefined,
  mark: () => ({ result: 'miss', slotId: null, found: 0, marksLeft: MAX_MISTAKES, state: 'menu' }),
  aimAt: () => null,
  aimAtBystander: () => null,
  bystanderCount: 0,
  watchers: () => [],
  crosshair: () => null,
  autoplay: () => 'menu',
  setCulling: () => undefined,
  culling: () => ({}),
  setSplatVisible: () => undefined,
  fps: () => null,
  togglePerf: () => undefined,
  perfVisible: () => false,
  splatVisible: () => false,
  removeSplat: () => undefined,
  restoreSplat: () => undefined,
  splatPresent: () => false,
  setObjectsVisible: () => undefined,
  lookBy: () => undefined,

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
      里面本来就摆着一些奇怪的模型 —— <strong>它们不是目标</strong>。<br />
      只有<strong>动了的</strong>才算：在看你、飘起来、多了几个、变了形、倒过来。<br />
      找到它们，但别乱点：<strong>你只有 ${MAX_MISTAKES} 次标记机会</strong>。
    </p>
    <div class="actions">
      <button id="start-btn" class="primary">进入现场</button>
    </div>
    <p class="progress-note dim">点击后锁定鼠标 · WASD 移动 · 左键标记 · Esc 释放</p>
    <p class="progress-note dim">${assetLine}</p>
  `);
  document.getElementById('start-btn')?.addEventListener('click', onStart);

  // F3 rather than the browser's own F12/devtools: the number has to be readable
  // by a player who is not going to open a console.
  window.addEventListener('keydown', (e) => {
    if (e.code === 'F3') {
      e.preventDefault();
      togglePerf();
    }
  });
}

function toast(message: string, kind: 'good' | 'bad' | 'info' = 'info'): void {
  el.toast.textContent = message;
  el.toast.className = `toast show ${kind}`;
  window.setTimeout(() => {
    el.toast.className = 'toast';
  }, 2600);
}

/**
 * Live frame rate, for measuring the one thing this machine cannot.
 *
 * Every performance number this repository produces comes from headless
 * software rasterisation, where an empty room already runs at 0.5-1.8 fps — so
 * the harness cannot see the game's real cost and the earlier optimisation work
 * was reading noise. The only trustworthy measurement is the player's own
 * machine, so the game has to be able to report it.
 *
 * The frame deltas are kept as a window rather than averaged from the start, so
 * the number describes now: a room that hitches when a floor appears has to show
 * the hitch, not an average that hides it.
 */
const PERF_WINDOW_MS = 5_000;
const MAX_PERF_SAMPLES = 600;
const frameTimes: number[] = [];
let perfVisible = false;
let perfAccumulator = 0;

/**
 * Timestamps, not deltas, and the window is in milliseconds.
 *
 * A 60-frame window sounds like "the last second" only while the loop is fast.
 * At two frames per second it spans half a minute and at 0.3 fps it spans three
 * minutes, so the counter spent a stalled floor reporting the frame rate from
 * before the floor loaded — it read 25.9 fps while one frame was taking 1.28 s.
 * A frame-count window cannot describe "now" when the thing it measures is
 * allowed to be arbitrarily slow.
 */
function recordFrame(now: number): void {
  frameTimes.push(now);
  if (frameTimes.length > MAX_PERF_SAMPLES) frameTimes.shift();
}

/**
 * Frames completed in the last few seconds, and the slowest of them.
 *
 * Sustained rate over the window, not the gap between the first and last frame
 * in it. Those differ exactly when the loop is unhealthy: with two frames 49 ms
 * apart at the end of a five-second window and nothing before them, dividing by
 * the span reports 20.4 fps for a loop that managed two frames in five seconds.
 * Dividing by the window reports 0.4 fps, which is what happened.
 */
function recentFrames(): { fps: number; worstMs: number; count: number } {
  if (frameTimes.length < 2) return { fps: 0, worstMs: 0, count: frameTimes.length };
  const newest = frameTimes[frameTimes.length - 1];
  const from = newest - PERF_WINDOW_MS;
  const recent = frameTimes.filter((t) => t >= from);
  if (recent.length < 2) return { fps: 0, worstMs: 0, count: recent.length };
  // The window is the full span, or the whole history while it is still shorter
  // than one window — otherwise the first second after load reads as a spike.
  const oldest = Math.max(frameTimes[0], from);
  const elapsed = (newest - oldest) / 1000;
  let worst = 0;
  for (let i = 1; i < recent.length; i++) worst = Math.max(worst, recent[i] - recent[i - 1]);
  const intervals = recent.length - 1;
  return {
    fps: elapsed > 0 ? intervals / elapsed : 0,
    worstMs: worst,
    count: recent.length,
  };
}

/**
 * Frame rate over the last few seconds.
 *
 * Zero means "fewer than two frames in five seconds" — which is a reading, not a
 * missing one, and a much more useful thing to print than a plausible number
 * carried over from when the room was still loading.
 */
export function currentFps(): number | null {
  if (frameTimes.length < 2) return null;
  return recentFrames().fps;
}

function togglePerf(): void {
  perfVisible = !perfVisible;
  el.perf.classList.toggle('hidden', !perfVisible);
  if (perfVisible) paintPerf();
}

function paintPerf(): void {
  if (!perfVisible) return;
  const fps = currentFps();
  const { worstMs, count } = recentFrames();
  // `debug.frames` is the total, so a stalled loop is visible as a number that
  // never moves rather than as a number that reads plausibly.
  const value = fps === null ? '—' : fps.toFixed(1);
  el.perf.textContent =
    `${value} fps   最慢 ${worstMs.toFixed(0)} ms   帧 ${debug.frames}　近 5 秒 ${count} 帧` +
    `\n${debug.placed} 模型 · 扫描 ${debug.splatPresent() ? '在' : '移除'}`;
  const tone = fps === null ? '' : fps < 15 ? 'bad' : fps < 30 ? 'warn' : '';
  el.perf.className = `perf${tone ? ` ${tone}` : ''}`;
}

function syncHud(): void {
  el.floor.textContent = `${debug.floor}/${FINAL_FLOOR}`;
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

  // Retry the room before giving up on it.
  //
  // This is a 63 MB download over whatever connection the player has, and it
  // used to be a single attempt: one dropped transfer ended the session on a
  // failure screen, which is the one outcome a player cannot recover from by
  // playing differently. Seen in practice — two loads in one harness run, on a
  // throttled connection, failed exactly here. Bounded at three, because each
  // attempt restarts the transfer and there is no point pretending otherwise.
  // Read before the splat loads, because `?sh=` decides how the scan is parsed.
  const params = new URLSearchParams(window.location.search);
  const requestedFloor = Number(params.get('floor') ?? Number.NaN);
  const requestedSeed = Number(params.get('seed') ?? Number.NaN);
  // `?sh=` trades view-dependent highlights for frame rate. Absent means the
  // default; 0-3 are the legal band counts.
  const requestedSh = Number(params.get('sh') ?? Number.NaN);

  debug.stage = 'splat';
  let splatError: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await scene.loadSplat(
        undefined,
        undefined,
        Number.isFinite(requestedSh) ? requestedSh : undefined,
      );
      splatError = null;
      break;
    } catch (error) {
      splatError = error;
      if (attempt === 3) break;
      console.warn(`[splat] room load failed (attempt ${attempt})`, error);
      showProgress(0, `房间加载失败，正在重试 ${attempt}/2…`);
      await new Promise((resolve) => window.setTimeout(resolve, 800 * attempt));
    }
  }
  if (splatError) throw splatError;
  debug.splat = true;

  debug.stage = 'collision';
  // Retried for the same reason as the room, and conceded only as a last
  // resort: without the occupancy field the room renders and the game plays,
  // but the player walks through the walls. That is worse than a retry.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await scene.loadCollision();
      player.setCollision(scene.collision);
      debug.collision = scene.collision !== null;
      break;
    } catch (error) {
      console.warn(`[splat] collision unavailable (attempt ${attempt})`, error);
      if (attempt === 3) break;
      await new Promise((resolve) => window.setTimeout(resolve, 800 * attempt));
    }
  }
  player.respawn();

  // Preload every asset a floor could ask for, so a floor never stalls halfway.
  debug.stage = 'assets';
  showProgress(1, '载入异物');
  const report = await room.loadAssets(ASSET_KEYS);
  debug.assets = { loaded: report.loaded.length, missing: report.missing };

  // Neither `ready` nor `stage === 'ready'` is announced here — both mean "a
  // harness can drive the game now", and it cannot yet. `debug.start`,
  // `debug.watchers` and `debug.anchors` are still the stubs declared with the
  // debug object, so a check that waits on `ready` and then calls `s.start(...)`
  // gets a function that quietly does nothing and reads back the empty room from
  // before the first floor was built. Both flags are set at the end of the boot.
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

  /**
   * Floors are built one at a time.
   *
   * Every build ends by clearing the room, so two in flight at once race: the
   * second clears, the first finishes placing into the cleared scene, and the
   * result is an empty room that reports success. The autostart floor made this
   * reachable on every load — it is fired without being awaited — and clicking
   * "next floor" twice does the same thing. Queueing costs nothing here because
   * a floor build is already seconds long.
   */
  async function startFloor(floor = 1, seed?: number, lock = false, kinds?: AnomalyKind[]): Promise<void> {
    const previous = floorChain;
    let release!: () => void;
    floorChain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      await buildFloorNow(floor, seed, lock, kinds);
    } finally {
      release();
    }
  }

  async function buildFloorNow(floor = 1, seed?: number, lock = false, kinds?: AnomalyKind[]): Promise<void> {
    debug.floor = floor;
    debug.found = [];
    debug.marksLeft = MAX_MISTAKES;
    // Floor 1 is a new run; every later floor is a continuation of it.
    if (floor === 1) {
      debug.foundTotal = 0;
      debug.mistakes = 0;
    }
    // A fixed seed keeps a floor reproducible from the URL; otherwise the floor
    // number itself seeds it, so floor 3 is always floor 3.
    const options = kinds ? { ...ROOM_FLOOR_OPTIONS, kinds } : ROOM_FLOOR_OPTIONS;
    plan = generateFloor(floor, seed ?? floor * 7919, options);
    debug.anomalyCount = plan.anomalies.length;
    debug.timeLeft = plan.duration;
    debug.state = 'playing';

    // Make sure anything this floor needs is present before it appears.
    await room.loadAssets([
      ...plan.anomalies.map((a) => a.assetKey ?? ''),
      ...plan.bystanders.map((b) => b.assetKey),
    ]);
    const placed = await room.buildFloor(plan, ROOM_ANCHORS);
    debug.placed = placed.length;
    debug.bystanderCount = plan.bystanders.length;
    await room.buildBystanders(plan, ROOM_ANCHORS);

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
    if (isFinalFloor(debug.floor)) {
      winRun();
      return;
    }
    await startFloor(debug.floor + 1);
    player.requestLock();
  }

  /**
   * Clearing the last floor.
   *
   * Deliberately not `endRun` with different words: that screen is the failure
   * state, and the whole point of a win condition is that the player can tell
   * the two apart without reading carefully.
   */
  function winRun(): void {
    debug.state = 'won';
    player.releaseLock();
    const missed = debug.mistakes;
    panel(`
      <h1 class="title">FOREIGN<span class="sub">异物</span></h1>
      <p class="tagline">找到了出口。这里一共有 ${FINAL_FLOOR} 层，你都活着走出来了。</p>
      <div class="big-score">${debug.score}</div>
      <p class="score-line">${FINAL_FLOOR} 层全清 · 找到 <b>${debug.foundTotal}</b> 个异物 · 标记失手 <b>${missed}</b> 次</p>
      <div class="actions"><button id="again-btn" class="primary">再来一次</button></div>
    `);
    document.getElementById('again-btn')?.addEventListener('click', () => {
      debug.score = 0;
      debug.mistakes = 0;
      void startFloor(1, undefined, true);
    });
  }

  /**
   * What happens once a mark has been judged: the floor is done, or out of marks.
   *
   * Split out of `mark` so the acceptance harness can drive the *completion* path
   * without also having to aim. Aiming is covered by its own checks; this is the
   * ending, and testing it through a raycast made the ending look broken when
   * only the harness's aim was.
   */
  function settle(): void {
    if (!plan) return;
    if (debug.found.length >= plan.anomalies.length) {
      debug.score += Math.round(debug.timeLeft * 3) + 250 + debug.floor * 50;
      void nextFloor();
    } else if (debug.marksLeft <= 0) {
      endRun();
    }
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
      debug.foundTotal += 1;
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
      debug.mistakes += 1;
      debug.timeLeft = Math.max(0, debug.timeLeft - 8);
      audio.sting('miss');
      toast(explainMiss(plan, slotId), 'bad');
    }

    syncHud();
    settle();


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

  debug.look = (dx, dy) => player.look(dx, dy);
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

  /**
   * Aim at an object's real centre, not at its origin plus a guess.
   *
   * The origin of a GLB is its base, so the old `position.y + 0.5` was tuned for
   * things standing on the floor. A 'stare' floats 1.15–1.85 m up, and half a
   * metre above *that* is over the top of it — the ray sailed past and landed on
   * whatever stood behind, which is how marking an innocent object came back as a
   * hit on an anomaly the player could not see. The bounding box is the honest
   * answer for a floating object and a grounded one alike.
   */
  function aimAtNode(node: Object3D): void {
    let x = node.position.x;
    let y = node.position.y;
    let z = node.position.z;
    try {
      const box = new Box3().setFromObject(node);
      // An empty box has no centre. The viewer reports (0,0,0) for one, which is
      // finite and finite-looking, so a plain isFinite check accepted it and the
      // camera got aimed at the world origin instead of at the object — the ray
      // then landed on whatever else happened to be there. A real centre is also
      // near the object's own origin; anything further is the same failure.
      if (!box.isEmpty()) {
        const centre = box.getCenter(new Vector3());
        const sane =
          Number.isFinite(centre.x) &&
          Number.isFinite(centre.y) &&
          Number.isFinite(centre.z) &&
          Math.hypot(centre.x - x, centre.y - y, centre.z - z) < 4;
        if (sane) {
          x = centre.x;
          y = centre.y;
          z = centre.z;
        }
      }
    } catch {
      // A subtree the viewer cannot measure is still aimed at by its origin.
    }
    lookAt(x, y, z);
  }

  /** Point the player's head at a world position, keeping their feet where they are. */
  function lookAt(x: number, y: number, z: number): void {
    const eye = player.cameraState();
    const dx = x - eye.x;
    const dy = y - eye.y;
    const dz = z - eye.z;
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
  }

  debug.teleport = (x, y, z, yaw, pitch) => {
    player.spawnAt({ x, y, z, yaw: yaw ?? player.yaw, pitch: pitch ?? player.pitch });
    debug.renderOnce();
  };

  debug.aimAt = (index) => {
    const target = room.placements[index];
    if (!target) return null;
    aimAtNode(target.node);
    return target.slotId;
  };

  debug.aimAtBystander = (index) => {
    const target = room.bystanders[index];
    if (!target) return null;
    aimAtNode(target.node);
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

  /** What the crosshair is on right now, without spending a mark. */
  debug.crosshair = () => room.pick(scene.camera, scene.viewer.getSize().height);
  /**
   * Find every remaining anomaly and run the real completion path.
   *
   * Marks nothing through the raycast on purpose — the acceptance run could not
   * aim at every anomaly, and `mark` returning early for the unreachable ones
   * made the ending untestable. This exercises `settle`, which is what decides
   * whether the run continues, wins or ends.
   */
  debug.autoplay = () => {
    if (!plan || debug.state !== 'playing') return debug.state;
    for (const anomaly of plan.anomalies) {
      if (debug.found.includes(anomaly.id)) continue;
      debug.found.push(anomaly.id);
      debug.foundTotal += 1;
    }
    syncHud();
    settle();
    return debug.state;
  };

  /** Measure the room without a floor in the way, for the performance work. */
  debug.setCulling = (patch) => scene.setCulling(patch);
  debug.culling = () => scene.culling;
  debug.setSplatVisible = (visible) => scene.setSplatVisible(visible);
  debug.fps = () => currentFps();
  debug.togglePerf = () => togglePerf();
  debug.perfVisible = () => perfVisible;
  debug.splatVisible = () => scene.splatVisible;
  debug.removeSplat = () => scene.removeSplat();
  debug.restoreSplat = () => scene.restoreSplat();
  debug.splatPresent = () => scene.splatPresent;
  /** Hide the placed models too, so their cost can be separated from the scan's. */
  debug.setObjectsVisible = (visible) => room.setVisible(visible);
  /** Move the camera without the collision walker, to separate move from idle. */
  debug.lookBy = (dx, dy) => {
    player.look(dx, dy);
    debug.renderOnce();
  };


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
    // Two different numbers, and conflating them made the frame counter lie.
    // `dt` is clamped so a long stall cannot teleport the player through a wall;
    // the raw delta is what the frame actually took. Recording `dt` reported
    // 51.4 fps while the loop was managing two frames in three seconds, because
    // every stalled frame was recorded as exactly the 50 ms ceiling.
    const rawDt = (now - previous) / 1000;
    const dt = Math.min(0.05, rawDt);
    previous = now;
    recordFrame(now);
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
    perfAccumulator += rawDt;
    if (perfAccumulator >= 0.25) {
      perfAccumulator = 0;
      paintPerf();
    }
    requestAnimationFrame(frame);
  }
  // Announced only here, and deliberately not earlier. `stage === 'ready'` is
  // what every harness waits for; the debug accessors above are assigned after
  // the viewer is constructed, so setting this at the top of the boot handed
  // out stub functions that silently did nothing — an acceptance run that
  // raced the rest of the boot and reported an empty room.
  debug.stage = 'ready';
  debug.ready = true;

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
