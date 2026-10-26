/**
 * 3DGS scene probe.
 *
 * Before committing the game to `@manycore/aholo-viewer` I need three answers
 * that only a real render can give:
 *
 *   1. does the package initialise at all?
 *   2. does it rasterise splats in headless Chromium (SwiftShader), which is
 *      what the acceptance harness runs on?
 *   3. does the real 63 MB reconstructed room load and look like a room?
 *
 * Open `spike.html?scene=bear` or `?scene=room`. Results are published on
 * `window.__probe` so tools/probe.mjs can read them without a human looking.
 */

import {
  SplatLoader,
  SplatUtils,
  ToneMapping,
  Vector3,
  createViewer,
  setViewerConfig,
  type Viewer,
} from '@manycore/aholo-viewer';

const GS = 'https://holo-cos.aholo3d.cn/aholo-opensource/gs_file';

interface SceneSpec {
  id: string;
  url: string;
  /** SplatLoader.SplatFileType member. */
  type: SplatLoader.SplatFileType;
  /**
   * Camera pose. `yaw`/`pitch` follow the same convention as the official walk
   * demo (and as this game's Player): `forward = (-sin yaw, 0, -cos yaw)`, with
   * the camera Euler order YXZ. The room scene is Y-up like every other scene,
   * so only the standalone bear sample needs its own up vector.
   */
  pose: { x: number; y: number; z: number; yaw: number; pitch: number };
  up?: [number, number, number];
  lookAt?: [number, number, number];
  expect?: string;
}

/**
 * The room pose is copied verbatim from WALK_DEMO_INDOOR_POSE in the official
 * walk demo — the pose they ship for a first-person walk through this scene.
 */
const SCENES: Record<string, SceneSpec> = {
  bear: {
    id: 'bear',
    url: `${GS}/bear/bear.3d71a266.sog`,
    type: SplatLoader.SplatFileType.SOG,
    pose: { x: -1.5, y: -0.5, z: 0, yaw: 0, pitch: 0 },
    up: [0, -1, 0],
    lookAt: [0, 0, 0],
    expect: 'the standalone bear sample, camera from the official basic example',
  },
  room: {
    id: 'room',
    url: `${GS}/room/scene.7c26e842.spz`,
    type: SplatLoader.SplatFileType.SPZ,
    // WALK_DEMO_INDOOR_POSE
    pose: { x: -4.148223469209742, y: 1.0000000000000002, z: 1.2315243027420304, yaw: -1.7860000000000005, pitch: 0.082 },
    expect: 'the reconstructed room, standing at the official walk-demo spawn',
  },
};

interface ProbeState {
  ready: boolean;
  scene: string | null;
  stage: string;
  error: string | null;
  bytes: number | null;
  milliseconds: number | null;
  splatCount: number | null;
  drawCalls: number | null;
  notes: string[];
}

const state: ProbeState = {
  ready: false,
  scene: null,
  stage: 'init',
  error: null,
  bytes: null,
  milliseconds: null,
  splatCount: null,
  drawCalls: null,
  notes: [],
};
(window as unknown as { __probe: ProbeState }).__probe = state;

const log = document.getElementById('log') as HTMLPreElement;
function say(message: string, tone: 'ok' | 'bad' | 'plain' = 'plain'): void {
  state.notes.push(message);
  const span = tone === 'plain' ? message : `<span class="${tone}">${message}</span>`;
  log.innerHTML += `\n${span}`;
  log.scrollTop = log.scrollHeight;
}

function fail(stage: string, error: unknown): void {
  state.stage = stage;
  state.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  state.ready = true;
  say(`✗ ${stage}: ${state.error}`, 'bad');
  console.error(`[probe] ${stage}`, error);
}

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const sceneId = params.get('scene') ?? 'bear';
  const spec = SCENES[sceneId];
  state.scene = sceneId;
  if (!spec) throw new Error(`unknown scene "${sceneId}"; try ${Object.keys(SCENES).join(' or ')}`);

  const container = document.getElementById('view') as HTMLElement;

  state.stage = 'createViewer';
  say(`scene: ${sceneId} — ${spec.expect ?? ''}`);
  const viewer: Viewer = createViewer('probe', container, {
    antialiasing: true,
    // the harness photographs the canvas, so the buffer must survive the frame
    preserveDrawingBuffer: true,
  });
  say('✓ viewer created', 'ok');

  state.stage = 'configure';
  // The raster settings are copied from the official splatting-basic example.
  // Leaving them at their defaults is what produced the first two probes: a
  // frame with the right mean brightness and essentially zero edge energy
  // (0.87 grey levels per pixel on every angle, even on a different asset),
  // i.e. huge soft blobs smearing the screen rather than a scene.
  setViewerConfig(viewer, {
    pipeline: {
      Splatting: {
        enabled: true,
        pack: { precalculateEnabled: true },
        raster: {
          normalizedFalloff: false,
          preBlurAmount: 0.3,
          blurAmount: 0,
          focalAdjustment: 2,
          detailCullingThreshold: 1,
        },
        composite: {
          enabled: true,
          highPrecisionEnabled: true,
          toneMapping: ToneMapping.Neutral,
          exposure: 1,
        },
      },
    },
  });

  const size = viewer.getSize();
  say(`canvas ${size.width}×${size.height}`);

  const camera = viewer.getCamera();
  if (spec.up) {
    camera.up.set(spec.up[0], spec.up[1], spec.up[2]);
  } else {
    camera.up.set(0, 1, 0);
  }
  camera.position.set(spec.pose.x, spec.pose.y, spec.pose.z);
  if (spec.lookAt) {
    camera.lookAt(new Vector3(spec.lookAt[0], spec.lookAt[1], spec.lookAt[2]));
  } else {
    camera.rotation.set(spec.pose.pitch, spec.pose.yaw, 0, 'YXZ');
  }

  // expose the camera so the harness can drive a look-around sweep
  (window as unknown as { __camera: unknown }).__camera = camera;
  (window as unknown as { __viewer: unknown }).__viewer = viewer;
  state.stage = 'download+parse';
  const started = performance.now();
  say(`downloading ${spec.url.split('/').pop()} …`);
  const data = await SplatLoader.parseSplatData(spec.type, spec.url);
  state.milliseconds = Math.round(performance.now() - started);
  state.stage = 'createSplat';
  say(`✓ parsed in ${(state.milliseconds / 1000).toFixed(1)}s`, 'ok');

  const splat = await SplatUtils.createSplat(data);
  state.stage = 'add';
  viewer.getScene().add(splat);
  say('✓ splat added to scene', 'ok');

  // wait for the splat's GPU resources to land before the first render
  state.stage = 'render';
  viewer.render();
  await new Promise((resolve) => setTimeout(resolve, 900));
  viewer.render();
  await viewer.waitForRenderOver(1200);

  try {
    const info = viewer.renderInfo;
    state.drawCalls = (info as unknown as { objectInfo?: { drawCalls?: number } })?.objectInfo?.drawCalls ?? null;
    const splatCount = (splat as unknown as { splatCount?: number; count?: number });
    state.splatCount = splatCount.splatCount ?? splatCount.count ?? null;
  } catch {
    // statistics are a nicety, not a gate
  }

  state.stage = 'done';
  state.ready = true;
  say(`✓ rendered — ${state.notes.length} steps`, 'ok');

  /**
   * Control experiment: pull the splat back out and re-render from the same
   * camera. If the frame is unchanged, the splat was contributing nothing and
   * whatever we photographed was the viewer's own background.
   */
  (window as unknown as { __removeSplat: () => boolean }).__removeSplat = () => {
    viewer.getScene().remove(splat);
    viewer.render();
    return true;
  };
}

main().catch((error) => fail(state.stage, error));
