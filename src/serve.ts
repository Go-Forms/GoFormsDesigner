// serve.ts - a static file server for the WebAssembly build.
//
// A browser will not run a .wasm loaded from file://, so "open index.html"
// is not enough; the bundle has to come over HTTP. This is the smallest
// server that does that correctly: the right MIME type for .wasm (without
// it instantiateStreaming refuses the file), no caching (a rebuild must
// show up on reload), and only the loopback interface, so nothing on the
// network can reach it. It is Node's own http module, so it works with no
// installation and no connection.
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';

const types: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.webmanifest': 'application/manifest+json',
	'.wasm': 'application/wasm',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.svg': 'image/svg+xml',
	'.ico': 'image/x-icon',
	'.txt': 'text/plain; charset=utf-8',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.ttf': 'font/ttf',
};

interface Served {
	server: http.Server;
	url: string;
}

const servers = new Map<string, Served>();

/** Serves dir on a free loopback port (reusing a server already up for it)
 * and returns the URL of its index.html. */
export function serveDirectory(dir: string): Promise<string> {
	const existing = servers.get(dir);
	if (existing && existing.server.listening) {
		return Promise.resolve(existing.url);
	}

	const root = path.resolve(dir);
	const server = http.createServer((req, res) => {
		let urlPath: string;
		try {
			urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
		} catch {
			res.writeHead(400).end();
			return;
		}
		if (urlPath.endsWith('/')) {
			urlPath += 'index.html';
		}
		// Resolve inside the root only: a request for ../ must not read the
		// project's sources, or anything else.
		const file = path.resolve(root, '.' + urlPath);
		if (file !== root && !file.startsWith(root + path.sep)) {
			res.writeHead(403).end();
			return;
		}
		fs.stat(file, (err, stat) => {
			if (err || !stat.isFile()) {
				res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found: ' + urlPath);
				return;
			}
			res.writeHead(200, {
				'Content-Type': types[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
				'Content-Length': stat.size,
				'Cache-Control': 'no-store',
			});
			fs.createReadStream(file).pipe(res);
		});
	});

	return new Promise((resolve, reject) => {
		server.on('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const addr = server.address();
			const port = typeof addr === 'object' && addr ? addr.port : 0;
			const url = `http://127.0.0.1:${port}/`;
			servers.set(dir, { server, url });
			resolve(url);
		});
	});
}

/** Stops every server, for deactivation or on request, and reports how many
 * were running - a server nobody asked to stop should not claim it stopped
 * one. */
export function stopAllServers(): number {
	let stopped = 0;
	for (const { server } of servers.values()) {
		if (server.listening) {
			stopped++;
		}
		server.close();
	}
	servers.clear();
	return stopped;
}
