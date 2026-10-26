/**
 * Procedural placeholder props.
 *
 * Every prop in the game is built from primitives, so the game is fully
 * playable with zero downloaded assets. When an Aholo Lux3D .glb is
 * exported for a FOREIGN_ASSETS key it is swapped in at load time by
 * `assets.ts` — the procedural version is the graceful fallback.
 */

import * as THREE from 'three';
import type { PropKind, Vec3 } from './types';

const C = {
  wood: 0x8a6a45,
  darkWood: 0x4a3423,
  white: 0xe6e6e2,
  ceramic: 0xf2f1ec,
  metal: 0x9aa3ad,
  steel: 0xb9c0c7,
  dark: 0x24262b,
  fabric: 0x59616e,
  fabricDark: 0x3c424c,
  cushion: 0x6d7686,
  glass: 0x9fd4e0,
  screen: 0x0e1216,
  green: 0x3d7a4a,
  greenDark: 0x2b5a35,
  black: 0x121417,
  acrylic: 0xd8d4c8,
  brass: 0xb08d4f,
  paper: 0xe9e6dc,
} as const;

const matCache = new Map<string, THREE.MeshStandardMaterial>();

function mat(color: number, roughness = 0.82, metalness = 0.04): THREE.MeshStandardMaterial {
  const key = `${color}|${roughness}|${metalness}`;
  let m = matCache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness, metalness });
    matCache.set(key, m);
  }
  return m;
}

function emissive(color: number, intensity = 1): THREE.MeshStandardMaterial {
  const key = `e${color}|${intensity}`;
  let m = matCache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color,
      emissive: new THREE.Color(color),
      emissiveIntensity: intensity,
      roughness: 0.4,
    });
    matCache.set(key, m);
  }
  return m;
}

/* ---------------- primitive helpers (positions are CENTRES) --------------- */

function box(
  w: number, h: number, d: number,
  material: THREE.Material,
  x = 0, y = 0, z = 0,
): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function cyl(
  rTop: number, rBottom: number, h: number,
  material: THREE.Material,
  x = 0, y = 0, z = 0,
  seg = 18,
): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBottom, h, seg), material);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function sph(r: number, material: THREE.Material, x = 0, y = 0, z = 0, seg = 20): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, seg, Math.max(8, seg / 2)), material);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function cone(
  r: number, h: number,
  material: THREE.Material,
  x = 0, y = 0, z = 0,
  seg = 18,
): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.ConeGeometry(r, h, seg), material);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function ellipsoid(
  rx: number, ry: number, rz: number,
  material: THREE.Material,
  x = 0, y = 0, z = 0,
): THREE.Mesh {
  const m = sph(1, material, x, y, z);
  m.scale.set(rx, ry, rz);
  return m;
}

function group(...children: THREE.Object3D[]): THREE.Group {
  const g = new THREE.Group();
  children.forEach((c) => g.add(c));
  return g;
}

/* ======================================================================== *
 *  Room furniture — muted, believable, deliberately unremarkable.
 * ======================================================================== */

type Builder = (size: Vec3) => THREE.Object3D;

const FURNITURE: Partial<Record<PropKind, Builder>> = {
  sofa: ({ x: w, y: h, z: d }) => {
    const seatH = h * 0.45;
    return group(
      box(w, seatH, d, mat(C.fabric), 0, seatH / 2),
      box(w, h - seatH, d * 0.28, mat(C.fabricDark), 0, seatH + (h - seatH) / 2, -d * 0.36),
      box(d * 0.16, h * 0.72, d, mat(C.fabricDark), -w / 2 + d * 0.08, h * 0.36),
      box(d * 0.16, h * 0.72, d, mat(C.fabricDark), w / 2 - d * 0.08, h * 0.36),
      box(w * 0.44, 0.12, d * 0.72, mat(C.cushion), -w * 0.24, seatH + 0.06, d * 0.05),
      box(w * 0.44, 0.12, d * 0.72, mat(C.cushion), w * 0.24, seatH + 0.06, d * 0.05),
    );
  },

  coffee_table: ({ x: w, y: h, z: d }) => {
    const topT = 0.06;
    const legIn = 0.1;
    const parts: THREE.Object3D[] = [
      box(w, topT, d, mat(C.darkWood), 0, h - topT / 2),
    ];
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        parts.push(box(
          0.06, h - topT, 0.06, mat(C.darkWood),
          sx * (w / 2 - legIn), (h - topT) / 2, sz * (d / 2 - legIn),
        ));
      }
    }
    return group(...parts);
  },

  tv_stand: ({ x: w, y: h, z: d }) =>
    group(
      box(w, h * 0.8, d, mat(C.darkWood), 0, h * 0.8 / 2),
      box(w * 0.98, 0.04, d * 1.02, mat(C.black), 0, h * 0.8),
      box(w * 0.5, 0.02, 0.02, mat(C.metal), 0, h * 0.45, d / 2 + 0.01),
      box(0.08, h * 0.2, 0.08, mat(C.black), -w * 0.38, h * 0.1),
      box(0.08, h * 0.2, 0.08, mat(C.black), w * 0.38, h * 0.1),
    ),

  tv: ({ x: w, y: h, z: d }) =>
    group(
      box(w, h, d, mat(C.black), 0, h / 2),
      box(w * 1.4, h * 0.92, d * 0.9, mat(C.screen), 0, h / 2),
      box(w, h * 0.06, d * 1.2, mat(C.metal), 0, h * 0.03),
    ),

  rug: ({ x: w, y: h, z: d }) =>
    group(
      box(w, h, d, mat(0x7a5c50, 0.95), 0, h / 2),
      box(w * 0.86, h * 0.6, d * 0.82, mat(0x8d6b5b, 0.95), 0, h * 0.6),
    ),

  floor_lamp: ({ y: h }) => {
    const shadeH = h * 0.22;
    return group(
      cyl(0.19, 0.22, 0.03, mat(C.metal), 0, 0.015),
      cyl(0.022, 0.022, h - shadeH - 0.03, mat(C.steel), 0, 0.03 + (h - shadeH - 0.03) / 2),
      cyl(0.13, 0.19, shadeH, emissive(0xf6e3bd, 0.5), 0, h - shadeH / 2),
    );
  },

  bookshelf: ({ x: w, y: h, z: d }) => {
    const parts: THREE.Object3D[] = [
      box(w, h, 0.025, mat(C.wood), 0, h / 2, -d / 2),
      box(0.025, h, d, mat(C.wood), -w / 2, h / 2),
      box(0.025, h, d, mat(C.wood), w / 2, h / 2),
    ];
    const shelves = 4;
    for (let i = 1; i <= shelves; i++) {
      const y = (h / (shelves + 1)) * i;
      parts.push(box(w, 0.025, d, mat(C.wood), 0, y));
      // a few books
      const bookColors = [0x8c3b3b, 0x2f4f6f, 0x4a6b3a, 0x6b5a2f, 0x403a52];
      for (let b = 0; b < 6; b++) {
        const bw = (w * 0.72) / 6;
        parts.push(box(
          bw * 0.78, 0.22, d * 0.6,
          mat(bookColors[(i + b) % bookColors.length], 0.9),
          -w * 0.34 + bw * (b + 0.5), y + 0.12, 0.02,
        ));
      }
    }
    return group(...parts);
  },

  armchair: ({ x: w, y: h, z: d }) => {
    const seatH = h * 0.42;
    return group(
      box(w, seatH, d, mat(C.fabric), 0, seatH / 2),
      box(w, h - seatH, d * 0.24, mat(C.fabricDark), 0, seatH + (h - seatH) / 2, -d * 0.38),
      box(w * 0.16, h * 0.66, d, mat(C.fabricDark), -w / 2 + w * 0.08, h * 0.33),
      box(w * 0.16, h * 0.66, d, mat(C.fabricDark), w / 2 - w * 0.08, h * 0.33),
    );
  },

  plant: ({ x: w, y: h }) =>
    group(
      cyl(w * 0.42, w * 0.34, h * 0.3, mat(0xa96b4a, 0.9), 0, h * 0.15),
      cyl(0.03, 0.035, h * 0.32, mat(0x4a6b3a), 0, h * 0.42),
      sph(w * 0.46, mat(C.green), 0, h * 0.66),
      sph(w * 0.32, mat(C.greenDark), w * 0.2, h * 0.78, 0.1),
      sph(w * 0.28, mat(C.green), -w * 0.22, h * 0.72, -0.12),
      ellipsoid(w * 0.3, h * 0.16, w * 0.3, mat(C.greenDark), 0, h * 0.5, 0),
    ),

  wall_art: ({ x: w, y: h, z: d }) =>
    group(
      box(w, h, d, mat(C.darkWood), 0, h / 2),
      box(w * 2.4, h * 0.86, d * 1.3, mat(C.paper, 0.95), 0, h / 2),
      box(w * 1.6, h * 0.5, d * 1.6, mat(0x6f8ba0, 0.95), 0, h * 0.52),
    ),

  side_table: ({ x: w, y: h, z: d }) => {
    const topT = 0.05;
    const parts: THREE.Object3D[] = [box(w, topT, d, mat(C.wood), 0, h - topT / 2)];
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        parts.push(box(0.05, h - topT, 0.05, mat(C.darkWood), sx * (w / 2 - 0.07), (h - topT) / 2, sz * (d / 2 - 0.07)));
      }
    }
    return group(...parts);
  },

  ceiling_light: ({ x: w, y: h }) =>
    group(
      cyl(0.02, 0.02, 0.1, mat(C.steel), 0, h + 0.05),
      cyl(w / 2, w / 2, h, emissive(0xfff2d8, 0.9), 0, h / 2),
      cyl(w / 2 + 0.03, w / 2 + 0.03, 0.02, mat(C.steel), 0, h),
    ),

  counter: ({ x: w, y: h, z: d }) =>
    group(
      box(w, h - 0.04, d, mat(C.white, 0.7), 0, (h - 0.04) / 2),
      box(w, 0.04, d * 1.06, mat(0x3a3f45, 0.35, 0.1), 0, h - 0.02),
      box(w * 0.98, 0.02, 0.02, mat(C.metal), 0, h * 0.55, d / 2 + 0.005),
    ),

  sink: ({ x: w, y: h, z: d }) =>
    group(
      box(w, h, d, mat(C.steel, 0.3, 0.75), 0, h / 2),
      box(w * 0.7, h * 0.5, d * 0.66, mat(0x6f777f, 0.35, 0.6), 0, h * 0.6),
      cyl(0.018, 0.018, 0.26, mat(C.steel, 0.25, 0.85), 0, h + 0.13, -d * 0.28),
      box(0.16, 0.02, 0.02, mat(C.steel, 0.25, 0.85), 0.07, h + 0.26, -d * 0.28),
    ),

  stove: ({ x: w, y: h, z: d }) => {
    const parts: THREE.Object3D[] = [
      box(w, h, d, mat(C.black, 0.4, 0.3), 0, h / 2),
    ];
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        parts.push(cyl(0.075, 0.075, 0.012, mat(0x2b2b2b, 0.5), sx * w * 0.22, h + 0.006, sz * d * 0.2));
      }
    }
    parts.push(box(w * 0.9, h * 0.5, 0.02, mat(0x1a1c1f, 0.25, 0.5), 0, h * 0.5, d / 2 + 0.005));
    return group(...parts);
  },

  fridge: ({ x: w, y: h, z: d }) =>
    group(
      box(w, h, d, mat(C.white, 0.42, 0.25), 0, h / 2),
      box(w * 0.92, 0.012, d * 0.92, mat(0xb9bcc0), 0, h * 0.68),
      box(0.03, h * 0.22, 0.03, mat(C.steel, 0.3, 0.7), -w * 0.32, h * 0.82, d / 2 + 0.02),
      box(0.03, h * 0.3, 0.03, mat(C.steel, 0.3, 0.7), -w * 0.32, h * 0.42, d / 2 + 0.02),
    ),

  upper_cabinet: ({ x: w, y: h, z: d }) =>
    group(
      box(w, h, d, mat(C.white, 0.6), 0, h / 2),
      box(w * 0.47, h * 0.92, d * 0.06, mat(0xdcdcd6, 0.55), -w * 0.245, h / 2, d / 2),
      box(w * 0.47, h * 0.92, d * 0.06, mat(0xdcdcd6, 0.55), w * 0.245, h / 2, d / 2),
      box(0.02, 0.12, 0.02, mat(C.steel, 0.3, 0.7), -0.03, h / 2, d / 2 + 0.02),
      box(0.02, 0.12, 0.02, mat(C.steel, 0.3, 0.7), 0.03, h / 2, d / 2 + 0.02),
    ),

  dining_table: ({ x: w, y: h, z: d }) => {
    const topT = 0.05;
    const parts: THREE.Object3D[] = [box(w, topT, d, mat(C.wood), 0, h - topT / 2)];
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        parts.push(box(0.06, h - topT, 0.06, mat(C.darkWood), sx * (w / 2 - 0.1), (h - topT) / 2, sz * (d / 2 - 0.1)));
      }
    }
    return group(...parts);
  },

  dining_chair: ({ x: w, y: h, z: d }) => {
    const seatH = h * 0.5;
    const parts: THREE.Object3D[] = [
      box(w, 0.05, d, mat(C.wood), 0, seatH),
      box(w, h - seatH, 0.045, mat(C.wood), 0, seatH + (h - seatH) / 2, -d / 2 + 0.03),
    ];
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        parts.push(box(0.04, seatH, 0.04, mat(C.darkWood), sx * (w / 2 - 0.05), seatH / 2, sz * (d / 2 - 0.05)));
      }
    }
    return group(...parts);
  },

  kettle: ({ x: w, y: h }) =>
    group(
      cyl(w * 0.45, w * 0.5, h * 0.82, mat(C.steel, 0.25, 0.85), 0, h * 0.41),
      cyl(w * 0.2, w * 0.2, 0.03, mat(C.black, 0.5), 0, h * 0.85),
      box(0.05, 0.02, 0.012, mat(C.black, 0.6), w * 0.3, h * 0.62),
      box(0.02, 0.06, 0.012, mat(C.black, 0.6), w * 0.33, h * 0.6),
    ),

  microwave: ({ x: w, y: h, z: d }) =>
    group(
      box(w, h, d, mat(0xb8bcc0, 0.5, 0.3), 0, h / 2),
      box(w * 0.66, h * 0.76, 0.012, mat(C.screen, 0.2, 0.4), -w * 0.13, h / 2, d / 2 + 0.006),
      box(w * 0.22, h * 0.8, 0.01, mat(0x8d9298, 0.5), w * 0.35, h / 2, d / 2 + 0.008),
    ),

  trash_bin: ({ x: w, y: h }) =>
    group(
      cyl(w / 2, w / 2.6, h * 0.88, mat(0x5b6169, 0.6), 0, h * 0.44),
      cyl(w / 2 + 0.012, w / 2 + 0.012, 0.03, mat(0x3d4249, 0.6), 0, h * 0.9),
      cyl(w * 0.22, w * 0.22, 0.02, mat(0x3d4249, 0.6), 0, h * 0.92),
    ),

  bed: ({ x: w, y: h, z: d }) =>
    group(
      box(w, h * 0.35, d, mat(C.darkWood), 0, h * 0.175),
      box(w * 0.96, h * 0.5, d * 0.97, mat(C.white, 0.9), 0, h * 0.55),
      box(w * 0.96, h * 0.12, d * 0.55, mat(0x8f9bb0, 0.95), 0, h * 0.83, d * 0.2),
      box(w * 0.7, h * 0.14, d * 0.2, mat(C.paper, 0.95), 0, h * 0.87, -d * 0.32),
      box(w, h * 0.5, d * 0.05, mat(C.darkWood), 0, h * 0.75, -d / 2 + 0.02),
    ),

  nightstand: ({ x: w, y: h, z: d }) =>
    group(
      box(w, h, d, mat(C.wood), 0, h / 2),
      box(w * 0.8, h * 0.32, 0.02, mat(C.darkWood), 0, h * 0.68, d / 2 + 0.006),
      box(w * 0.8, h * 0.32, 0.02, mat(C.darkWood), 0, h * 0.3, d / 2 + 0.006),
      box(w * 0.3, 0.02, 0.02, mat(C.metal), 0, h * 0.68, d / 2 + 0.03),
      box(w * 0.3, 0.02, 0.02, mat(C.metal), 0, h * 0.3, d / 2 + 0.03),
    ),

  table_lamp: ({ y: h }) =>
    group(
      cyl(0.09, 0.11, 0.025, mat(C.metal), 0, 0.012),
      cyl(0.014, 0.014, h * 0.55, mat(C.steel), 0, h * 0.29),
      cyl(0.1, 0.145, h * 0.38, emissive(0xf7e6c4, 0.55), 0, h * 0.75),
    ),

  wardrobe: ({ x: w, y: h, z: d }) =>
    group(
      box(w, h, d, mat(C.wood), 0, h / 2),
      box(w * 0.02, h * 0.96, d * 0.04, mat(C.darkWood), 0, h / 2, d / 2),
      box(0.025, h * 0.16, 0.025, mat(C.metal), -0.05, h * 0.5, d / 2 + 0.02),
      box(0.025, h * 0.16, 0.025, mat(C.metal), 0.05, h * 0.5, d / 2 + 0.02),
      box(w * 0.9, h * 0.06, 0.01, mat(C.darkWood), 0, h * 0.98, d / 2),
    ),

  desk: ({ x: w, y: h, z: d }) => {
    const topT = 0.05;
    const parts: THREE.Object3D[] = [
      box(w, topT, d, mat(C.wood), 0, h - topT / 2),
      box(w * 0.32, h * 0.55, d * 0.9, mat(C.darkWood), w * 0.3, h * 0.42),
      box(w * 0.3, 0.02, 0.02, mat(C.metal), w * 0.3, h * 0.5, d * 0.46),
    ];
    for (const sx of [-1, 1]) {
      parts.push(box(0.05, h - topT, 0.05, mat(C.darkWood), sx * (w / 2 - 0.08), (h - topT) / 2, -d / 2 + 0.08));
      parts.push(box(0.05, h - topT, 0.05, mat(C.darkWood), sx * (w / 2 - 0.08), (h - topT) / 2, d / 2 - 0.08));
    }
    return group(...parts);
  },

  desk_chair: ({ x: w, y: h, z: d }) => {
    const seatH = h * 0.52;
    return group(
      cyl(w * 0.36, w * 0.36, 0.03, mat(C.black, 0.5), 0, 0.015),
      cyl(0.03, 0.03, seatH - 0.05, mat(C.steel, 0.3, 0.7), 0, (seatH - 0.05) / 2 + 0.03),
      box(w, 0.06, d, mat(C.fabricDark), 0, seatH),
      box(w, h - seatH - 0.1, 0.05, mat(C.fabricDark), 0, seatH + (h - seatH) / 2, -d / 2 + 0.05),
    );
  },

  mirror: ({ x: w, y: h, z: d }) =>
    group(
      box(w, h, d, mat(C.brass, 0.4, 0.6), 0, h / 2),
      box(w * 1.6, h * 0.9, d * 1.6, mat(0xa8c4d4, 0.12, 0.85), 0, h / 2),
    ),

  shoe_rack: ({ x: w, y: h, z: d }) => {
    const parts: THREE.Object3D[] = [];
    for (let i = 0; i < 3; i++) {
      parts.push(box(w, 0.03, d, mat(C.wood), 0, 0.08 + i * (h - 0.12) / 2));
    }
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        parts.push(box(0.035, h, 0.035, mat(C.darkWood), sx * (w / 2 - 0.04), h / 2, sz * (d / 2 - 0.04)));
      }
    }
    parts.push(box(0.24, 0.09, 0.3, mat(C.black, 0.85), -w * 0.2, 0.14, 0));
    parts.push(box(0.24, 0.09, 0.3, mat(0x3f4650, 0.85), w * 0.2, 0.14, 0.02));
    return group(...parts);
  },

  doormat: ({ x: w, y: h, z: d }) =>
    group(
      box(w, h, d, mat(0x6a5c46, 0.98), 0, h / 2),
      box(w * 0.9, h * 0.7, d * 0.88, mat(0x7d6d53, 0.98), 0, h * 0.62),
    ),

  coat_hook: ({ x: w, y: h }) =>
    group(
      box(w, 0.12, 0.03, mat(C.wood), 0, h - 0.06),
      cyl(0.025, 0.025, 0.03, mat(C.metal), -w * 0.3, h - 0.15),
      cyl(0.025, 0.025, 0.03, mat(C.metal), 0, h - 0.15),
      cyl(0.025, 0.025, 0.03, mat(C.metal), w * 0.3, h - 0.15),
      box(0.34, 0.62, 0.1, mat(0x37414f, 0.95), -w * 0.3, h - 0.48),
      box(0.3, 0.5, 0.09, mat(0x5a4a3a, 0.95), w * 0.3, h - 0.42),
    ),

  umbrella_stand: ({ x: w, y: h }) =>
    group(
      cyl(w / 2, w / 2.4, h, mat(0x707880, 0.55, 0.3), 0, h / 2),
      cyl(0.012, 0.012, h * 1.5, mat(0x2f3a45), w * 0.12, h * 0.75),
      cyl(0.012, 0.012, h * 1.35, mat(0x3b4a55), -w * 0.1, h * 0.68),
    ),

  key_bowl: ({ x: w, y: h }) => {
    const s = sph(w / 2, mat(C.ceramic, 0.4), 0, h, 0);
    s.scale.y = 0.8;
    return group(
      s,
      box(0.05, 0.008, 0.02, mat(C.brass, 0.3, 0.8), w * 0.1, h + 0.03),
    );
  },
};

/* ======================================================================== *
 *  Foreign objects — the AI-generated intruders. Loud silhouettes.
 * ======================================================================== */

const FOREIGN: Partial<Record<PropKind, Builder>> = {
  duck: ({ x: w, y: h }) => {
    const bodyR = w * 0.42;
    const body = ellipsoid(bodyR, bodyR * 0.9, bodyR * 1.25, mat(0xffd93b, 0.35), 0, h * 0.36);
    return group(
      body,
      sph(w * 0.26, mat(0xffd93b, 0.35), 0, h * 0.78, w * 0.24),
      cone(w * 0.14, w * 0.3, mat(0xff8c2b, 0.3), 0, h * 0.76, w * 0.55).rotateX(Math.PI / 2),
      sph(w * 0.045, mat(0x14161a, 0.2), w * 0.11, h * 0.85, w * 0.42),
      sph(w * 0.045, mat(0x14161a, 0.2), -w * 0.11, h * 0.85, w * 0.42),
    );
  },

  gnome: ({ x: w, y: h }) =>
    group(
      cone(w * 0.42, h * 0.5, mat(0x2f6bb0, 0.7), 0, h * 0.25),
      sph(w * 0.3, mat(0xf2c9a4, 0.8), 0, h * 0.56),
      cone(w * 0.3, h * 0.42, mat(0xd8462f, 0.7), 0, h * 0.8),
      ellipsoid(w * 0.26, w * 0.2, w * 0.2, mat(0xf0f0ec, 0.95), 0, h * 0.42, w * 0.12),
      sph(w * 0.04, mat(0x14161a), w * 0.1, h * 0.6, w * 0.24),
      sph(w * 0.04, mat(0x14161a), -w * 0.1, h * 0.6, w * 0.24),
    ),

  cone: ({ x: w, y: h }) =>
    group(
      box(w, 0.05, w, mat(0xe0551a, 0.8), 0, 0.025),
      cone(w * 0.42, h * 0.95, mat(0xff6b1a, 0.75), 0, h * 0.52),
      cyl(w * 0.2, w * 0.28, h * 0.1, mat(0xf2f4f8, 0.6), 0, h * 0.6),
      cyl(w * 0.1, w * 0.17, h * 0.09, mat(0xf2f4f8, 0.6), 0, h * 0.78),
    ),

  shark: ({ x: w, y: h }) => {
    const body = ellipsoid(w * 0.2, h * 0.26, w * 0.5, mat(0x7d8b99, 0.7), 0, h * 0.5);
    return group(
      body,
      ellipsoid(w * 0.16, h * 0.2, w * 0.16, mat(0x8f9ca8, 0.7), 0, h * 0.44, w * 0.48),
      cone(w * 0.14, h * 0.34, mat(0x6d7b88, 0.7), 0, h * 0.86, -w * 0.02),
      box(w * 0.03, h * 0.18, w * 0.3, mat(0x6d7b88, 0.7), 0, h * 0.66, -w * 0.3),
      cone(w * 0.12, h * 0.3, mat(0x6d7b88, 0.7), 0, h * 0.62, -w * 0.5).rotateX(-Math.PI / 2),
      sph(w * 0.035, mat(0x0d0f12, 0.2), w * 0.12, h * 0.62, w * 0.3),
      sph(w * 0.035, mat(0x0d0f12, 0.2), -w * 0.12, h * 0.62, w * 0.3),
    );
  },

  horse: ({ x: w, y: h }) => {
    const parts: THREE.Object3D[] = [
      box(w, h * 0.36, w * 0.42, mat(0xb5793c, 0.85), 0, h * 0.62),
      box(w * 0.16, h * 0.34, w * 0.18, mat(0xa06a34, 0.85), 0, h * 0.85, -w * 0.24).rotateX(-0.5),
      box(w * 0.3, w * 0.2, w * 0.24, mat(0xb5793c, 0.85), 0, h * 0.96, -w * 0.34),
      box(w * 0.06, h * 0.2, w * 0.08, mat(0x6b4a22, 0.9), w * 0.12, h * 1.05, -w * 0.42),
    ];
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        parts.push(box(w * 0.09, h * 0.46, w * 0.09, mat(0xa06a34, 0.85), sx * w * 0.36, h * 0.23, sz * w * 0.14));
      }
    }
    return group(...parts);
  },

  washer: ({ x: w, y: h, z: d }) =>
    group(
      box(w, h, d, mat(0xdfe4ea, 0.4, 0.2), 0, h / 2),
      cyl(w * 0.3, w * 0.3, 0.04, mat(0x2b3038, 0.2, 0.5), 0, h * 0.5, d / 2).rotateX(Math.PI / 2),
      cyl(w * 0.24, w * 0.24, 0.02, mat(0x8fb6cf, 0.1, 0.6), 0, h * 0.5, d / 2 + 0.03).rotateX(Math.PI / 2),
      box(w * 0.9, h * 0.12, 0.02, mat(0xc6ccd2, 0.5), 0, h * 0.92, d / 2 + 0.01),
      sph(0.03, mat(0x3a7bd5), w * 0.3, h * 0.92, d / 2 + 0.03),
    ),

  vending: ({ x: w, y: h, z: d }) =>
    group(
      box(w, h, d, mat(0xe23b3b, 0.5), 0, h / 2),
      box(w * 0.82, h * 0.52, 0.03, mat(0x1d2733, 0.15, 0.3), 0, h * 0.66, d / 2 + 0.02),
      box(w * 0.82, h * 0.16, 0.03, mat(0xf5f7fa, 0.6), 0, h * 0.28, d / 2 + 0.02),
      box(w * 0.4, h * 0.04, 0.03, mat(0x14161a, 0.4), -w * 0.2, h * 0.44, d / 2 + 0.03),
      box(w * 0.6, h * 0.05, 0.02, mat(0xffcc33, 0.5), 0, h * 0.86, d / 2 + 0.03),
      ...[-0.28, 0, 0.28].map((o, i) =>
        box(w * 0.16, h * 0.24, 0.02, mat([0xf0c419, 0x4fa3d1, 0xe0724a][i], 0.5), o * w, h * 0.62, d / 2 + 0.05)),
    ),

  astronaut: ({ x: w, y: h }) =>
    group(
      sph(w * 0.46, mat(0xcfd6de, 0.35, 0.35), 0, h * 0.55),
      sph(w * 0.38, mat(0xd9a531, 0.12, 0.9), w * 0.1, h * 0.56, w * 0.28),
      cyl(w * 0.44, w * 0.5, h * 0.16, mat(0xaeb6bf, 0.4, 0.4), 0, h * 0.1),
      box(w * 0.5, h * 0.06, w * 0.5, mat(0x9aa3ad, 0.5), 0, h * 0.03),
      box(0.06, 0.1, 0.04, mat(0xd9a531, 0.3, 0.8), w * 0.24, h * 0.78, w * 0.18),
    ),

  flamingo: ({ x: w, y: h }) => {
    const legH = h * 0.5;
    return group(
      cyl(0.018, 0.018, legH, mat(0xe8a0b8, 0.6), w * 0.1, legH / 2),
      cyl(0.018, 0.018, legH * 0.94, mat(0xe8a0b8, 0.6), -w * 0.1, legH * 0.47),
      ellipsoid(w * 0.42, h * 0.16, w * 0.26, mat(0xff7fb0, 0.6), 0, legH + h * 0.14),
      cyl(0.05, 0.05, h * 0.3, mat(0xff96c0, 0.6), w * 0.16, legH + h * 0.3),
      cyl(0.045, 0.045, h * 0.16, mat(0xff96c0, 0.6), w * 0.26, legH + h * 0.44),
      sph(w * 0.11, mat(0xffa8cc, 0.6), w * 0.3, legH + h * 0.52),
      cone(w * 0.05, w * 0.2, mat(0x2b2b2b, 0.5), w * 0.42, legH + h * 0.5).rotateZ(-Math.PI / 2),
    );
  },

  toilet: ({ x: w, y: h, z: d }) =>
    group(
      cyl(w * 0.28, w * 0.34, h * 0.4, mat(C.ceramic, 0.2), 0, h * 0.2),
      ellipsoid(w * 0.4, h * 0.12, d * 0.42, mat(C.ceramic, 0.2), 0, h * 0.44),
      box(w * 0.8, h * 0.5, d * 0.3, mat(C.ceramic, 0.2), 0, h * 0.6, -d * 0.36),
      cyl(0.03, 0.03, 0.04, mat(C.steel, 0.3, 0.8), w * 0.3, h * 0.86, -d * 0.36),
    ),

  cactus: ({ x: w, y: h }) =>
    group(
      cyl(w * 0.32, w * 0.26, h * 0.18, mat(0xb5623c, 0.9), 0, h * 0.09),
      cyl(w * 0.13, w * 0.14, h * 0.82, mat(0x3f8f52, 0.85), 0, h * 0.5),
      cyl(w * 0.075, w * 0.075, h * 0.3, mat(0x3f8f52, 0.85), w * 0.16, h * 0.56).rotateZ(Math.PI / 5),
      cyl(w * 0.075, w * 0.075, h * 0.34, mat(0x3f8f52, 0.85), w * 0.26, h * 0.7),
      cyl(w * 0.07, w * 0.07, h * 0.24, mat(0x3f8f52, 0.85), -w * 0.15, h * 0.44).rotateZ(-Math.PI / 5),
      cyl(w * 0.07, w * 0.07, h * 0.28, mat(0x3f8f52, 0.85), -w * 0.24, h * 0.56),
    ),

  eye: ({ x: w, y: h }) =>
    group(
      sph(w * 0.46, mat(0xf2f4f7, 0.25), 0, h * 0.5),
      cyl(w * 0.2, w * 0.2, 0.02, mat(0x4a86c8, 0.3), 0, h * 0.5, w * 0.42).rotateX(Math.PI / 2),
      cyl(w * 0.09, w * 0.09, 0.02, mat(0x0c0e11, 0.2), 0, h * 0.5, w * 0.44).rotateX(Math.PI / 2),
      ...Array.from({ length: 6 }, (_, i) => {
        const a = (i / 6) * Math.PI * 2;
        return cyl(0.012, 0.012, w * 0.5, mat(0xd8412f, 0.7), Math.cos(a) * w * 0.24, Math.sin(a) * w * 0.24 + h * 0.5, w * 0.2);
      }),
    ),

  mannequin: ({ x: w, y: h }) => {
    const torso = ellipsoid(w * 0.32, h * 0.26, w * 0.2, mat(0xeceae4, 0.5), 0, h * 0.68);
    return group(
      cyl(w * 0.3, w * 0.34, 0.04, mat(0x3a3f45, 0.5, 0.3), 0, 0.02),
      cyl(0.03, 0.03, h * 0.5, mat(0x9aa3ad, 0.3, 0.8), 0, h * 0.28),
      torso,
      ellipsoid(w * 0.3, h * 0.1, w * 0.18, mat(0xeceae4, 0.5), 0, h * 0.5),
      cyl(w * 0.09, w * 0.07, h * 0.14, mat(0xe2e0d9, 0.5), 0, h * 0.94),
    );
  },

  milk: ({ x: w, y: h }) =>
    group(
      box(w * 0.7, h * 0.82, w * 0.7, mat(0xf5f7fa, 0.55), 0, h * 0.41),
      cone(w * 0.44, h * 0.2, mat(0xf5f7fa, 0.55), 0, h * 0.92, 0, 4),
      box(w * 0.44, h * 0.2, 0.01, mat(0x4a86c8, 0.6), 0, h * 0.5, w * 0.36),
      box(w * 0.4, h * 0.1, 0.01, mat(0xe23b3b, 0.6), 0, h * 0.26, w * 0.36),
    ),

  piano: ({ x: w, y: h, z: d }) =>
    group(
      box(w, h * 0.22, d, mat(C.black, 0.25, 0.15), 0, h * 0.62),
      box(w * 0.94, h * 0.5, d * 0.96, mat(0x181a1e, 0.3), 0, h * 0.36),
      box(w * 0.96, h * 0.03, d * 0.94, mat(0xf4f6f8, 0.5), 0, h * 0.52),
      box(w, 0.04, d, mat(0x0e1013, 0.2), 0, h * 0.74, -d * 0.02).rotateX(-0.35),
      cyl(0.04, 0.05, h * 0.62, mat(C.black, 0.3), -w * 0.4, h * 0.31, d * 0.36),
      cyl(0.04, 0.05, h * 0.62, mat(C.black, 0.3), w * 0.4, h * 0.31, d * 0.36),
      cyl(0.05, 0.06, h * 0.62, mat(C.black, 0.3), -w * 0.2, h * 0.31, -d * 0.42),
    ),

  /* ---- horror placeholders -------------------------------------------------
   * These are the 'stare' pool. They are deliberately the only props in the
   * game with no plausible reason to exist in a flat, which is what makes the
   * "does this belong here?" question answerable at a glance.
   * ------------------------------------------------------------------------ */

  face: ({ x: w, y: h }) =>
    group(
      // a flattened head, so the face reads from the front and is obvious from the side
      ellipsoid(w * 0.46, h * 0.5, w * 0.24, mat(0xd9cfc4, 0.66), 0, h * 0.5),
      sph(w * 0.105, mat(0x07080a, 0.12), -w * 0.17, h * 0.58, w * 0.19),
      sph(w * 0.105, mat(0x07080a, 0.12), w * 0.17, h * 0.58, w * 0.19),
      box(w * 0.24, h * 0.055, 0.012, mat(0x2a1015, 0.5), 0, h * 0.28, w * 0.21),
      box(w * 0.12, h * 0.03, 0.012, mat(0x7a2630, 0.6), 0, h * 0.2, w * 0.2),
    ),

  figure: ({ x: w, y: h }) =>
    group(
      cyl(w * 0.34, w * 0.48, h * 0.8, mat(0x0a0b0d, 0.97), 0, h * 0.4),
      sph(w * 0.23, mat(0x07080a, 0.97), 0, h * 0.9),
      cyl(w * 0.32, w * 0.36, h * 0.08, mat(0x0a0b0d, 0.97), 0, h * 0.04),
      // shoulders, so the silhouette is unmistakably a standing person
      ellipsoid(w * 0.46, h * 0.05, w * 0.2, mat(0x0a0b0d, 0.97), 0, h * 0.78),
    ),

  hand: ({ x: w, y: h }) =>
    group(
      box(w * 0.64, h * 0.44, h * 0.52, mat(0xcfc2b6, 0.74), 0, h * 0.28),
      ...Array.from({ length: 4 }, (_, i) =>
        cyl(w * 0.058, w * 0.05, h * 0.5, mat(0xcfc2b6, 0.74), (i - 1.5) * w * 0.15, h * 0.72),
      ),
      cyl(w * 0.062, w * 0.055, h * 0.38, mat(0xcfc2b6, 0.74), w * 0.36, h * 0.42).rotateZ(-0.75),
      cyl(w * 0.16, w * 0.19, h * 0.16, mat(0x8c2f38, 0.85), 0, h * 0.06),
    ),

  doll: ({ x: w, y: h }) =>
    group(
      cone(w * 0.44, h * 0.54, mat(0x2b2f3a, 0.9), 0, h * 0.27, 0, 14),
      sph(w * 0.27, mat(0xe8e0d4, 0.52), 0, h * 0.75),
      sph(w * 0.078, mat(0x07080a, 0.16), -w * 0.1, h * 0.79, w * 0.22),
      sph(w * 0.078, mat(0x07080a, 0.16), w * 0.1, h * 0.79, w * 0.22),
      // a hairline crack down the face
      box(0.01, h * 0.16, 0.01, mat(0x3a2f2a, 0.9), w * 0.05, h * 0.72, w * 0.26),
      cyl(w * 0.052, w * 0.052, h * 0.17, mat(0xe8e0d4, 0.62), -w * 0.27, h * 0.46).rotateZ(0.55),
      cyl(w * 0.052, w * 0.052, h * 0.17, mat(0xe8e0d4, 0.62), w * 0.27, h * 0.46).rotateZ(-0.55),
    ),

  teeth: ({ x: w, y: h }) =>
    group(
      cyl(w * 0.3, w * 0.32, h * 0.5, mat(0x8c2f38, 0.86), 0, h * 0.25),
      ...Array.from({ length: 12 }, (_, i) => {
        const a = (i / 12) * Math.PI * 2;
        return box(w * 0.17, h, w * 0.17, mat(0xf0ece2, 0.4), Math.cos(a) * w * 0.44, h * 0.62, Math.sin(a) * w * 0.44);
      }),
    ),

  stain: ({ x: w, y: h }) =>
    group(
      // a flat, low pool — reads as wrong from across the room because a floor
      // should not be that colour
      cyl(w * 0.5, w * 0.54, h, mat(0x2a0708, 0.55), 0, h * 0.5),
      cyl(w * 0.3, w * 0.34, h * 0.9, mat(0x3d0a0c, 0.5), w * 0.36, h * 0.45),
      cyl(w * 0.18, w * 0.2, h * 0.8, mat(0x3d0a0c, 0.5), -w * 0.38, h * 0.4, w * 0.22),
    ),
};

/* ======================================================================== *
 *  Public API
 * ======================================================================== */

const BUILDERS: Partial<Record<PropKind, Builder>> = { ...FURNITURE, ...FOREIGN };

export function createProp(kind: PropKind, size: Vec3): THREE.Object3D {
  const builder = BUILDERS[kind] ?? FURNITURE.sofa!;
  const obj = builder(size);
  obj.name = kind;
  return obj;
}

/** Recolour every mesh under `root` — used by the 'warp' (colour) anomaly. */
export function tintProp(root: THREE.Object3D, color: number): void {
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const source = mesh.material as THREE.MeshStandardMaterial;
    const replacement = new THREE.MeshStandardMaterial({
      color: new THREE.Color(color),
      roughness: source.roughness ?? 0.8,
      metalness: source.metalness ?? 0.05,
      emissive: new THREE.Color(color).multiplyScalar(source.emissiveIntensity ? 0.35 : 0),
      emissiveIntensity: source.emissiveIntensity ?? 0,
    });
    mesh.material = replacement;
  });
}

/** True when this prop kind is an AI-generated foreign object. */
export function isForeign(kind: PropKind): boolean {
  return kind in FOREIGN;
}

export const MATERIALS = { mat, emissive, palette: C };
