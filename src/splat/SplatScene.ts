/**
 * The `@manycore/aholo-viewer` backend: the reconstructed room, and the camera
 * and pipeline settings it needs to render at all.
 *
 * Every setting here was arrived at by measurement, not by reading the docs —
 * see `docs/05-3DGS接入配方.md`. The short version: without the compressed pack
 * type the splat decodes wrong, without a black background the viewer's own sky
 * fills the frame, TAA averages a still frame toward that background, the
 * default culling removes most splats, and the default far plane clips a scan
 * whose world units run far past 1e3.
 */

import {
  BackgroundMode,
  Color,
  PerspectiveCamera,
  SplatLoader,
  SplatUtils,
  createViewer,
  setViewerConfig,
  type Viewer,
} from '@manycore/aholo-viewer';
import { loadVoxelCollision } from '../viewer/voxel.ts';
import type { VoxelCollision } from '../viewer/VoxelCollision.ts';
import {
  ROOM_SCENE_URL,
  ROOM_SPAWN,
  ROOM_VOXEL_BIN_URL,
  ROOM_VOXEL_META_URL,
} from './roomData.ts';

// The room's data lives in a renderer-free module so it stays unit-testable;
// re-exported here so callers of the scene do not have to know that.
export { ROOM_SCENE_URL, ROOM_SPAWN, ROOM_VOXEL_BIN_URL, ROOM_VOXEL_META_URL };

/** fov/near/far from WALK_CAMERA in the official walk demo. */
const CAMERA = { fov: 60, near: 0.1, far: 1_000_000 } as const;
/**
 * Spherical-harmonic bands kept per splat.
 *
 * Degree 3 carries 48 extra floats per splat and buys view-dependent highlights
 * on a scan that is mostly matte wallpaper. It is the first thing to give up
 * when the frame rate is the problem, and it is settable from `?sh=` so the
 * trade can be measured instead of guessed.
 */
const MAX_SH_DEGREE = 3;

export type CullingKey =
  | 'frustumCullingEnabled'
  | 'occlusionCullingEnabled'
  | 'detailCullingEnabled'
  | 'layersCullingEnabled'
  | 'triCullingEnabled';

/**
 * Every culling switch off — and that is a measurement, not an inheritance.
 *
 * The obvious theory was that the room ran at 2-3 fps because nothing was being
 * skipped, so all 63 MB of splats were sorted and drawn every frame including
 * the ones behind the camera. Turning frustum culling on to fix that made it
 * **16x slower** (2.79 fps -> 0.17 fps): the per-splat culling pass costs far
 * more than drawing what it discards. Occlusion and detail culling are no
 * better, and the viewer turns detail culling on by itself when occlusion is on.
 * Measured on the real scan at 960x540, fps: all-off 2.79, frustum 0.17,
 * frustum+detail 0.17, frustum+occlusion 0.17, all-on 0.33.
 *
 * Do not switch these back on without measuring; the intuition points the wrong
 * way here.
 */
const DEFAULT_CULLING: Record<CullingKey, boolean> = {
  frustumCullingEnabled: false,
  occlusionCullingEnabled: false,
  detailCullingEnabled: false,
  layersCullingEnabled: false,
  triCullingEnabled: false,
};
const MAX_TEXTURE_SIZE = 8192;

export interface SplatSceneOptions {
  container: HTMLElement;
  /** Called with 0..1 while the scan downloads, then again while it decodes. */
  onProgress?: (fraction: number, label: string) => void;
}

export class SplatScene {
  readonly viewer: Viewer;
  readonly camera: PerspectiveCamera;
  collision: VoxelCollision | null = null;
  /** The splat object, kept so the harness can remove it as a control. */
  splat: unknown = null;
  /** Held while the scan is detached, so removing it can be undone. */
  private detachedSplat: unknown = null;

  /**
   * The viewer's culling switches, reached through an untyped internal.
   *
   * Which of these the reconstruction survives is measured, not assumed — see
   * DEFAULT_CULLING. They are exposed here rather than fixed at construction so
   * the acceptance harness can measure every combination in one session.
   */
  cullingConfig: Record<string, boolean> | null = null;

  setCulling(patch: Partial<Record<CullingKey, boolean>>): void {
    if (!this.cullingConfig) return;
    for (const [key, value] of Object.entries(patch)) {
      this.cullingConfig[key] = value as boolean;
    }
  }

  get culling(): Record<string, boolean> {
    return this.cullingConfig ? { ...this.cullingConfig } : {};
  }

  /**
   * The renderer's resolution multiplier — the one lever that trades sharpness
   * for time without touching the scene.
   *
   * The player's machine is not the machine this was built on, so the resolution
   * cannot be a constant. `IViewerConfig.pixelRatio` scales the buffer the
   * reconstruction is rasterised into, so the cost falls roughly with its square;
   * src/splat/quality.ts decides what it should be from the measured frame rate.
   *
   * Re-applying the whole config rather than poking the renderer directly,
   * because `pixelRatio` is a public documented option and reaching into internals
   * is how the culling flags became load-bearing by accident.
   */
  setPixelRatio(ratio: number): void {
    if (!Number.isFinite(ratio) || ratio <= 0) return;
    if (ratio === this.appliedPixelRatio) return;
    this.appliedPixelRatio = ratio;
    setViewerConfig(this.viewer, { pixelRatio: ratio });
  }

  get pixelRatio(): number {
    return this.appliedPixelRatio;
  }

  /** 1 until the quality controller has measured something and decided otherwise. */
  private appliedPixelRatio = 1;

  /**
   * How often the sort may run, in milliseconds. 0 is every frame.
   *
   * The same merge-not-replace caveat as `setPixelRatio`: `setViewerConfig`
   * merges into the existing config, which is why re-applying a single key here
   * does not wipe the pipeline set up in the constructor.
   */
  /**
   * Hide the splats without unloading them.
   *
   * `removeSplat` frees the data, so it cannot be used to ask "what would this frame
   * cost without the reconstruction" -- by the time the question is answered there is
   * nothing left to put back. This only flips the pipeline stage, which is the thing
   * being priced.
   */
  setSplatsVisible(on: boolean): void {
    if (this.splatsShown === on) return;
    this.splatsShown = on;
    setViewerConfig(this.viewer, {
      pipeline: { Splatting: { enabled: on } },
    } as never);
  }

  get splatsVisible(): boolean {
    return this.splatsShown;
  }

  setSortInterval(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    if (ms === this.appliedSortInterval) return;
    this.appliedSortInterval = ms;
    setViewerConfig(this.viewer, {
      pipeline: { Splatting: { enabled: true, sort: { minIntervalMs: ms } } },
    } as never);
  }

  get sortInterval(): number {
    return this.appliedSortInterval;
  }

  private appliedSortInterval = 0;
  private splatsShown = true;

  private constructor(
    viewer: Viewer,
    camera: PerspectiveCamera,
    private readonly options: SplatSceneOptions,
  ) {
    this.viewer = viewer;
    this.camera = camera;
  }

  static create(options: SplatSceneOptions): SplatScene {
    const size = { width: options.container.clientWidth || 1280, height: options.container.clientHeight || 720 };
    const viewer = createViewer('foreign-splat', options.container, {
      antialiasing: true,
      // the acceptance harness photographs the canvas, so the buffer has to
      // survive the frame
      preserveDrawingBuffer: true,
    });

    const camera = new PerspectiveCamera(
      CAMERA.fov,
      size.width / Math.max(1, size.height),
      CAMERA.near,
      CAMERA.far,
    );
    camera.enableFrustumCulling = false;
    camera.enableDetailCulling = false;
    viewer.setCamera(camera);

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
        TAA: { enabled: false },
      },
    });

    // `defaultViewport` is not in the public typings; the official walk demo
    // reaches it the same way. Left on, it culls most of the scan away.
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
    const scene = new SplatScene(viewer, camera, options);
    scene.cullingConfig = culling ?? null;
    scene.setCulling(DEFAULT_CULLING);
    return scene;
  }

  /**
   * Download and decode the scan.
   *
   * The bytes are fetched here rather than handed to `parseSplatData` as a URL:
   * letting the loader fetch took 55.8s where fetching ourselves takes 11.8s.
   * The download is retried because this is 63 MB from a CDN and a single
   * transient reset should not fail a run.
   */
  async loadSplat(
    url: string = ROOM_SCENE_URL,
    signal?: AbortSignal,
    shDegree: number = MAX_SH_DEGREE,
  ): Promise<void> {
    const progress = (fraction: number, label: string) => {
      this.options.onProgress?.(Math.max(0, Math.min(1, fraction)), label);
    };
    progress(0, '连接房间');

    const response = await fetchWithRetry(url, signal, (attempt) => {
      progress(0, `连接房间（第 ${attempt} 次重试）`);
    });

    // Stream so the player sees a real bar rather than a frozen screen.
    const total = Number(response.headers.get('content-length') ?? 0);
    let bytes: Uint8Array;
    if (response.body && total > 0) {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.byteLength;
        progress((received / total) * 0.9, `下载房间 ${(received / 1e6).toFixed(0)}/${(total / 1e6).toFixed(0)} MB`);
      }
      bytes = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
    } else {
      bytes = new Uint8Array(await response.arrayBuffer());
    }

    progress(0.92, '解析房间');
    const data = await SplatLoader.parseSplatData(
      SplatLoader.SplatFileType.SPZ,
      bytes,
      SplatLoader.SplatPackType.Compressed,
      { maxShDegree: shDegree, maxTextureSize: MAX_TEXTURE_SIZE },
    );
    progress(0.97, '构建场景');
    this.splat = await SplatUtils.createSplat(data);
    this.viewer.getScene().add(this.splat as never);
    this.viewer.render();
    progress(1, '就绪');
  }

  /** Fetch and build the occupancy field the walker collides against. */
  async loadCollision(
    metaUrl: string = ROOM_VOXEL_META_URL,
    binUrl: string = ROOM_VOXEL_BIN_URL,
    signal?: AbortSignal,
  ): Promise<void> {
    this.collision = await loadVoxelCollision(metaUrl, binUrl, signal);
  }

  /**
   * Hide or show the scan, without removing it.
   *
   * This is the diagnostic that answers "what is actually costing the frame":
   * with the splats hidden the rest of the game (walker, HUD, the placed GLB
   * anomalies, the audio graph, the frame loop) runs unchanged, so the gap
   * between the two frame rates is the scan's share and nothing else. Guessing
   * at the bottleneck from reading code produced three wrong answers in a row.
   */
  setSplatVisible(visible: boolean): void {
    if (!this.splat) return;
    (this.splat as { visible?: boolean }).visible = visible;
  }

  /**
   * Take the scan out of the scene entirely.
   *
   * `setSplatVisible(false)` changes nothing measurable, and the likely reason
   * is that a hidden object still costs its per-frame work — the scan's sort and
   * LOD scheduling run whether or not the result is drawn. Hiding it therefore
   * proved nothing. Removing it is the test that can actually answer whether the
   * scan is the cost, so this exists alongside the visibility switch rather than
   * replacing it.
   */
  removeSplat(): void {
    if (!this.splat) return;
    this.detachedSplat = this.splat;
    this.viewer.getScene().remove(this.splat as never);
    this.splat = null;
    this.viewer.render();
  }

  /**
   * Put it back.
   *
   * Reversible on purpose: the rig measures its conditions interleaved and
   * repeated, because the same configuration measured 2.79 fps and 0.67 fps in
   * different sessions. A one-way condition cannot be interleaved, and comparing
   * a one-way measurement in one page against a baseline in another re-creates
   * exactly the error the interleaving exists to remove.
   */
  restoreSplat(): void {
    if (this.splat || !this.detachedSplat) return;
    this.splat = this.detachedSplat;
    this.detachedSplat = null;
    this.viewer.getScene().add(this.splat as never);
    this.viewer.render();
  }

  get splatPresent(): boolean {
    return this.splat !== null;
  }

  get splatVisible(): boolean {
    return Boolean((this.splat as { visible?: boolean } | null)?.visible);
  }

  /** Point the render camera at a walker pose. */
  applyPose(pose: { x: number; y: number; z: number; yaw: number; pitch: number }): void {
    this.camera.up.set(0, 1, 0);
    this.camera.position.set(pose.x, pose.y, pose.z);
    this.camera.rotation.set(pose.pitch, pose.yaw, 0, 'YXZ');
  }

  resize(): void {
    this.viewer.resize?.();
  }

  render(): void {
    this.viewer.render();
  }
}

async function fetchWithRetry(
  url: string,
  signal: AbortSignal | undefined,
  onRetry: (attempt: number) => void,
): Promise<Response> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, { signal });
      if (response.ok) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < 3) {
      onRetry(attempt + 1);
      await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
    }
  }
  throw new Error(
    `无法下载房间模型：${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}
