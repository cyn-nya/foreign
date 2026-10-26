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
        // the game: FOREIGN played in a real reconstructed room (3DGS)
        index: 'index.html',
        // the same game on the three.js backend, in a procedurally built room.
        // Kept because it is a complete, independently verified build — and
        // because the comparison is worth showing.
        classic: 'classic.html',
        // the 3DGS scene inspector; also what tools/probe.mjs drives headlessly
        spike: 'spike.html',
      },
    },
  },
  // .glb / .ply / .spz assets are served as raw files from /public
  assetsInclude: ['**/*.glb', '**/*.gltf', '**/*.ply', '**/*.spz', '**/*.sog'],
});
