import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { once } from 'node:events';

// Serve exact archives for installation checks without contacting public registries.
export async function packageRegistry(packages) {
    const requests = [];
    const server = http.createServer((req, res) => {
        const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
        requests.push({ method: req.method, pathname, authorization: Boolean(req.headers.authorization) });
        if (req.method !== 'GET' || req.headers.authorization) { res.writeHead(403); res.end(); return; }
        for (const { manifest, archive, filename } of packages) {
            if (pathname === '/' + manifest.name) {
                const integrity = 'sha512-' + createHash('sha512').update(readFileSync(archive)).digest('base64');
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ name: manifest.name, 'dist-tags': { latest: manifest.version },
                    versions: { [manifest.version]: { ...manifest, dist: { integrity,
                        tarball: `http://127.0.0.1:${server.address().port}/${filename}` } } } }));
                return;
            }
            if (pathname === '/' + filename) {
                res.setHeader('Content-Type', 'application/octet-stream'); res.end(readFileSync(archive)); return;
            }
        }
        res.writeHead(404); res.end();
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    return { url: `http://127.0.0.1:${server.address().port}`, requests,
        close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
