import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { BridgeClient, BridgeError } from '../src/bridge/client.ts';

interface Request {
	id: string;
	op: string;
	args: Record<string, unknown>;
}

type Handler = (socket: net.Socket, request: Request) => void;

interface FakeServer {
	port: number;
	connections: number;
	sockets: net.Socket[];
	close(): Promise<void>;
}

/** NDJSON server standing in for the Lua plugin. */
async function fakePlugin(handler: Handler): Promise<FakeServer> {
	const state: FakeServer = {
		port: 0,
		connections: 0,
		sockets: [],
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
	const server = net.createServer((socket) => {
		state.connections++;
		state.sockets.push(socket);
		socket.setEncoding('utf8');
		let buffer = '';
		socket.on('data', (chunk: string) => {
			buffer += chunk;
			let newline: number;
			while ((newline = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				handler(socket, JSON.parse(line) as Request);
			}
		});
		socket.on('error', () => {});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	state.port = (server.address() as net.AddressInfo).port;
	const close = state.close;
	state.close = async () => {
		for (const socket of state.sockets) {
			socket.destroy();
		}
		await close();
	};
	servers.push(state);

	return state;
}

function reply(socket: net.Socket, response: Record<string, unknown>): void {
	socket.write(JSON.stringify(response) + '\n');
}

async function freePort(): Promise<number> {
	const server = net.createServer();
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as net.AddressInfo;
	await new Promise<void>((resolve) => server.close(() => resolve()));

	return port;
}

async function catchBridgeError(promise: Promise<unknown>): Promise<BridgeError> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(BridgeError);

		return error as BridgeError;
	}
	throw new Error('expected the request to fail');
}

const servers: FakeServer[] = [];
const clients: BridgeClient[] = [];

function client(port: number, timeoutMs = 2000): BridgeClient {
	const bridge = new BridgeClient({ host: '127.0.0.1', port, timeoutMs, connectTimeoutMs: 1000 });
	clients.push(bridge);

	return bridge;
}

afterEach(async () => {
	for (const bridge of clients.splice(0)) {
		bridge.close();
	}
	for (const server of servers.splice(0)) {
		await server.close();
	}
});

describe('BridgeClient', () => {
	it('sends {id, op, args} and resolves with the result', async () => {
		const seen: Request[] = [];
		const server = await fakePlugin((socket, request) => {
			seen.push(request);
			reply(socket, { id: request.id, ok: true, result: { pong: true } });
		});

		await expect(client(server.port).request('ping', { a: 1 })).resolves.toEqual({ pong: true });
		expect(seen).toEqual([{ id: expect.any(String), op: 'ping', args: { a: 1 } }]);
	});

	it('matches out-of-order responses by id', async () => {
		const held: Request[] = [];
		const server = await fakePlugin((socket, request) => {
			held.push(request);

			if (held.length === 2) {
				// Answer the second request first.
				for (const pending of [...held].reverse()) {
					reply(socket, { id: pending.id, ok: true, result: pending.op });
				}
			}
		});
		const bridge = client(server.port);

		const first = bridge.request('first');
		const second = bridge.request('second');
		await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second']);
		expect(server.connections).toBe(1);
	});

	it('reassembles a response split across chunks, including a split multi-byte character', async () => {
		const server = await fakePlugin((socket, request) => {
			const bytes = Buffer.from(JSON.stringify({ id: request.id, ok: true, result: { name: 'Flüüfff ✓' } }) + '\n', 'utf8');
			// Cut inside the two-byte "ü".
			const cut = bytes.indexOf(Buffer.from('ü', 'utf8')) + 1;
			socket.write(bytes.subarray(0, cut));
			setTimeout(() => socket.write(bytes.subarray(cut, cut + 5)), 10);
			setTimeout(() => socket.write(bytes.subarray(cut + 5)), 20);
		});

		await expect(client(server.port).request('info')).resolves.toEqual({ name: 'Flüüfff ✓' });
	});

	it('ignores unparseable lines and responses for unknown ids', async () => {
		const server = await fakePlugin((socket, request) => {
			socket.write('not json\n');
			reply(socket, { id: 'nope', ok: true, result: 'wrong' });
			reply(socket, { id: request.id, ok: true, result: 'right' });
		});

		await expect(client(server.port).request('ping')).resolves.toBe('right');
	});

	it('rejects a plugin error with outcome failed and the plugin code', async () => {
		const server = await fakePlugin((socket, request) => {
			reply(socket, { id: request.id, ok: false, code: 'modal-open', error: 'a pop-up is open', traceback: 'tb' });
		});

		const error = await catchBridgeError(client(server.port).request('cmd'));
		expect(error).toMatchObject({ code: 'modal-open', outcome: 'failed', message: 'a pop-up is open', traceback: 'tb' });
	});

	it('times out with outcome unknown and ignores the late answer', async () => {
		const server = await fakePlugin((socket, request) => {
			if (request.op === 'slow') {
				setTimeout(() => reply(socket, { id: request.id, ok: true, result: 'late' }), 150);
			} else {
				reply(socket, { id: request.id, ok: true, result: 'fast' });
			}
		});
		const bridge = client(server.port, 50);

		const error = await catchBridgeError(bridge.request('slow'));
		expect(error).toMatchObject({ code: 'timeout', outcome: 'unknown' });
		await new Promise((resolve) => setTimeout(resolve, 200));
		await expect(bridge.request('fast')).resolves.toBe('fast');
	});

	it('fails pending requests with connection-lost when the plugin drops the connection', async () => {
		const server = await fakePlugin((socket) => socket.destroy());

		const error = await catchBridgeError(client(server.port).request('patch.apply'));
		expect(error).toMatchObject({ code: 'connection-lost', outcome: 'unknown' });
	});

	it('reports unreachable with outcome not-sent when nothing listens', async () => {
		const error = await catchBridgeError(client(await freePort()).request('ping'));
		expect(error).toMatchObject({ code: 'unreachable', outcome: 'not-sent' });
	});

	it('reconnects on the next request after a drop', async () => {
		let calls = 0;
		const server = await fakePlugin((socket, request) => {
			calls++;

			if (calls === 1) {
				socket.destroy();

				return;
			}

			reply(socket, { id: request.id, ok: true, result: 'again' });
		});
		const bridge = client(server.port);

		await catchBridgeError(bridge.request('ping'));
		await expect(bridge.request('ping')).resolves.toBe('again');
		expect(server.connections).toBe(2);
	});

	it('shares one connection attempt between concurrent first requests', async () => {
		const server = await fakePlugin((socket, request) => reply(socket, { id: request.id, ok: true, result: request.op }));
		const bridge = client(server.port);

		await expect(Promise.all([bridge.request('a'), bridge.request('b'), bridge.request('c')])).resolves.toEqual(['a', 'b', 'c']);
		expect(server.connections).toBe(1);
	});
});
