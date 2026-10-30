// Zero-dependency static file server for the demo (ticket 13).
//
// The demo needs no bundler: wasm-pack's `--target web` output (pkg/) and
// the demo's own ES modules are served as-is. This server exists because
// module workers + wasm streaming instantiation require http:// origins
// (file:// will not do), and we avoid pulling in a dev-server dependency.
//
// Run: `node demo/serve.mjs` (or `pnpm demo`), then open
// http://localhost:5177/demo/

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 5177;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const server = createServer(async (req, res) => {
  try {
    // Resolve the URL path under the repo root; reject anything escaping it.
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let filePath = normalize(join(ROOT, urlPath));
    if (!filePath.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    if (urlPath === '/' || urlPath === '/demo' || urlPath === '/demo/') {
      // Redirect, don't rewrite: index.html's relative imports (./main.js,
      // ../node_modules/...) resolve against the URL path — serving the file
      // at /demo/ would resolve ./main.js to /main.js (404).
      res.writeHead(302, { location: '/demo/index.html' }).end();
      return;
    }
    const body = await readFile(filePath);
    res.writeHead(200, { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

server.listen(PORT, () => {
  console.log(`demo: http://localhost:${PORT}/demo/  (Ctrl+C to stop)`);
});
