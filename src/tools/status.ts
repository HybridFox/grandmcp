import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import type { AppContext } from '../context.ts';

import { fromError, ok } from './result.ts';

export function registerStatusTools(server: McpServer, ctx: AppContext): void {
	server.registerTool(
		'grandmcp_status',
		{
			title: 'Console status',
			description:
				'Check the connection to grandMA3 and report software version, host type, show file status and whether a pop-up is blocking the console. Call this first.',
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true, idempotentHint: true },
		},
		async () => {
			try {
				const info = await ctx.bridge.request('info');

				return ok({ ...(info as object), writesEnabled: ctx.allowWrite });
			} catch (error) {
				return fromError(error);
			}
		},
	);
}
