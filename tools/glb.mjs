/**
 * Export three.js objects to binary glTF (.glb) from Node.
 *
 * Why this exists: the game runs on `@manycore/aholo-viewer`, which is a
 * separate renderer with no BoxGeometry/CylinderGeometry helpers — primitives
 * have to be raw vertex buffers there. But three.js *is* a dependency and its
 * prop builders already exist and are tested, so the placeholders are built
 * once at authoring time with three.js, exported to .glb, and loaded back
 * through the viewer's own GLTFLoader. That keeps one source of geometry
 * instead of two.
 *
 * GLTFExporter's binary path uses `FileReader`, which Node does not have, so a
 * minimal shim is installed here. It must be asynchronous: the exporter calls
 * `readAsArrayBuffer(blob)` and only *then* assigns `onloadend`.
 *
 * Plain JavaScript on purpose — Node's TypeScript type-stripping only applies
 * to `.ts` files, so type annotations in a `.mjs` are a syntax error.
 */

import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

let installed = false;

function installFileReaderShim() {
  if (installed || typeof globalThis.FileReader !== 'undefined') return;
  installed = true;

  class NodeFileReader {
    constructor() {
      this.result = null;
      this.onloadend = null;
      this.onerror = null;
    }

    readAsArrayBuffer(blob) {
      blob.arrayBuffer().then(
        (buffer) => {
          this.result = buffer;
          if (this.onloadend) this.onloadend();
        },
        (error) => {
          if (this.onerror) this.onerror(error);
        },
      );
    }

    readAsDataURL(blob) {
      blob.arrayBuffer().then(
        (buffer) => {
          const type = blob.type || 'application/octet-stream';
          this.result = `data:${type};base64,${Buffer.from(buffer).toString('base64')}`;
          if (this.onloadend) this.onloadend();
        },
        (error) => {
          if (this.onerror) this.onerror(error);
        },
      );
    }
  }

  globalThis.FileReader = NodeFileReader;
}

/**
 * Serialise an object (or scene) to a .glb Buffer.
 * @param {THREE.Object3D} object
 * @returns {Promise<Buffer>}
 */
export async function exportGlb(object) {
  installFileReaderShim();
  const exporter = new GLTFExporter();
  const result = await exporter.parseAsync(object, { binary: true });
  const buffer = Buffer.from(result);
  if (buffer.subarray(0, 4).toString('ascii') !== 'glTF') {
    throw new Error('GLTFExporter produced a file without the glTF magic header');
  }
  return buffer;
}
