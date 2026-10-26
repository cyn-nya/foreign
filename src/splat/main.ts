/**
 * Entry point for the 3DGS backend — the real reconstructed room.
 *
 * This is deliberately a separate page from `index.html` (the procedurally built
 * room on three.js): the two renderers cannot share a canvas, and keeping them
 * side by side means the working game keeps passing acceptance while this one is
 * built up to the same standard.
 *
 * Scope of this slice: the scan loads with real progress, the walker moves under
 * voxel collision, and the pose is published for the harness. The anomaly layer
 * (foreign props, marking, floors) comes next.
 */

import { ROOM_SPAWN, SplatScene } from './SplatScene.ts';
import { SplatPlayer } from './SplatPlayer.ts';

interface SplatDebug {
  ready: boolean;
  stage: string;
  error: string | null;
  collision: boolean;
  splat: boolean;
  spawn: typeof ROOM_SPAWN;
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
  /** Control for the collision check: walk the same route with it switched off. */
  setCollision: (enabled: boolean) => void;
  /**
   * Stop the per-frame render. Software rendering of a 63 MB splat at 1280x720
   * is slow enough that a continuously animating canvas never gives the
   * compositor a stable frame, and `page.screenshot` times out waiting for one.
   * The harness pauses, renders a single frame, screenshots, and resumes.
   */
  setAutoRender: (enabled: boolean) => void;
  renderOnce: () => void;
  /** Push the walker forward for a fixed simulated time, ignoring frame rate. */
  walk: (seconds: number, code?: string) => { from: [number, number, number]; to: [number, number, number] };
}

const view = document.getElementById('view') as HTMLElement;
const overlay = document.getElementById('overlay') as HTMLElement;

/** Matches the overlay markup the three.js game uses, so both share its CSS. */
function panel(html: string): void {
  overlay.classList.remove('hidden');
  overlay.innerHTML = `<div class="panel">${html}</div>`;
}

const debug: SplatDebug = {
  ready: false,
  stage: 'boot',
  error: null,
  collision: false,
  splat: false,
  spawn: ROOM_SPAWN,
  player: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, speed: 0, locked: false },
  frames: 0,
  setKey: () => undefined,
  respawn: () => undefined,
  teleport: () => undefined,
  setCollision: () => undefined,
  setAutoRender: () => undefined,
  renderOnce: () => undefined,
  walk: () => ({ from: [0, 0, 0], to: [0, 0, 0] }),
};
(window as unknown as { __splat: SplatDebug }).__splat = debug;

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

function showReady(): void {
  panel(`
    <h1 class="title">FOREIGN<span class="sub">异物</span></h1>
    <p class="tagline">
      你站在一间被 3D 重建的真实房间里。<br />
      房间里只该有<strong>普通的家具</strong> —— 有些东西<strong>不属于这里</strong>。
    </p>
    <div class="actions">
      <button id="start-btn" class="primary">进入现场</button>
    </div>
    <p class="progress-note dim">点击后锁定鼠标 · Esc 释放</p>
  `);
}

async function main(): Promise<void> {
  debug.stage = 'viewer';
  showProgress(0, '初始化渲染器');
  const scene = SplatScene.create({
    container: view,
    onProgress: (fraction, label) => showProgress(fraction, label),
  });

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

  // Settle onto the real floor now that the occupancy field is known.
  player.respawn();

  debug.stage = 'ready';
  debug.ready = true;
  showReady();

  const startButton = document.getElementById('start-btn');
  startButton?.addEventListener('click', () => {
    overlay.innerHTML = '';
    document.getElementById('hud')?.classList.remove('hidden');
    player.requestLock();
  });

  // The viewer owns its canvas, so cabling the layout is on us.
  function layout(): void {
    view.style.width = '100vw';
    view.style.height = '100vh';
    scene.resize();
  }
  layout();
  window.addEventListener('resize', layout);

  debug.setKey = (code, down) => player.setKey(code, down);
  debug.respawn = () => player.respawn();
  debug.setCollision = (enabled) => player.setCollision(enabled ? scene.collision : null);
  debug.renderOnce = () => {
    scene.applyPose(player.cameraState());
    scene.render();
  };
  debug.teleport = (x, y, z, yaw, pitch) => {
    player.spawnAt({ x, y, z, yaw: yaw ?? player.yaw, pitch: pitch ?? player.pitch });
    scene.applyPose(player.cameraState());
    scene.render();
  };

  /**
   * Advance the walker by a fixed simulated time at a fixed step, so a movement
   * assertion does not depend on the harness's frame pacing. Returns where it
   * started and where it ended up.
   */
  debug.walk = (seconds, code = 'KeyW') => {
    const from: [number, number, number] = [player.x, player.y, player.z];
    player.setKey(code, true);
    const step = 1 / 60;
    for (let elapsed = 0; elapsed < seconds; elapsed += step) player.update(step);
    player.setKey(code, false);
    scene.applyPose(player.cameraState());
    scene.render();
    return { from, to: [player.x, player.y, player.z] };
  };

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

main().catch((error: unknown) => {
  debug.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  debug.stage = 'failed';
  debug.ready = true;
  console.error('[splat]', error);
  showFailure(debug.error);
});
