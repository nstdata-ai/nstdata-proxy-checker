import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tlsMaterial(t, { san = 'DNS:localhost,IP:127.0.0.1', commonName = 'localhost', missingIntermediate = false } = {}) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'nstdata-proxy-tls-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const keyFile = path.join(dir, 'key.pem'), certFile = path.join(dir, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile,
        '-days', '1', '-subj', `/CN=${commonName}`, '-addext', `subjectAltName=${san}`,
        '-addext', 'basicConstraints=critical,CA:TRUE'], { stdio: 'pipe', timeout: 10000 });
    if (missingIntermediate) {
        const run = args => execFileSync('openssl', args, { stdio: 'pipe', timeout: 10000 });
        const file = name => path.join(dir, name);
        writeFileSync(file('intermediate.ext'), 'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n');
        writeFileSync(file('leaf.ext'), `basicConstraints=critical,CA:FALSE\nsubjectAltName=${san}\nextendedKeyUsage=serverAuth\n`);
        for (const name of ['intermediate', 'leaf']) {
            run(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', file(name + '.key'),
                '-out', file(name + '.csr'), '-subj', `/CN=${name === 'leaf' ? commonName : 'Fixture intermediate'}`]);
            run(['x509', '-req', '-in', file(name + '.csr'), '-CA', name === 'leaf' ? file('intermediate.pem') : certFile,
                '-CAkey', name === 'leaf' ? file('intermediate.key') : keyFile, '-CAcreateserial',
                '-out', file(name + '.pem'), '-days', '1', '-extfile', file(name + '.ext')]);
        }
        // Trust the root, but deliberately omit the intermediate from the presented chain.
        return { key: readFileSync(file('leaf.key')), cert: readFileSync(file('leaf.pem')), certFile };
    }
    return { key: readFileSync(keyFile), cert: readFileSync(certFile), certFile };
}

export async function listen(t, server) {
    const sockets = new Set();
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => {
        const closed = new Promise(resolve => server.close(resolve));
        for (const socket of sockets) socket.destroy();
        await closed;
    });
    return server.address().port;
}

export async function proxyFixture(t, options = {}) {
    const requests = [], connections = [];
    const handler = (req, res) => {
        requests.push({ url: req.url, headers: req.headers });
        const url = new URL(req.url);
        const headers = { ...req.headers }; delete headers['proxy-authorization']; delete headers['proxy-connection'];
        const upstream = http.request(url, { headers }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
        upstream.on('error', () => { res.writeHead(502); res.end(); });
        req.pipe(upstream);
    };
    const proxy = options.tls ? https.createServer(options.tls, handler) : http.createServer(handler);
    proxy.on('connect', (req, client, head) => {
        let closed;
        const connection = { authority: req.url, headers: req.headers, closed: new Promise(resolve => { closed = resolve; }) };
        connections.push(connection);
        client.on('close', closed);
        options.onConnect?.(connection);
        if (options.largeConnectHeaders) {
            client.write(`HTTP/1.1 200 OK\r\nX-Oversized: ${'x'.repeat(20000)}`);
            client.on('end', () => client.end()); client.resume(); return;
        }
        if (options.hangConnect) { client.on('end', () => client.end()); client.resume(); return; }
        if (options.connectStatus) { client.end(`HTTP/1.1 ${options.connectStatus} Denied\r\nContent-Length: 0\r\n\r\n`); return; }
        const port = Number(req.url.slice(req.url.lastIndexOf(':') + 1));
        const upstream = net.connect(port, '127.0.0.1', () => {
            client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head.length) upstream.write(head);
            upstream.pipe(client); client.pipe(upstream);
        });
        upstream.on('error', () => client.destroy());
        client.on('error', () => upstream.destroy());
        client.on('close', () => upstream.destroy());
        upstream.on('close', () => client.destroy());
    });
    const port = await listen(t, proxy);
    return { url: `${options.tls ? 'https' : 'http'}://fixture-user:fixture-password@127.0.0.1:${port}`, requests, connections };
}
