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
  durationForFloor,
  formatClock,
  generateFloor,
  hitScore,
  isFinalFloor,
  judgeMark,
  type MarkOutcome,
} from '../game/rules.ts';
import { assetsWithHorrorTag, type ForeignAsset } from '../game/catalog.ts';
import type { AnomalyKind, FloorPlan } from '../game/types.ts';
import { SplatPlayer } from './SplatPlayer.ts';
import { SplatRoom } from './SplatRoom.ts';
import { GameAudio, type AudioReport } from './audio.ts';
import { ROOM_ANCHORS, ROOM_FLOOR_OPTIONS } from './roomAnchors.ts';
import { Box3, Vector3, type Object3D } from '@manycore/aholo-viewer';
import { ROOM_SPAWN, SplatScene } from './SplatScene.ts';
import { EYE_HEIGHT, HOVER_HEIGHT } from '../viewer/voxel.ts';
import {
  darknessForFloor,
  pickScareKind,
  SCARE_KIND_MS,
  scareKindsFor,
  nextScareDelay,
  torchFlickerForFloor,
  torchRadiusForFloor,
  type ScareKind,
  chargeWindowForFloor,
  chargeChanceForFloor,
  chargeModelsForFloor,
} from './horror.ts';
import { summariseFrames } from './framerate.ts';
import {
  evaluateQuality,
  initialQuality,
  pixelRatioForLevel,
  QUALITY_LEVELS,
  qualityLabel,
} from './quality.ts';

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

type GameState = 'loading' | 'menu' | 'playing' | 'paused' | 'floorClear' | 'gameOver' | 'won' | 'failed';

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
  /**
   * How strange a catalogue asset is: 0 is household furniture, 3 is horror.
   *
   * Exposed so the acceptance run can assert the property the game rests on —
   * that the room's furniture and its intruders are disjoint sets — against the
   * real catalogue rather than against a copy of it kept in the harness.
   */
  assetWeirdness: (key: string) => number | null;
  /** The horror role a model was generated for, or null. */
  assetHorrorTag: (key: string) => string | null;
  /**
   * What the frame-rate counter is actually looking at.
   *
   * Exposed so a disagreement between the counter and the frame counter can be
   * diagnosed instead of argued about: `samples` is how much history exists and
   * `spanMs` is the window it divided by.
   */
  perfWindow: () => { samples: number; spanMs: number; intervals: number; historyMs: number };
  /**
   * The adaptive render resolution: its level, the multiplier actually applied,
   * and whether the controller is still steering it.
   */
  /** The briefing text with its markup stripped, so a test can read the words. */
  briefing: () => string;
  quality: () => { level: number; ratio: number; auto: boolean; changes: number };
  /** Pin the resolution at a level, or pass "auto" to hand it back. */
  setQuality: (level: number | 'auto') => { level: number; ratio: number; auto: boolean; changes: number };
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
  scare: (intensity?: number) => void;
  audioScares: () => number | null;
  scareCount: () => number;
  setScaresEnabled: (on: boolean) => void;
  scaresEnabled: () => boolean;
  setTorch: (on: boolean) => void;
  torchOn: () => boolean;
  darkness: () => number;
  scareFaceShowing: () => boolean;
  /** Fire a charge by hand, and ask what became of it. */
  charge: () => void;
  chargeActive: () => boolean;
  defuseCharge: () => boolean;
  charges: () => { defused: number; missed: number };
  /**
   * The model crossing the room, or null.
   *
   * Separate from `chargeActive` because the overlay fallback makes both look identical on
   * screen. This is the only way to assert that a model was actually spawned.
   */
  charger: () => { key: string; distance: number; travelled: number; reached: boolean } | null;
  /** One step of the charge, through the rule the frame loop uses. */
  stepCharge: (dt: number) => { key: string; distance: number; travelled: number; reached: boolean } | null;
  /** Which fright is on screen, or null. */
  scareKind: () => string | null;
  /** Every fright kind this floor may deal. */
  scareKinds: () => string[];
  sinceScare: () => number;
  scareAfter: () => number;
  torchStyle: () => { inner: string; outer: string; dark: string; background: string };
  togglePerf: () => void;
  perfVisible: () => boolean;
  splatVisible: () => boolean;
  removeSplat: () => void;
  restoreSplat: () => void;
  splatPresent: () => boolean;
  canvasSize: () => { width: number; height: number } | null;
  renderBudget: () => { ratio: number; sortMs: number };
  setSortInterval: (ms: number) => void;
  applySplatPatch: (patch: Record<string, unknown>) => void;
  setSplatsVisible: (on: boolean) => void;
  setPixelRatio: (ratio: number) => void;
  setObjectsVisible: (visible: boolean) => void;
  lookBy: (dx: number, dy: number) => void;

  anchors: () => { id: string; floor: { x: number; y: number; z: number }; eye: { x: number; y: number; z: number } }[];
  /** Where each placed object is, in the room and on screen. */
  placements: () => { slotId: string; kind: string; assetKey?: string; x: number; y: number; z: number; rotX: number; scale: number; onScreen: boolean }[];
  /** Turn the camera by a mouse-sized delta. */
  look: (movementX: number, movementY: number) => void;
  /** Advance the clock by hand so a floor can be finished without waiting. */
  tick: (seconds: number) => void;
  /** Spend run clock through the real pause gate. Refused while paused. */
  frame: (dt: number) => { state: GameState; before: number; after: number };
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
const dark = document.getElementById('dark') as HTMLElement;
const scareLayer = document.getElementById('scare') as HTMLElement;

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
  assetWeirdness: () => null,
  assetHorrorTag: () => null,
  perfWindow: () => ({ samples: 0, spanMs: 0, intervals: 0, historyMs: 0 }),
  briefing: () => '',
  quality: () => ({ level: 0, ratio: 1, auto: false, changes: 0 }),
  setQuality: () => ({ level: 0, ratio: 1, auto: false, changes: 0 }),
  bystanderCount: 0,
  watchers: () => [],
  crosshair: () => null,
  autoplay: () => 'menu',
  setCulling: () => undefined,
  culling: () => ({}),
  setSplatVisible: () => undefined,
  fps: () => null,
  scare: () => undefined,
  audioScares: () => null,
  scareCount: () => 0,
  setScaresEnabled: () => undefined,
  scaresEnabled: () => false,
  setTorch: () => undefined,
  torchOn: () => false,
  darkness: () => 0,
  scareFaceShowing: () => false,
  charge: () => undefined,
  chargeActive: () => false,
  defuseCharge: () => false,
  charges: () => ({ defused: 0, missed: 0 }),
  charger: () => null,
  stepCharge: () => null,
  scareKind: () => null,
  scareKinds: () => ['flash'],
  sinceScare: () => 0,
  scareAfter: () => 0,
  torchStyle: () => ({ inner: '', outer: '', dark: '', background: '' }),
  togglePerf: () => undefined,
  perfVisible: () => false,
  splatVisible: () => false,
  removeSplat: () => undefined,
  restoreSplat: () => undefined,
  splatPresent: () => false,
  canvasSize: () => null,
  renderBudget: () => ({ ratio: 1, sortMs: 0 }),
  setSortInterval: () => undefined,
  applySplatPatch: () => undefined,
  setSplatsVisible: () => undefined,
  setPixelRatio: () => undefined,
  setObjectsVisible: () => undefined,
  lookBy: () => undefined,

  anchors: () => [],
  placements: () => [],
  tick: () => undefined,
  frame: () => ({ state: 'menu' as GameState, before: 0, after: 0 }),
  log: [],
};
(window as unknown as { __splat: SplatDebug }).__splat = debug;

/** Matches the overlay markup the three.js game uses, so both share its CSS. */
/**
 * The keyboard controls.
 *
 * These used to be registered inside `showMenu`, which meant they only existed when
 * the menu had been rendered. The acceptance harness — and every `?autostart=1`
 * demo link — start a floor directly, so in those sessions F3, the torch key and the
 * quality keys did nothing at all. The acceptance check caught it as "the events
 * arrived but the state did not change", which is exactly what it was: a control
 * wired to the wrong lifetime. Registering once, when the scene exists, is the fix.
 */
function installKeys(): void {
  window.addEventListener('keydown', (e) => {
    if (e.code === 'F3') {
      e.preventDefault();
      togglePerf();
    }
    if (e.code === 'KeyF' && !e.repeat) {
      e.preventDefault();
      setTorch(!torchOn);
    }

    // The resolution is the one performance lever this game has, and it was proved
    // to be: `npm run bench:render` measures 0.40x at 34% less time per frame than
    // 1.00x. The controller moves it on its own, but a player on a machine the
    // controller has misjudged -- or who simply prefers a sharper picture and a
    // lower rate -- should not have to wait for it. Five keys, and the ratio is
    // printed rather than a word like "low", because the number is the thing that
    // can be reported back.
    const digit = /^Digit([1-9])$/.exec(e.code);
    if (digit && !e.repeat) {
      const level = Number(digit[1]) - 1;
      if (level < QUALITY_LEVELS.length) {
        e.preventDefault();
        setQualityLevel(level);
        toast(
          `画质 ${level + 1}/${QUALITY_LEVELS.length} · 分辨率 ${pixelRatioForLevel(level).toFixed(2)}×`,
          'info',
        );
      }
    }
    if (e.code === 'Digit0' && !e.repeat) {
      e.preventDefault();
      setQualityLevel('auto');
      toast('画质自动', 'info');
    }
  });
}
function panel(html: string): void {
  overlay.classList.remove('hidden');
  overlay.innerHTML = `<div class="panel">${html}</div>`;
}

/** Take the overlay away, so the room is visible again. */
function hidePanel(): void {
  overlay.classList.add('hidden');
  overlay.innerHTML = '';
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
 *
 * "Not part of the apartment" is two separate mistakes, and the player has to be
 * told both, because they look nothing alike. Something that should not exist at
 * all is an object the room never contained; furniture doing what furniture
 * cannot is the *same* objects the player has already seen, behaving wrongly.
 *
 * This text has been wrong once already. It described the room contents as strange
 * models and said only things that moved were targets — true before the household
 * split, and afterwards an instruction to ignore the anomaly a player is most
 * likely to miss. Prose about a mechanic rots silently when the mechanic changes
 * underneath it, so the acceptance harness asserts both cases are named here.
 */
/**
 * The briefing, as a string, separate from the panel that displays it.
 *
 * The harness asserts on these words. It has to be able to, because the way this
 * text fails is silently: the mechanic changes underneath it and the instruction
 * keeps describing the old game, which no amount of testing the mechanic will
 * catch. Kept as a function so both the menu and `debug.briefing()` render the
 * same thing rather than two copies that drift.
 */
function briefingHtml(): string {
  return `
      这是一间被 3D 重建出来的<strong>真实房间</strong>。<br />
      里面摆着的家具都是真的、也都正常 —— <strong>它们不是目标</strong>。<br />
      要标记的只有两种：<strong>根本不该存在的</strong>（凭空多出来、不是家具的玩意），<br />
      和<strong>家具做了家具做不到的事</strong>（浮起来、倒挂、变形、忽然变成一群）。<br />
      打中不扣次数，<strong>打错才扣</strong>：你只有 ${MAX_MISTAKES} 次失手机会，每次还罚 8 秒。<br />
      <span class="hint">画面不流畅就按 <strong>1</strong>–<strong>5</strong> 调画质（5 最清晰，0 交回自动），
      按 <strong>F3</strong> 看帧率。</span>`;
}

function showMenu(assetLine: string, onStart: () => void): void {
  debug.state = 'menu';
  panel(`
    <h1 class="title">FOREIGN<span class="sub">异物</span></h1>
    <p class="tagline">${briefingHtml()}</p>
    <div class="actions">
      <button id="start-btn" class="primary">进入现场</button>
    </div>
    <p class="progress-note dim">点击后锁定鼠标 · WASD 移动 · 左键标记 · Esc 释放</p>
    <p class="progress-note dim">${assetLine}</p>
  `);
  document.getElementById('start-btn')?.addEventListener('click', onStart);

}

/**
 * Set the render quality by hand, or hand it back to the controller.
 *
 * The single place a level is applied. `debug.setQuality` and the number keys both
 * come through here, so the value the HUD reports and the value the renderer was
 * given cannot come apart.
 */
function setQualityLevel(
  level: number | 'auto',
): { level: number; ratio: number; auto: boolean; changes: number } {
  if (level === 'auto') {
    qualityAuto = true;
    qualityAccumulator = 0;
  } else {
    qualityAuto = false;
    quality = {
      level: Math.max(0, Math.min(QUALITY_LEVELS.length - 1, Math.floor(level))),
      streak: 0,
      changes: quality.changes,
    };
    applyPixelRatio(pixelRatioForLevel(quality.level));
  }
  return {
    level: quality.level,
    ratio: pixelRatioForLevel(quality.level),
    auto: qualityAuto,
    changes: quality.changes,
  };
}

/**
 * The pause screen.
 *
 * Written as a panel rather than a browser dialog because it has to sit over the room
 * the player was just looking at -- the thing they are deciding whether to go back to.
 * The quality row is here because this is the screen a player reaches when the game is
 * unplayable and they do not know that the resolution is theirs to move.
 */
function showPause(handlers: {
  onResume: () => void;
  onMenu: () => void;
  onQuality: () => void;
}): void {
  const { ratio, auto } = debug.quality();
  panel(`
    <h1 class="title">已暂停<span class="sub">PAUSED</span></h1>
    <p class="tagline">
      第 ${debug.floor} 层 · 已找到 <strong>${debug.foundTotal}</strong> 个 · 剩余 <strong>${formatClock(debug.timeLeft)}</strong>
    </p>
    <div class="actions">
      <button id="resume-btn" class="primary">回到游戏</button>
      <button id="menu-btn">回主画面</button>
      <button id="quality-btn">画质：${ratio.toFixed(2)}×${auto ? '（自动）' : '（手动）'}</button>
    </div>
    <p class="progress-note dim">
      回到游戏会重新锁定鼠标；也可以直接点击画面。
    </p>
    <p class="progress-note dim">
      卡的话按 <strong>1</strong>–<strong>5</strong> 直接调画质，<strong>0</strong> 交回自动；<strong>F3</strong> 看帧率。
    </p>
  `);
  document.getElementById('resume-btn')?.addEventListener('click', handlers.onResume);
  document.getElementById('menu-btn')?.addEventListener('click', handlers.onMenu);
  document.getElementById('quality-btn')?.addEventListener('click', handlers.onQuality);
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
 * The algorithm lives in framerate.ts, where it can be tested. It used to be
 * written out here *and* again inside `perfWindow`, and the same stall-averaging
 * mistake was in both — the harness caught it in one copy while a player would
 * have seen it in the other.
 */
function recentFrames(): { fps: number; worstMs: number; count: number } {
  const s = summariseFrames(frameTimes, PERF_WINDOW_MS);
  return { fps: s.fps, worstMs: s.worstMs, count: s.samples };
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

/**
 * The GPU the browser is really drawing with.
 *
 * Asked once, because creating a context is not free and the answer cannot change.
 * `UNMASKED_RENDERER_WEBGL` is the only place the real adapter name appears; without
 * it a software rasteriser and a discrete card are indistinguishable from inside the
 * page, which is how "your machine should be fast enough" turns into a guess.
 */
let rendererName: string | null | undefined;

function webglRenderer(): string | null {
  if (rendererName !== undefined) return rendererName;
  try {
    const probe = document.createElement('canvas');
    const gl = probe.getContext('webgl2') ?? probe.getContext('webgl');
    if (!gl) {
      rendererName = null;
      return null;
    }
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const raw = ext
      ? (gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as string)
      : (gl.getParameter(gl.RENDERER) as string);
    // Keep it short: some drivers append a paragraph of version numbers, and the
    // overlay is one line.
    rendererName = String(raw ?? '').split(/[(),]/)[0]!.trim().slice(0, 46) || null;
  } catch {
    rendererName = null;
  }
  return rendererName;
}

/** True when the adapter name says the frame is being drawn on the CPU. */
function isSoftwareRenderer(): boolean {
  const name = (webglRenderer() ?? '').toLowerCase();
  return /swiftshader|llvmpipe|software|basic render|microsoft basic/.test(name);
}

function paintPerf(): void {
  if (!perfVisible) return;
  const fps = currentFps();
  const { worstMs, count } = recentFrames();
  // `debug.frames` is the total, so a stalled loop is visible as a number that
  // never moves rather than as a number that reads plausibly.
  const value = fps === null ? '—' : fps.toFixed(1);
  // The resolution is on here because it is the one thing a report from a machine
  // this was not built on has to contain. The sort interval is shown too: the
  // controller does not move it, but a benchmark or a bug report may have, and a
  // number that can be set by hand should be visible when it is.
  const budget = debug.renderBudget();
  el.perf.textContent =
    `${value} fps   最慢 ${worstMs.toFixed(0)} ms   帧 ${debug.frames}　近 5 秒 ${count} 帧` +
    `\n${debug.placed} 模型 · 扫描 ${debug.splatPresent() ? '在' : '移除'}` +
    ` · 画质 ${qualityLabel(quality.level)}${qualityAuto ? '' : '（锁定）'}` +
    ` · 分辨率 ${budget.ratio.toFixed(2)}×` +
    // Which adapter drew the frame, and a plain warning when it is the CPU. This is
    // the first thing to read on a machine that is fast on paper and slow in the
    // game: without it, a software rasteriser and a dead GPU look identical from
    // inside the page, and every other number here is then being read as a
    // measurement of the game when it is a measurement of the fallback.
    `\n${rendererName ?? '未知渲染器'}${isSoftwareRenderer() ? '  ⚠ 软件渲染（未用显卡）' : ''}`;
  const tone = fps === null ? '' : fps < 15 ? 'bad' : fps < 30 ? 'warn' : '';
  el.perf.className = `perf${tone ? ` ${tone}` : ''}`;
}

/**
 * The render-resolution controller.
 *
 * The brief was "以流畅度为基准" — hold the frame rate, then spend whatever is
 * left on quality. A fixed resolution cannot do that, because the machine that
 * plays this is not the machine it was built on: full resolution is a slideshow
 * on a laptop and wasted headroom on a desktop.
 *
 * The decision logic lives in quality.ts and is tested on its own. What happens
 * here is only the sampling and the applying.
 */
let quality = initialQuality();
let qualityAuto = true;
let qualityAccumulator = 0;
/** Applied through the scene, which owns the renderer. */
let applyPixelRatio: (ratio: number) => void = () => undefined;
/**
 * How often the frame rate is re-read.
 *
 * Longer than the counter's own five-second window would be pointless, and much
 * shorter would compare two windows that overlap so heavily that one slow frame
 * counts as several bad readings.
 */
const QUALITY_INTERVAL_S = 3;

function updateQuality(rawDt: number): void {
  if (!qualityAuto) return;
  qualityAccumulator += rawDt;
  if (qualityAccumulator < QUALITY_INTERVAL_S) return;
  qualityAccumulator = 0;

  const before = quality.level;
  quality = evaluateQuality(quality, currentFps());
  if (quality.level !== before) {
    applyPixelRatio(pixelRatioForLevel(quality.level));
  }
}

/**
 * How long the face stays on screen.
 *
 * Short on purpose. A fright that lingers becomes a picture the player has time
 * to examine and dismiss; 150 ms is about the limit of what the eye reads as
 * sudden, and it is over before the brain catches up.
 */
const SCARE_MS = 150;

let scaresEnabled = true;
let torchOn = true;
let scareCount = 0;
/** Seconds of play since the last fright, and how long to wait for the next. */
let sinceScare = 0;
let scareAfter = 0;
let torchAccumulator = 0;
let scareTimeout = 0;
let doubleTimeout = 0;
/** Avoids the same fright twice in a row, the way `pickScareFace` avoids a face. */
let lastScareKind: ScareKind | null = null;
/** The kind on screen right now, so the acceptance run can see which fired. */
let currentScareKind: ScareKind | null = null;

/**
 * The audio graph, once boot has built it.
 *
 * `fireScare` lives at module scope next to the other HUD helpers, but the audio
 * graph is built inside boot because it needs a user gesture. Rather than move
 * the fright machinery in there and make the frame loop reach back out, boot
 * hands the graph over through this.
 */
let audioSink: { scare(intensity?: number): void } | null = null;

/**
 * The charge, and whether the player has answered it.
 *
 * `chargeActive` is the whole state machine: set when the thing starts moving, cleared
 * by whichever of the two outcomes happens first. The timeout and the click both check
 * it, so a click that lands a millisecond after the window closed cannot also score.
 */
let chargeActive = false;

/**
 * The live room and the player's pose.
 *
 * The fright functions are module-level while `room` and `player` belong to `main`, so they
 * are handed over once at start-up. Null before then and after teardown, which the callers
 * check: a charge is only ever started from inside a running loop.
 */
let roomRef: SplatRoom | null = null;
let poseRef: (() => { x: number; y: number; z: number; yaw: number; pitch: number }) | null =
  null;

/**
 * Whether the charge currently on screen is a model in the room or the overlay.
 *
 * The two endings are not the same event. A model arriving is the thing the mechanic was
 * designed around and earns a real fright; an overlay running out is a picture that grew,
 * and firing a lunge on top of it would be two scares for one. Recorded at the start so
 * the ending does not have to guess.
 */
let chargeIsModel = false;

/** How far in front of the player a charge begins, in metres. */
const CHARGE_SPAWN_M = 6.5;
let chargeTimeout = 0;
let chargeDefused = 0;
let chargeMissed = 0;

/**
 * Paint the torch beam for the current floor.
 *
 * Radii are computed in pixels from the window's shorter side. A percentage
 * radius would make the beam cover a different fraction of a wide monitor than
 * of a narrow one, so the same floor would be a different game depending on the
 * display.
 */
function paintTorch(): void {
  if (!torchOn) return;
  const floor = debug.floor;
  const flicker = torchFlickerForFloor(floor);
  const radius = torchRadiusForFloor(floor) * (1 + (Math.random() - 0.5) * flicker * 0.3);
  const side = Math.min(window.innerWidth, window.innerHeight);
  dark.style.setProperty('--inner', `${(radius * side * 0.42).toFixed(1)}px`);
  dark.style.setProperty('--outer', `${(radius * side * 0.98).toFixed(1)}px`);
  dark.style.setProperty('--tx', `${(50 + (Math.random() - 0.5) * flicker * 7).toFixed(1)}%`);
  dark.style.setProperty('--ty', `${(50 + (Math.random() - 0.5) * flicker * 5).toFixed(1)}%`);
  dark.style.setProperty('--dark', darknessForFloor(floor).toFixed(3));
}

/** Set the floor's darkness once, without waiting for the next flicker tick. */
function applyFloorHorror(floor: number): void {
  dark.style.setProperty('--dark', darknessForFloor(floor).toFixed(3));
  paintTorch();
  // A new floor starts its own countdown, drawn fresh, so a run that has been
  // deep does not carry a short fuse back up to a shallow floor.
  sinceScare = 0;
  scareAfter = nextScareDelay(Math.random, floor);
}

/**
 * The fright.
 *
 * The sound, the face and the jolt are fired together, because a jump scare that
 * arrives in pieces is four separate events rather than one. `offsetWidth` is
 * read to force a reflow between removing and re-adding the animation class —
 * without it the browser coalesces the two changes and a repeat fright does not
 * animate at all, which is the classic way a scare works once and never again.
 *
 * The *kind* varies with depth as well as the face does. One effect repeated is
 * one scare however many faces it wears, and a player who has learnt the shape of
 * it stops flinching; see `SCARE_KINDS`.
 */
/**
 * How frightening a floor is, 0..1.
 *
 * Pulled out of the frame loop so the debug hook reports the same number the
 * loop uses. Two expressions for this would drift, and the acceptance run reads
 * one of them.
 */
function scareIntensityForFloor(floor: number): number {
  return Math.min(1, 0.5 + floor * 0.08);
}

function fireScare(intensity = 1, forceKind?: ScareKind): void {
  if (!scaresEnabled) return;
  scareCount += 1;
  sinceScare = 0;
  audioSink?.scare(intensity);

  const kind = forceKind ?? pickScareKind(Math.random, intensity, lastScareKind);
  lastScareKind = kind;
  currentScareKind = kind;

  const holdMs = SCARE_KIND_MS[kind];
  scareLayer.classList.remove('on', 'lunge', 'blackout');
  view.classList.remove('shake', 'blackout-shake');
  // Force a reflow between removing and re-adding, or a repeat does not animate.
  void scareLayer.offsetWidth;

  scareLayer.classList.add('on');
  if (kind === 'lunge') scareLayer.classList.add('lunge');
  if (kind === 'blackout') {
    scareLayer.classList.add('blackout');
    view.classList.add('blackout-shake');
  } else {
    view.classList.add('shake');
  }

  // A blackout is the torch going out, so the torch has to actually go out --
  // otherwise the light comes back before the screen does and the moment is a
  // CSS class rather than an event.
  const torchWasOn = torchOn;
  if (kind === 'blackout' && torchWasOn) setTorch(false);

  window.clearTimeout(scareTimeout);
  window.clearTimeout(doubleTimeout);

  if (kind === 'double') {
    // The relief between the two is the setup for the second one.
    doubleTimeout = window.setTimeout(() => {
      scareLayer.classList.remove('on');
      void scareLayer.offsetWidth;
      scareLayer.classList.add('on');
    }, SCARE_MS + 210);
  }

  scareTimeout = window.setTimeout(() => {
    scareLayer.classList.remove('on', 'lunge', 'blackout');
    view.classList.remove('shake', 'blackout-shake');
    if (currentScareKind === kind) currentScareKind = null;
    if (kind === 'blackout' && torchWasOn) setTorch(true);
  }, holdMs);
}

/**
 * Something starts coming.
 *
 * The window is the CSS animation's duration as well as the timer's, so what the
 * player sees and what the game allows are the same number of milliseconds. Two
 * numbers that are supposed to agree is how they stop agreeing.
 */
function startCharge(): void {
  if (!scaresEnabled || chargeActive) return;
  chargeActive = true;
  sinceScare = 0;
  const windowMs = chargeWindowForFloor(debug.floor);

  scareLayer.classList.remove('on', 'lunge', 'blackout');
  view.classList.remove('shake');
  void scareLayer.offsetWidth;
  scareLayer.style.setProperty('--charge-ms', `${windowMs}ms`);
  view.classList.add('shake');
  audioSink?.scare(1);

  // A real model crossing the real room, when one has been generated for the purpose.
  //
  // The overlay alone used to be the whole event: a face scaling up in screen space. It
  // reads as a jumpscare, but it does not read as *something in the room*, and the room is
  // the entire point of this game -- a player can tell immediately that the picture on top
  // is not part of the reconstruction. So the model comes first and the overlay becomes the
  // fallback for a build whose horror set has not downloaded.
  //
  // Only the genuine article gets the `.charge` scaling animation. Running both at once
  // puts a photograph over the thing that is actually approaching, which is worse than
  // either alone.
  const room = roomRef;
  const pose = poseRef?.() ?? null;
  // Whatever this floor preloaded. Asking `hasAsset` rather than recomputing the floor's
  // subset keeps one source of truth for what is on disk -- a second calculation here is
  // how the spawn and the preload would come to disagree.
  const candidates =
    room && pose
      ? assetsWithHorrorTag('charge').filter((a: ForeignAsset) => room.hasAsset(a.key))
      : [];
  const chosen =
    candidates.length > 0 ? candidates[Math.floor(Math.random() * candidates.length)] : null;
  const spawned =
    chosen !== null &&
    room !== null &&
    pose !== null &&
    room.spawnCharger(
      chosen.key,
      {
        x: pose.x,
        y: pose.y,
        z: pose.z,
        forwardX: -Math.sin(pose.yaw),
        forwardZ: -Math.cos(pose.yaw),
      },
      CHARGE_SPAWN_M,
      windowMs,
    );

  if (spawned) {
    // A soft vignette stays, so the screen still tells the player that something is
    // happening even if they have turned away from it.
    scareLayer.classList.add('on');
  } else {
    scareLayer.classList.add('on', 'charge');
  }
  chargeIsModel = spawned;

  window.clearTimeout(chargeTimeout);
  chargeTimeout = window.setTimeout(() => {
    if (!chargeActive) return;
    // The player did not answer. It arrives, and it costs what a fright costs.
    missCharge();
  }, windowMs);
}

/**
 * It got here.
 *
 * The model has usually already closed the distance by now, so this is the moment the
 * fright lands rather than a countdown expiring. Fired from one place whether the timeout
 * or the model's own arrival raised it, because two paths that both mean "it reached you"
 * is how they stop agreeing about what reaching you costs.
 */
/**
 * One frame of the charge, from whichever caller has one to give.
 *
 * Returns what is now crossing the room, so a caller can watch it close. Shared with the
 * frame loop rather than restated for the harness: a check that drives its own copy of the
 * rule proves the copy works, not the game.
 */
function stepCharge(dt: number): ReturnType<SplatRoom['chargerInfo']> {
  if (chargeActive && debug.state === 'playing') {
    const room = roomRef;
    const pose = poseRef?.();
    if (room && pose && room.updateCharger(dt, pose)) missCharge();
  }
  return roomRef?.chargerInfo() ?? null;
}

function missCharge(): void {
  if (!chargeActive) return;
  chargeActive = false;
  chargeMissed += 1;
  roomRef?.clearCharger();
  if (chargeIsModel) fireScare(1, 'lunge');
}

/**
 * The player clicked in time.
 *
 * Returns whether there was anything to defuse, so the caller knows not to also treat
 * the click as a mark.
 */
function defuseCharge(): boolean {
  if (!chargeActive) return false;
  chargeActive = false;
  window.clearTimeout(chargeTimeout);
  chargeDefused += 1;
  roomRef?.killCharger();
  scareLayer.classList.remove('on', 'charge', 'lunge');
  scareLayer.classList.add('killed');
  window.setTimeout(() => scareLayer.classList.remove('killed'), 160);
  view.classList.remove('shake');
  toast('解除', 'good');
  return true;
}

/** Turn the frights off entirely, for a player who does not want them. */
function setScaresEnabled(on: boolean): void {
  scaresEnabled = on;
  if (!on) {
    scareLayer.classList.remove('on');
    view.classList.remove('shake');
  }
}

function setTorch(on: boolean): void {
  torchOn = on;
  dark.classList.toggle('off', !on);
  if (on) paintTorch();
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
  // Handed to the module-level fright functions, which can see neither of these. Assigned
  // here rather than declared here on purpose: a `let` inside `main` sits in the temporal
  // dead zone for anything the `?autostart=1` path reaches synchronously, and that mistake
  // broke every shared demo link once already.
  roomRef = room;
  poseRef = () => player.cameraState();
  const audio = new GameAudio();
  audioSink = audio;
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

  /**
   * Findability hint state.
   *
   * Declared here for the same reason as `plan` above, and it is not a coincidence that
   * the two sit together: the hint marker is written by `buildFloorNow`, which the
   * autostart path reaches synchronously from `main`, so a `let` further down is still in
   * its temporal dead zone when the first floor is built. That threw
   * `Cannot access 'hintGiven' before initialization` inside `boot`'s catch, which set
   * `state = 'failed'` and left every `?autostart=1` link — every demo link — showing a
   * play button that did nothing.
   *
   * The menu path hid it, which is also what the `plan` comment says: a button handler
   * runs after `main` has finished, so the declaration has executed by then. So the bug is
   * only visible on the exact URLs that get shared.
   */
  const HINT_AFTER_S = 90;
  let hintGiven = false;

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
  installKeys();

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
  /**
   * Stop the clock.
   *
   * The frame loop already gates the timer, the proximity drone and the frights on
   * `playing`, so leaving that state is what freezes the run -- there is no second
   * place that has to remember to stop. The player is also left where they stand
   * rather than being reset, because a pause is not a checkpoint.
   */
  function pauseGame(): void {
    if (debug.state !== 'playing') return;
    debug.state = 'paused';
    player.releaseLock();
    showPause({
      onResume: resumeFromPause,
      onMenu: () => {
        debug.state = 'menu';
        showMenu(assetLine, () => {
          void startFloor(1, undefined, true);
        });
      },
      onQuality: () => {
        // Back to auto, then straight into the pause screen again: this button is the
        // one a struggling player presses twice, and making them aim at a moving
        // target between presses is the wrong design.
        setQualityLevel('auto');
        toast('画质自动', 'info');
        showPause({
          onResume: resumeFromPause,
          onMenu: () => {
            debug.state = 'menu';
            showMenu(assetLine, () => {
              void startFloor(1, undefined, true);
            });
          },
          onQuality: () => undefined,
        });
      },
    });
  }

  function resumeFromPause(): void {
    if (debug.state === 'paused') debug.state = 'playing';
    player.requestLock();
    hidePanel();
  }

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
    hintGiven = false;
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
    //
    // A couple of charge models are in this list even though nothing places them: without
    // them `room.hasAsset` is false, the charge silently falls back to the overlay, and the
    // feature looks like it was never built. A fallback that is taken every single time is
    // not a fallback, it is the feature.
    //
    // A couple, not all seven -- see `chargeModelsForFloor` for why the whole set would
    // cost more than the room it is shown in.
    const chargeKeys = chargeModelsForFloor(
      floor,
      assetsWithHorrorTag('charge').map((a) => a.key),
    );
    await room.loadAssets([
      ...plan.anomalies.map((a) => a.assetKey ?? ''),
      ...plan.bystanders.map((b) => b.assetKey),
      ...chargeKeys,
    ]);
    // Anything that was mid-approach belonged to the floor that spawned it.
    room.clearCharger();
    chargeActive = false;
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
    applyFloorHorror(floor);
    debug.renderOnce();
    syncHud();
    if (lock) player.requestLock();
    scene.render();
  }

  function endRun(): void {
    debug.state = 'gameOver';
    // The run is over, so the fright costs nothing and can be the loudest one.
    fireScare(1);
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
    const { slotId, reachedAnomaly } = room.pickDetail(scene.camera, scene.viewer.getSize().height);
    if (!plan || debug.state !== 'playing') {
      return { result: 'miss', slotId, found: debug.found.length, marksLeft: debug.marksLeft, state: debug.state };
    }

    // Judged on the node the crosshair reached, not on the identifier it reported. A slot
    // id is only unambiguous while one slot holds one object, and the acceptance run found
    // a floor where marking a bystander scored because the id it reported was also an
    // anomaly's. Reaching the anomaly's own mesh is what the player actually did.
    const outcome = reachedAnomaly
      ? judgeMark(plan, slotId ?? '', debug.found)
      : ({ result: 'miss' } as MarkOutcome);

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
      // Marking something innocent should feel bad immediately, before the HUD
      // is read. Scaled by how many have been wasted, so the last mark left is
      // worse than the first.
      fireScare(0.55 + Math.min(0.45, debug.mistakes * 0.15));
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

  // A click means "mark" only when the mouse is actually captured and we are playing.
  //
  // It used to mean "mark" whenever the state was `playing`, and the state stays
  // `playing` while the pointer is unlocked -- so the one gesture that can restore
  // mouse-look, a click, was spent on a shot instead. The player could not get back
  // into the game after pressing Esc.
  view.addEventListener('click', () => {
    if (debug.state === 'paused') {
      resumeFromPause();
      return;
    }
    // First, and before anything else: a charge in the air owns this click. If this
    // check were after `mark()` the player would spend their one answer on a shot at
    // the furniture.
    if (defuseCharge()) return;
    if (debug.state === 'playing' && player.isLocked) mark();
    else player.requestLock();
  });

  /**
   * Esc is the browser's, not ours: it exits the pointer lock and does not reliably
   * deliver a keydown. So the pause is driven by the lock being lost, which is the
   * event that always arrives and always means the same thing.
   */
  document.addEventListener('pointerlockchange', () => {
    if (document.pointerLockElement) return;
    if (debug.state !== 'playing') return;
    pauseGame();
  });

  /**
   * How long to search before the game says which way to look, in seconds.
   *
   * Floor 1 is capped at 240 s and its single anomaly is meant to be met in the first
   * minute. Ninety seconds is long past that, so the hint cannot be what finds it for
   * an attentive player -- and it is the difference between a floor that teaches and
   * one that just costs four minutes.
   *
   * The value and the marker it checks are declared at the top of `main`, next to `plan`;
   * see the note there for why they cannot live here.
   */

  /**
   * A bearing, once, and never a distance.
   *
   * The drone already says how warm the player is; this says which way to turn when
   * they have not heard it. Naming a direction keeps the search intact -- they still
   * have to see it -- where a marker would replace the game with a walk.
   */
  function maybeHint(): void {
    if (hintGiven || debug.state !== 'playing') return;
    const elapsed = durationForFloor(debug.floor) - debug.timeLeft;
    if (elapsed < HINT_AFTER_S) return;
    const eye = player.cameraState();
    let nearest: { x: number; z: number } | null = null;
    let best = Infinity;
    for (const item of room.placements) {
      const d = Math.hypot(item.node.position.x - eye.x, item.node.position.z - eye.z);
      if (d < best) {
        best = d;
        nearest = { x: item.node.position.x, z: item.node.position.z };
      }
    }
    if (!nearest) return;
    hintGiven = true;
    // Bearing relative to where the player is facing, not to north: "left" has to mean
    // left of the screen or it is not a hint.
    const bearing = Math.atan2(nearest.x - eye.x, nearest.z - eye.z);
    let delta = bearing - eye.yaw;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    const abs = Math.abs(delta);
    const where =
      abs < Math.PI / 4 ? '正前方'
      : abs < (Math.PI * 3) / 4 ? (delta > 0 ? '左边' : '右边')
      : '身后';
    toast(`有什么在${where}，很近`, 'info');
  }

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
  /**
   * Spend `dt` seconds of run clock through the real gate, and report what happened.
   *
   * Unlike `tick`, this is refused while paused -- which is the whole point of having
   * both. `tick` exists to reach the end of a run quickly; this exists to ask whether
   * the run is running.
   */
  debug.frame = (dt: number) => {
    const before = debug.timeLeft;
    advanceRunClock(dt);
    return { state: debug.state, before, after: debug.timeLeft };
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

  debug.assetWeirdness = (key) =>
    FOREIGN_ASSETS.find((asset) => asset.key === key)?.weirdness ?? null;

  // Which horror role a model was generated for, so a check can assert that the right
  // models reach the right kinds without hard-coding the catalogue into the harness.
  debug.assetHorrorTag = (key) =>
    FOREIGN_ASSETS.find((asset) => asset.key === key)?.horrorTag ?? null;

  // The same summary the HUD uses, reported rather than recomputed. When these
  // were two implementations they disagreed with each other about a stalled loop.
  debug.perfWindow = () => {
    const summary = summariseFrames(frameTimes, PERF_WINDOW_MS);
    return {
      samples: summary.samples,
      spanMs: summary.spanMs,
      intervals: summary.intervals,
      historyMs: summary.historyMs,
    };
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
  /**
   * Finish the floor: mark everything still outstanding, settle the run, report the state.
   *
   * NOT a state reader, despite the name -- and it was read as one. A check that asked
   * `autoplay()` whether the game was playing cleared the floor instead, then found the
   * state was `floorClear` and reported the pause as broken. The reader is `debug.state`.
   * The name is kept because the acceptance harness calls it in six places for its real
   * purpose, where it is exactly right.
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
  debug.scare = (intensity?: number, kind?: ScareKind) =>
    fireScare(intensity ?? 1, kind);
  /** How many frights the audio graph has actually played, or null with no audio. */
  debug.audioScares = () => (audio.available ? audio.scareCount : null);
  debug.scareCount = () => scareCount;
  debug.setScaresEnabled = (on) => setScaresEnabled(on);
  debug.scaresEnabled = () => scaresEnabled;
  debug.setTorch = (on) => setTorch(on);
  debug.torchOn = () => torchOn;
  debug.darkness = () => darknessForFloor(debug.floor);
  debug.scareFaceShowing = () => scareLayer.classList.contains('on');
  debug.charge = () => startCharge();
  debug.chargeActive = () => chargeActive;
  debug.defuseCharge = () => defuseCharge();
  debug.charges = () => ({ defused: chargeDefused, missed: chargeMissed });
  /**
   * What is actually crossing the room, if anything.
   *
   * The overlay fallback makes the charge look like it works when nothing was spawned --
   * there is a face on screen either way. This reports the model, so a check can tell the
   * two apart instead of asserting on the picture they share.
   */
  debug.charger = () => room.chargerInfo();
  /**
   * Advance the charge by hand, through the same rule the loop uses.
   *
   * Needed because a check cannot wait for frames here: at well under one per second a
   * sleep of a whole window may contain none, and the distance would then read as unchanged
   * on a build where the approach works perfectly.
   */
  debug.stepCharge = (dt: number) => stepCharge(dt);
  // The kind, not just whether something is on screen: a blackout shows no
  // face at all, so `scareFaceShowing` cannot tell the four apart.
  debug.scareKind = () => currentScareKind;
  debug.scareKinds = () => scareKindsFor(scareIntensityForFloor(debug.floor));
  debug.sinceScare = () => sinceScare;
  debug.scareAfter = () => scareAfter;
  /** The computed beam, so a test can tell a real torch from a transparent div. */
  debug.torchStyle = () => {
    const style = getComputedStyle(dark);
    return {
      inner: style.getPropertyValue('--inner').trim(),
      outer: style.getPropertyValue('--outer').trim(),
      dark: style.getPropertyValue('--dark').trim(),
      background: style.backgroundImage.slice(0, 60),
    };
  };
  debug.togglePerf = () => togglePerf();
  debug.perfVisible = () => perfVisible;
  debug.splatVisible = () => scene.splatVisible;

  // --- adaptive resolution ---------------------------------------------------
  // The scene owns the renderer, so the controller reaches it through here
  // rather than importing the viewer into module scope.
  applyPixelRatio = (ratio) => scene.setPixelRatio(ratio);
  applyPixelRatio(pixelRatioForLevel(quality.level));
  /** The briefing text with its markup stripped, so a test can read the words. */
  debug.briefing = () => briefingHtml().replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  debug.quality = () => ({
    level: quality.level,
    ratio: scene.pixelRatio,
    sortIntervalMs: scene.sortInterval,
    auto: qualityAuto,
    changes: quality.changes,
  });
  /**
   * Pin the resolution, or hand it back to the controller.
   *
   * The acceptance harness pins it: the stills and the frame-rate check are
   * supposed to describe the game, and a resolution that moves underneath them
   * would make two runs incomparable for a reason that has nothing to do with
   * what is being tested.
   */
  debug.setQuality = setQualityLevel;
  debug.removeSplat = () => scene.removeSplat();
  debug.restoreSplat = () => scene.restoreSplat();
  debug.splatPresent = () => scene.splatPresent;
  /** The buffer the reconstruction is rasterised into, from the scene that owns it. */
  debug.canvasSize = () => scene.canvasSize;
  debug.renderBudget = () => ({ ratio: scene.pixelRatio, sortMs: scene.sortInterval });
  /**
   * Kept as a diagnostic even though the controller no longer uses it. This is how
   * `tools/bench-sort.mjs` varies one thing at a time, and how any future question
   * about the sort gets asked without moving the resolution as well.
   */
  debug.setSortInterval = (ms) => scene.setSortInterval(ms);
  /** One Splatting knob at a time, for the benchmark and for a bug report. */
  debug.applySplatPatch = (patch) => scene.setSplatConfig(patch);
  /** Turn the reconstruction off without unloading it, to price the frame around it. */
  debug.setSplatsVisible = (on) => scene.setSplatsVisible(on);
  /** Pin the render scale by hand, for the same reason `setSortInterval` exists. */
  debug.setPixelRatio = (ratio) => scene.setPixelRatio(ratio);
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
  /**
   * Spend run clock, if the run is actually being played.
   *
   * Split out of the frame loop so a test can drive it directly. The pause gate lives
   * here and nowhere else, and it could not be observed through the frame loop on a
   * machine that renders slower than the sleep in the check.
   */
  function advanceRunClock(dt: number): void {
    if (debug.state !== 'playing' || !autoRender) return;
    debug.timeLeft = Math.max(0, debug.timeLeft - dt);
    if (debug.timeLeft <= 0) endRun();
    else syncHud();
  }

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
    // Frozen while paused, because the keyboard is not: the pointer lock is gone but
    // WASD still arrives, and a pause the player can walk around inside is not a pause.
    if (debug.state !== 'paused') player.update(dt);
    // The room animates against the player's eye: what watches you has to be
    // updated before the frame is drawn, or it lags a frame behind.
    room.update(dt, player.cameraState());
    // The thing crossing the room, on the same clock the window is counted on. `playing`
    // only, which `stepCharge` enforces: a paused floor with something mid-approach would
    // resume it in the player's face, and a cleared floor has nothing to be caught by.
    stepCharge(dt);
    if (debug.state === 'playing') {
      const near = proximity();
      audio.setTension(near.tension);
    }
    scene.applyPose(player.cameraState());
    if (autoRender) scene.render();

    advanceRunClock(dt);

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
    // Before the perf HUD, so a resolution change is visible in the same frame
    // it was decided rather than a beat later.
    updateQuality(rawDt);
    perfAccumulator += rawDt;

    // The torch flickers at about 14 Hz rather than every frame. Setting custom
    // properties costs a style recalculation, and a beam that jitters at the
    // frame rate reads as noise rather than as a flame.
    torchAccumulator += rawDt;
    if (torchAccumulator >= 0.07) {
      torchAccumulator = 0;
      paintTorch();
    }

    // The quiet between frights, which shortens with depth.
    if (debug.state === 'playing') {
      maybeHint();
      sinceScare += rawDt;
      if (sinceScare >= scareAfter && chargeActive) {
        // A charge already in the air is the event; a fright on top of it would resolve
        // the player's reaction for them and make the click meaningless.
        sinceScare = 0;
      } else if (sinceScare >= scareAfter) {
        // Scaled by depth: an early fright is a suggestion, a late one is not.
        // From floor 3 some of those frights are instead something that comes for you.
        if (Math.random() < chargeChanceForFloor(debug.floor)) startCharge();
        else fireScare(scareIntensityForFloor(debug.floor));
        scareAfter = nextScareDelay(Math.random, debug.floor);
      }
    }
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
