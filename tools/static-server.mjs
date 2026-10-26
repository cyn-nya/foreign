/**
 * A throwaway static server for the built `dist/`.
 *
 * Shared by the acceptance harness and the recorder so both serve the real build
 * with the same content types — a demo video captured against a differently
 * served build would not be evidence about the artifact that ships.
 */

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary',
  '.wasm': 'application/wasm',
}

/**
 * Serve `dir` on an ephemeral port.
 *
 * Resolves to `{ url, port, close }`. Any unknown path falls back to
 * `index.html`, which is what a single-page build expects.
 *
 * `basePath` mounts everything under a prefix, which is how a GitHub Pages
 * project site is served (`https://user.github.io/repo/`). Testing that locally
 * is the difference between finding a sub-path bug here and finding it after
 * the demo link has been submitted.
 */
export function startStatic(dir, { basePath = '' } = {}) {
  const root = path.resolve(dir)
  const prefix = basePath.replace(/\/+$/, '')
  const server = http.createServer((req, res) => {
    let url = decodeURIComponent((req.url ?? '/').split('?')[0])
    if (prefix) {
      if (url === prefix || url === `${prefix}/`) url = '/'
      else if (url.startsWith(`${prefix}/`)) url = url.slice(prefix.length)
      else {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('outside base path')
        return
      }
    }
    let file = path.join(root, url === '/' ? 'index.html' : url)
    if (!file.startsWith(root)) {
      res.writeHead(403).end('forbidden')
      return
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html')
    const body = fs.readFileSync(file)
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' })
    res.end(body)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      resolve({
        port,
        url: `http://127.0.0.1:${port}${prefix}`,
        close: () => new Promise((done) => server.close(done)),
      })
    })
  })
}
