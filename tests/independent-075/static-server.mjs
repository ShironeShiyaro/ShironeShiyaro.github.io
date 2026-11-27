// Minimal static server for the already-built `apps/site/dist`.
//
// `astro preview` refuses to start a second instance while another preview is
// running in the same project (a concurrent agent owns the assigned port during
// this independent round), so the independent suite serves the same build output
// directly. It is still the real `astro build` output, not a fixture.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';

const root = resolve(process.argv[2] ?? '');
const port = Number(process.argv[3] ?? '4324');
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
    let target = pathname.endsWith('/') ? `${pathname}index.html` : pathname;
    if (extname(target) === '') target = `${target}.html`;
    let absolute = resolve(root, `.${target}`);
    if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) {
      response.writeHead(403);
      response.end('forbidden');
      return;
    }
    let info = await stat(absolute);
    if (info.isDirectory()) {
      absolute = join(absolute, 'index.html');
      info = await stat(absolute);
    }
    const body = request.method === 'HEAD' ? null : await readFile(absolute);
    response.writeHead(200, {
      'content-type': types[extname(absolute)] ?? 'application/octet-stream',
      'content-length': info.size,
      'cache-control': 'no-store',
    });
    response.end(body);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('not found');
  }
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`static site server: ${root} on http://127.0.0.1:${port}\n`);
});
