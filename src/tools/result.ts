import type { CallToolResult } from '@modelcontextprotocol/server';

import { BridgeError } from '../bridge/client.ts';

export function ok(data: unknown, summary?: string): CallToolResult {
	const json = JSON.stringify(data, null, 2);

	return { content: [{ type: 'text', text: summary ? `${summary}\n\n${json}` : json }] };
}

/** Turns a thrown error into a tool error the model can act on, including whether the console may have changed. */
export function fromError(error: unknown): CallToolResult {
	if (error instanceof BridgeError) {
		const hint =
			error.outcome === 'unknown' ? ' The request was sent but not answered, so the console may have acted: read its state before retrying.' : '';

		return { isError: true, content: [{ type: 'text', text: `[${error.code}] ${error.message}${hint}` }] };
	}

	return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] };
}
