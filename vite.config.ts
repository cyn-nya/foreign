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
  },
  // .glb / .ply / .spz assets are served as raw files from /public
  assetsInclude: ['**/*.glb', '**/*.gltf', '**/*.ply', '**/*.spz', '**/*.sog'],
});
