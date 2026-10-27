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
import {
  darknessForFloor,
  pickScareKind,
  SCARE_KIND_MS,
  scareKindsFor,
  nextScareDelay,
  torchFlickerForFloor,
  torchRadiusForFloor,
  type ScareKind,
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
  /**
   * How strange a catalogue asset is: 0 is household furniture, 3 is horror.
   *
   * Exposed so the acceptance run can assert the property the game rests on —
   * that the room's furniture and its intruders are disjoint sets — against the
   * real catalogue rather than against a copy of it kept in the harness.
   */
  assetWeirdness: (key: string) => number | null;
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
  renderBudget: () => { ratio: number; sortMs: number };
  setSortInterval: (ms: number) => void;
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
  renderBudget: () => ({ ratio: 1, sortMs: 0 }),
  setSortInterval: () => undefined,
  setSplatsVisible: () => undefined,
  setPixelRatio: () => undefined,
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
      打中不扣次数，<strong>打错才扣</strong>：你只有 ${MAX_MISTAKES} 次失手机会，每次还罚 8 秒。`;
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

  // F3 rather than the browser's own F12/devtools: the number has to be readable
  // by a player who is not going to open a console.
  window.addEventListener('keydown', (e) => {
    if (e.code === 'F3') {
      e.preventDefault();
      togglePerf();
    }
    if (e.code === 'KeyF' && !e.repeat) {
      e.preventDefault();
      setTorch(!torchOn);
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
    ` · 分辨率 ${budget.ratio.toFixed(2)}×`;
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

  debug.assetWeirdness = (key) =>
    FOREIGN_ASSETS.find((asset) => asset.key === key)?.weirdness ?? null;

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
  debug.setQuality = (level) => {
    if (level === 'auto') {
      qualityAuto = true;
      qualityAccumulator = 0;
      return debug.quality();
    }
    qualityAuto = false;
    quality = { level: Math.max(0, Math.min(QUALITY_LEVELS.length - 1, level)), streak: 0, changes: quality.changes };
    applyPixelRatio(pixelRatioForLevel(quality.level));
    return debug.quality();
  };
  debug.removeSplat = () => scene.removeSplat();
  debug.restoreSplat = () => scene.restoreSplat();
  debug.splatPresent = () => scene.splatPresent;
  debug.renderBudget = () => ({ ratio: scene.pixelRatio, sortMs: scene.sortInterval });
  /**
   * Kept as a diagnostic even though the controller no longer uses it. This is how
   * `tools/bench-sort.mjs` varies one thing at a time, and how any future question
   * about the sort gets asked without moving the resolution as well.
   */
  debug.setSortInterval = (ms) => scene.setSortInterval(ms);
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
      sinceScare += rawDt;
      if (sinceScare >= scareAfter) {
        // Scaled by depth: an early fright is a suggestion, a late one is not.
        fireScare(scareIntensityForFloor(debug.floor));
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
