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

const GS = 'https://holo-cos.aholo3d.cn/aholo-opensource/gs_file';

/** Aholo's open-source indoor reconstruction, and its matching collision field. */
export const ROOM_SCENE_URL = `${GS}/room/scene.7c26e842.spz`;
export const ROOM_VOXEL_META_URL = `${GS}/room/voxel/10c88df3/collision.voxel-meta.json`;
export const ROOM_VOXEL_BIN_URL = `${GS}/room/voxel/10c88df3/collision.voxel.bin`;

/**
 * WALK_DEMO_INDOOR_POSE from the official walk demo: the pose they ship for a
 * first-person walk of this scene. `y` is the eye height, not the feet.
 */
export const ROOM_SPAWN = {
  x: -4.148223469209742,
  y: 1.0000000000000002,
  z: 1.2315243027420304,
  yaw: -1.7860000000000005,
  pitch: 0.082,
} as const;

/** fov/near/far from WALK_CAMERA in the official walk demo. */
const CAMERA = { fov: 60, near: 0.1, far: 1_000_000 } as const;
const MAX_SH_DEGREE = 3;
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
    if (culling) {
      culling.frustumCullingEnabled = false;
      culling.occlusionCullingEnabled = false;
      culling.detailCullingEnabled = false;
      culling.layersCullingEnabled = false;
      culling.triCullingEnabled = false;
    }

    return new SplatScene(viewer, camera, options);
  }

  /**
   * Download and decode the scan.
   *
   * The bytes are fetched here rather than handed to `parseSplatData` as a URL:
   * letting the loader fetch took 55.8s where fetching ourselves takes 11.8s.
   * The download is retried because this is 63 MB from a CDN and a single
   * transient reset should not fail a run.
   */
  async loadSplat(url: string = ROOM_SCENE_URL, signal?: AbortSignal): Promise<void> {
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
      { maxShDegree: MAX_SH_DEGREE, maxTextureSize: MAX_TEXTURE_SIZE },
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
