import { BridgeClient } from './bridge/client.ts';
import { config } from './config.ts';

/** Long-lived state shared by every McpServer instance the stdio factory creates. */
export interface AppContext {
	bridge: BridgeClient;
	allowWrite: boolean;
}

export function createContext(): AppContext {
	return {
		bridge: new BridgeClient({ host: config.host, port: config.port, timeoutMs: config.timeoutMs }),
		allowWrite: config.allowWrite,
	};
}
