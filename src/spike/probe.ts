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
 *
 * Every setting below is copied from the official walk demo
 * (`docs/research/spec/gh/ex-walk-demo.ts`), which is the only known-good
 * configuration for this exact scene. The earlier version of this file used
 * defaults instead and produced a smooth bright wash on every angle: the
 * background won, TAA blended a single frame, and — most importantly — the
 * splat was decoded without `SplatPackType.Compressed`.
 */

import {
  BackgroundMode,
  Box3,
  Color,
  GLTFLoader,
  PerspectiveCamera,
  Raycaster,
  SplatLoader,
  SplatUtils,
  Vector2,
  Vector3,
  createViewer,
  downloadTexture,
  setViewerConfig,
  type Viewer,
} from '@manycore/aholo-viewer';

const { loadGLTF } = GLTFLoader;

const GS = 'https://holo-cos.aholo3d.cn/aholo-opensource/gs_file';

/** From WALK_CAMERA in the walk demo. */
const WALK_CAMERA = { fov: 60, near: 0.1, far: 1_000_000 } as const;
/** From WALK_SPLAT_PACK_TYPE / WALK_MAX_SH_DEGREE. */
const WALK_MAX_SH_DEGREE = 3;
const WALK_MAX_TEXTURE_SIZE = 8192;

interface SceneSpec {
  id: string;
  url: string;
  /** SplatLoader.SplatFileType member. */
  type: SplatLoader.SplatFileType;
  /**
   * Camera pose. `yaw`/`pitch` follow the same convention as the official walk
   * demo (and as this game's Player): `forward = (-sin yaw, 0, -cos yaw)`, with
   * the camera Euler order YXZ.
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
  /** Split of `milliseconds` — a slow load needs a different fix for each. */
  downloadMs: number | null;
  decodeMs: number | null;
  splatCount: number | null;
  drawCalls: number | null;
  /** Whether the internal culling switches were reachable and disabled. */
  cullingDisabled: boolean;
  parseOptions: { shDegree: number; pack: string } | null;
  /**
   * A .glb loaded into the same scene as the splat. This is how the game will
   * place both its placeholder props and the Aholo Lux3D assets, so the probe
   * has to prove the loader and the picking work together.
   */
  glb: {
    url: string;
    size: [number, number, number];
    min: [number, number, number];
    max: [number, number, number];
  } | null;
  notes: string[];
}

const state: ProbeState = {
  ready: false,
  scene: null,
  stage: 'init',
  error: null,
  bytes: null,
  milliseconds: null,
  downloadMs: null,
  decodeMs: null,
  splatCount: null,
  drawCalls: null,
  cullingDisabled: false,
  parseOptions: null,
  glb: null,
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
  const size = viewer.getSize();

  // A real perspective camera, because the default one uses a modest far plane
  // and a huge scan in world units far above 1e3 would be clipped away.
  const camera = new PerspectiveCamera(
    WALK_CAMERA.fov,
    size.width / Math.max(1, size.height),
    WALK_CAMERA.near,
    WALK_CAMERA.far,
  );
  camera.enableFrustumCulling = false;
  camera.enableDetailCulling = false;
  viewer.setCamera(camera);

  // Exactly the walk demo's pipeline, plus the black background: without this
  // the frame is dominated by the viewer's own backdrop and the splat cannot be
  // judged from the statistics.
  setViewerConfig(viewer, {
    pipeline: {
      Background: {
        background: {
          active: BackgroundMode.BasicBackground,
          basic: { color: new Color(0, 0, 0), alpha: 1 },
        },
        ground: { enabled: false },
      },
      Splatting: { enabled: true },
      // TAA blends across frames. A still probe renders one frame, so leaving
      // it on averages the image toward the background.
      TAA: { enabled: false },
    },
  });

  // The walk demo reaches these through `as any`; `defaultViewport` is not in
  // the public typings, so treat it as optional rather than assuming it exists.
  const internals = viewer as unknown as {
    defaultViewport?: {
      drivenCullingConfig?: {
        frustumCullingEnabled: boolean;
        occlusionCullingEnabled: boolean;
        detailCullingEnabled: boolean;
        layersCullingEnabled: boolean;
        triCullingEnabled: boolean;
      };
    };
  };
  const culling = internals.defaultViewport?.drivenCullingConfig;
  if (culling) {
    culling.frustumCullingEnabled = false;
    culling.occlusionCullingEnabled = false;
    culling.detailCullingEnabled = false;
    culling.layersCullingEnabled = false;
    culling.triCullingEnabled = false;
    state.cullingDisabled = true;
    say('✓ driven culling disabled', 'ok');
  } else {
    say('! defaultViewport.drivenCullingConfig unreachable — culling left on');
  }

  say(`canvas ${size.width}×${size.height} · fov ${WALK_CAMERA.fov} far ${WALK_CAMERA.far}`);

  const detected = SplatLoader.detectSplatFileType(spec.url, new Uint8Array());
  say(`file type: ${spec.url.split('.').pop()} → ${detected ?? 'undetected'}`);

  camera.up.set(spec.up ? spec.up[0] : 0, spec.up ? spec.up[1] : 1, spec.up ? spec.up[2] : 0);
  camera.position.set(spec.pose.x, spec.pose.y, spec.pose.z);
  if (spec.lookAt) {
    camera.lookAt(new Vector3(spec.lookAt[0], spec.lookAt[1], spec.lookAt[2]));
  } else {
    camera.rotation.set(spec.pose.pitch, spec.pose.yaw, 0, 'YXZ');
  }

  // expose the camera so the harness can drive a look-around sweep
  (window as unknown as { __camera: unknown }).__camera = camera;
  (window as unknown as { __viewer: unknown }).__viewer = viewer;

  /**
   * Move the probe camera. A reconstructed scan does not cover every direction,
   * so the harness uses this to find the region that actually has data.
   */
  (window as unknown as {
    __setPose: (x: number, y: number, z: number, yaw: number, pitch: number) => boolean;
  }).__setPose = (x, y, z, yaw, pitch) => {
    camera.position.set(x, y, z);
    camera.rotation.set(pitch, yaw, 0, 'YXZ');
    viewer.render();
    return true;
  };

  state.stage = 'download+parse';
  const started = performance.now();
  // Load time is a product constraint, not a detail: the full-quality decode of
  // this 63 MB scan takes the best part of a minute, which no player will wait
  // for. These two knobs are the ones that move it.
  const shDegree = Number(params.get('sh') ?? WALK_MAX_SH_DEGREE);
  const packName = params.get('pack') ?? 'compressed';
  const packType = {
    raw: SplatLoader.SplatPackType.Raw,
    compressed: SplatLoader.SplatPackType.Compressed,
    supercompressed: SplatLoader.SplatPackType.SuperCompressed,
    sog: SplatLoader.SplatPackType.Sog,
  }[packName] ?? SplatLoader.SplatPackType.Compressed;
  state.parseOptions = { shDegree, pack: packName };
  say(`parse options: sh=${shDegree} pack=${packName}`);
  say(`downloading ${spec.url.split('/').pop()} …`);
  // Fetch here rather than letting parseSplatData fetch, so download time and
  // decode time can be told apart — a 63 MB scan is slow for either reason and
  // they need completely different fixes.
  const downloadStarted = performance.now();
  // Retry: this is a 63 MB fetch from a CDN and a single transient reset would
  // otherwise fail the whole acceptance run for no real reason.
  let response: Response | null = null;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const candidate = await fetch(spec.url);
      if (candidate.ok) {
        response = candidate;
        break;
      }
      lastError = new Error(`HTTP ${candidate.status}`);
    } catch (error) {
      lastError = error;
    }
    say(`! download attempt ${attempt} failed (${lastError instanceof Error ? lastError.message : lastError})`);
    await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
  }
  if (!response) throw new Error(`splat URL failed: ${lastError instanceof Error ? lastError.message : lastError}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  state.downloadMs = Math.round(performance.now() - downloadStarted);
  state.bytes = bytes.byteLength;
  say(`✓ downloaded ${(bytes.byteLength / 1e6).toFixed(1)} MB in ${(state.downloadMs / 1000).toFixed(1)}s`, 'ok');

  const decodeStarted = performance.now();
  const data = await SplatLoader.parseSplatData(
    spec.type,
    bytes,
    packType,
    { maxShDegree: shDegree, maxTextureSize: WALK_MAX_TEXTURE_SIZE },
  );
  state.decodeMs = Math.round(performance.now() - decodeStarted);
  state.milliseconds = Math.round(performance.now() - started);
  state.stage = 'createSplat';
  say(`✓ decoded in ${(state.decodeMs / 1000).toFixed(1)}s`, 'ok');

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
  } catch {
    // statistics are a nicety, not a gate
  }

  state.stage = 'done';

  /**
   * Optionally load a .glb into the same scene as the splat and prove it can be
   * picked by a centre-screen ray. That pair — load a prop, then raycast it — is
   * the whole interaction model of the game, so it gets proven here rather than
   * discovered halfway through the port.
   *
   * The object is placed a fixed distance straight ahead of the starting pose,
   * with its base on the floor, and the camera is then aimed at its centre, so
   * the pick is deterministic instead of depending on the prop's proportions.
   */
  const glbUrl = params.get('glb');
  let pickable: { scene: unknown } | null = null;
  if (glbUrl) {
    state.stage = 'glb';
    say(`loading ${glbUrl} …`);
    const glbResponse = await fetch(glbUrl);
    if (!glbResponse.ok) throw new Error(`GLB ${glbUrl} -> HTTP ${glbResponse.status}`);
    const parsed = await loadGLTF(await glbResponse.arrayBuffer(), { textureLoader: downloadTexture });
    const object = parsed.scene;
    pickable = { scene: object as unknown };

    const dist = Number(params.get('glbDist') ?? 2.5);
    const baseY = Number(params.get('glbY') ?? -0.425);
    const fwdX = -Math.sin(spec.pose.yaw);
    const fwdZ = -Math.cos(spec.pose.yaw);
    object.position.set(spec.pose.x + fwdX * dist, baseY, spec.pose.z + fwdZ * dist);
    viewer.getScene().add(object);
    viewer.render();
    await viewer.waitForRenderOver(600);

    const box = new Box3().setFromObject(object);
    const size = new Vector3();
    box.getSize(size);
    state.glb = {
      url: glbUrl,
      size: [size.x, size.y, size.z],
      min: [box.min.x, box.min.y, box.min.z],
      max: [box.max.x, box.max.y, box.max.z],
    };
    say(
      `✓ glb placed at (${object.position.x.toFixed(2)}, ${baseY}, ${object.position.z.toFixed(2)}), ` +
        `size ${size.x.toFixed(2)}×${size.y.toFixed(2)}×${size.z.toFixed(2)}`,
      'ok',
    );

    // Aim at the object's centre so the centre-screen ray has something to hit.
    const cx = (box.min.x + box.max.x) / 2;
    const cy = (box.min.y + box.max.y) / 2;
    const cz = (box.min.z + box.max.z) / 2;
    const dx = cx - spec.pose.x;
    const dz = cz - spec.pose.z;
    const dy = cy - spec.pose.y;
    const horizontal = Math.hypot(dx, dz);
    if (horizontal < 1e-6) throw new Error('glb ended up on top of the camera');
    camera.position.set(spec.pose.x, spec.pose.y, spec.pose.z);
    camera.rotation.set(Math.atan2(dy, horizontal), Math.atan2(-dx, -dz), 0, 'YXZ');
    viewer.render();
    await viewer.waitForRenderOver(600);
    say(`✓ aimed at the glb centre (${cx.toFixed(2)}, ${cy.toFixed(2)}, ${cz.toFixed(2)})`, 'ok');
    // Back to 'done': the stage name is a failure diagnostic, and
    // state.glb already records that this part ran.
    state.stage = 'done';
  }

  state.ready = true;
  say(`✓ rendered — ${state.notes.length} steps`, 'ok');

  /**
   * Cast a ray from the camera through a screen point and report what it hits.
   * Screen centre by default; the game marks whatever this returns.
   */
  (window as unknown as {
    __pick: (nx?: number, ny?: number) => { count: number; first: { distance: number } | null };
  }).__pick = (nx = 0, ny = 0) => {
    if (!pickable) return { count: 0, first: null };
    const raycaster = new Raycaster();
    raycaster.setFromCamera(new Vector2(nx, ny), camera, viewer.getSize().height);
    const hits: unknown[] = [];
    raycaster.intersectObjects([pickable.scene as never], true, hits as never);
    const first = hits[0] as { distance?: number } | undefined;
    return {
      count: hits.length,
      first: first && typeof first.distance === 'number' ? { distance: first.distance } : null,
    };
  };

  /**
   * Control experiment: pull the splat back out and re-render from the same
   * camera. If the frame is unchanged, the splat was contributing nothing and
   * whatever we photographed was the viewer's own background.
   *
   * `__restoreSplat` must be called before any further measurement — the first
   * version of tools/probe.mjs did not, so every sweep afterwards photographed
   * an empty scene and reported it as "the scan has no data here".
   */
  let attached = true;
  (window as unknown as { __removeSplat: () => boolean }).__removeSplat = () => {
    if (attached) {
      viewer.getScene().remove(splat);
      attached = false;
    }
    viewer.render();
    return true;
  };
  (window as unknown as { __restoreSplat: () => boolean }).__restoreSplat = () => {
    if (!attached) {
      viewer.getScene().add(splat);
      attached = true;
    }
    viewer.render();
    return true;
  };
}

main().catch((error) => fail(state.stage, error));
