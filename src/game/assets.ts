/**
 * Loads the Aholo Lux3D-generated .glb files.
 *
 * Generation output has no canonical scale or pivot, so every model is
 * normalised here: uniform-scaled to the asset's target height, re-pivoted
 * so its base sits at y = 0 and its footprint is centred. The game never
 * has to care what the generator produced.
 *
 * If a file is absent the procedural placeholder stays in place, so the
 * game is always playable — missing art is never a crash.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FOREIGN_ASSETS, type ForeignAsset } from './catalog';
import type { Room } from './Room';

const BASE = `${import.meta.env.BASE_URL ?? '/'}assets/foreign/`;

export interface AssetLoadReport {
  loaded: string[];
  missing: string[];
}

export function foreignAssetUrl(key: string): string {
  return `${BASE}${key}.glb`;
}

export async function loadForeignAssets(room: Room): Promise<AssetLoadReport> {
  const loader = new GLTFLoader();
  const loaded: string[] = [];
  const missing: string[] = [];

  await Promise.all(
    FOREIGN_ASSETS.map(async (asset) => {
      try {
        const gltf = await loader.loadAsync(foreignAssetUrl(asset.key));
        const normalised = normalise(gltf.scene, asset);
        room.setAssetOverride(asset.key, normalised);
        loaded.push(asset.key);
      } catch {
        missing.push(asset.key);
      }
    }),
  );

  return { loaded: loaded.sort(), missing: missing.sort() };
}

function normalise(scene: THREE.Object3D, asset: ForeignAsset): THREE.Group {
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(scene);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  const scale = size.y > 1e-4 ? asset.height / size.y : 1;

  const pivot = new THREE.Group();
  scene.scale.setScalar(scale);
  // base on the floor, footprint centred on the pivot
  scene.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);
  pivot.add(scene);

  pivot.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const material = mesh.material as THREE.MeshStandardMaterial | THREE.MeshStandardMaterial[];
    const list = Array.isArray(material) ? material : [material];
    for (const m of list) {
      if (!m) continue;
      // generated meshes often arrive unlit/untextured; keep them readable
      m.side = THREE.FrontSide;
      if (m.map) m.map.colorSpace = THREE.SRGBColorSpace;
    }
  });

  return pivot;
}

/** Preload only the assets a floor needs — used to avoid a hitch mid-round. */
export async function warmAsset(room: Room, key: string): Promise<boolean> {
  if (room.hasAssetOverride(key)) return true;
  const asset = FOREIGN_ASSETS.find((a) => a.key === key);
  if (!asset) return false;
  try {
    const gltf = await new GLTFLoader().loadAsync(foreignAssetUrl(key));
    room.setAssetOverride(key, normalise(gltf.scene, asset));
    return true;
  } catch {
    return false;
  }
}
