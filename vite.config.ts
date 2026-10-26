import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5273,
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      // resolved relative to the project root; avoids importing node:url and
      // therefore needing @types/node just for a path
      input: {
        // the game, on the three.js backend with a procedurally built room
        index: 'index.html',
        // the same game on the 3DGS backend, in a real reconstructed room
        splat: 'splat.html',
        // the 3DGS scene inspector; also what tools/probe.mjs drives headlessly
        spike: 'spike.html',
      },
    },
  },
  // .glb / .ply / .spz assets are served as raw files from /public
  assetsInclude: ['**/*.glb', '**/*.gltf', '**/*.ply', '**/*.spz', '**/*.sog'],
});
