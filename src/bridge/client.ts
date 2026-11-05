import net from 'node:net';

/**
 * not-sent: the request never reached the plugin, so retrying is safe.
 * unknown:  it was sent but no answer came back; the console may or may not have acted.
 * failed:   the plugin answered with an error.
 */
export type BridgeOutcome = 'not-sent' | 'unknown' | 'failed';

export class BridgeError extends Error {
	readonly code: string;
	readonly outcome: BridgeOutcome;
	readonly traceback: string | undefined;

	constructor(message: string, code: string, outcome: BridgeOutcome, traceback?: string) {
		super(message);
		this.name = 'BridgeError';
		this.code = code;
		this.outcome = outcome;
		this.traceback = traceback;
	}
}

export interface BridgeOptions {
	host: string;
	port: number;
	timeoutMs: number;
	connectTimeoutMs?: number;
	/** Token for a plugin started in network mode (Plugin "grandmcp" "lan"); sent before any request. */
	token?: string;
}

interface Pending {
	resolve: (value: unknown) => void;
	reject: (error: BridgeError) => void;
	timer: NodeJS.Timeout;
}

interface Response {
	id?: unknown;
	ok: boolean;
	result?: unknown;
	code?: string;
	error?: string;
	traceback?: string;
}

/** NDJSON client for the grandmcp Lua plugin. Connects lazily and reconnects on the next request. */
export class BridgeClient {
	private socket: net.Socket | undefined;
	private connecting: Promise<net.Socket> | undefined;
	private buffer = '';
	private nextId = 1;
	private readonly pending = new Map<string, Pending>();

	private readonly options: BridgeOptions;

	constructor(options: BridgeOptions) {
		this.options = options;
	}

	async request<T = unknown>(op: string, args: Record<string, unknown> = {}, timeoutMs = this.options.timeoutMs): Promise<T> {
		const socket = await this.connect();
		const id = String(this.nextId++);

		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new BridgeError(`no answer to '${op}' within ${timeoutMs} ms`, 'timeout', 'unknown'));
			}, timeoutMs);
			this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
			socket.write(JSON.stringify({ id, op, args }) + '\n');
		});
	}

	close(): void {
		this.failAll(new BridgeError('bridge client closed', 'connection-lost', 'unknown'));
		this.socket?.destroy();
		this.socket = undefined;
	}

	private connect(): Promise<net.Socket> {
		if (this.socket && !this.socket.destroyed) return Promise.resolve(this.socket);

		this.connecting ??= new Promise<net.Socket>((resolve, reject) => {
			const { host, port, connectTimeoutMs = 3000 } = this.options;
			const socket = net.createConnection({ host, port });
			socket.setEncoding('utf8');
			socket.setNoDelay(true);
			const timer = setTimeout(() => socket.destroy(new Error(`connect timeout after ${connectTimeoutMs} ms`)), connectTimeoutMs);

			socket.once('connect', () => {
				clearTimeout(timer);
				this.socket = socket;
				this.buffer = '';

				if (!this.options.token) {
					resolve(socket);

					return;
				}

				// Network mode: the plugin answers nothing but hello until the token matches, and drops us if it does not.
				const id = `hello-${this.nextId++}`;
				const refuse = (message: string) => {
					this.socket = undefined;
					socket.destroy();
					reject(new BridgeError(message, 'unauthorized', 'not-sent'));
				};
				this.pending.set(id, {
					resolve: () => resolve(socket),
					reject: (error) =>
						refuse(
							`the grandmcp plugin at ${host}:${port} refused the token (${error.message}). Check GRANDMCP_TOKEN against gma3_library/grandmcp-token.txt on the console.`,
						),
					timer: setTimeout(() => {
						this.pending.delete(id);
						refuse(`no answer to the token from ${host}:${port}`);
					}, connectTimeoutMs),
				});
				socket.write(JSON.stringify({ id, op: 'hello', args: { token: this.options.token } }) + '\n');
			});
			socket.on('data', (chunk: string) => this.onData(chunk));
			socket.on('error', () => {}); // the close handler below does the work
			socket.once('close', () => {
				clearTimeout(timer);

				if (this.socket === socket) {
					this.socket = undefined;
					this.failAll(new BridgeError('connection to the grandmcp plugin was lost', 'connection-lost', 'unknown'));
				} else {
					reject(
						new BridgeError(
							`cannot reach the grandmcp plugin at ${host}:${port}. Is onPC running and the plugin started (Plugin "grandmcp")?`,
							'unreachable',
							'not-sent',
						),
					);
				}
			});
		}).finally(() => {
			this.connecting = undefined;
		});

		return this.connecting;
	}

	private onData(chunk: string): void {
		this.buffer += chunk;
		let newline: number;
		while ((newline = this.buffer.indexOf('\n')) >= 0) {
			const line = this.buffer.slice(0, newline).trim();
			this.buffer = this.buffer.slice(newline + 1);

			if (line) this.onLine(line);
		}
	}

	private onLine(line: string): void {
		let response: Response;
		try {
			response = JSON.parse(line) as Response;
		} catch {
			return;
		}
		const id = typeof response.id === 'string' ? response.id : undefined;
		const entry = id === undefined ? undefined : this.pending.get(id);

		if (!entry || id === undefined) return;

		this.pending.delete(id);
		clearTimeout(entry.timer);

		if (response.ok) {
			entry.resolve(response.result);
		} else {
			entry.reject(new BridgeError(response.error ?? 'plugin error', response.code ?? 'plugin-error', 'failed', response.traceback));
		}
	}

	private failAll(error: BridgeError): void {
		for (const [id, entry] of this.pending) {
			clearTimeout(entry.timer);
			entry.reject(error);
			this.pending.delete(id);
		}
	}
}
