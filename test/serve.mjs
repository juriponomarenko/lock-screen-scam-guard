// Minimal static server for samples/. Used by the e2e tests and by `npm run serve`.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'samples');

/** @returns {Promise<{origin: string, close: () => Promise<void>}>} */
export function startServer(port = 0) {
  const server = http.createServer(async (request, response) => {
    try {
      // Inside the try: a malformed escape such as "/%E0%A4%A" makes decodeURIComponent throw.
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      const file = path.resolve(ROOT, '.' + pathname);
      if (!file.startsWith(ROOT + path.sep) || path.extname(file) !== '.html') throw new Error('not served');
      const body = await readFile(file);
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(body);
    } catch {
      response.writeHead(404).end('Not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({
        origin: `http://localhost:${server.address().port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { origin } = await startServer(Number(process.env.PORT) || 8080);
  console.log(`Samples served at:\n  ${origin}/malicious.html\n  ${origin}/benign.html\n  ${origin}/extra/`);
}
