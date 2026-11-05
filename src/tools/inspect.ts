import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import type { AppContext } from '../context.ts';

import { fromError, ok } from './result.ts';

const pathSchema = z
	.string()
	.min(1)
	.describe(
		'Object path: dotted child names from ShowData (e.g. "LivePatch.Stages.Stage 1", "DataPools.Default.Sequences"), "Root...." for the whole tree, or a numeric address like "14.9". Numbers inside a path pick a child by index.',
	);

export function registerInspectTools(server: McpServer, ctx: AppContext): void {
	server.registerTool(
		'grandmcp_get',
		{
			title: 'Read object',
			description:
				'Read one object in the grandMA3 object tree: its properties (display values) and child count. Use it to explore show data the dedicated tools do not cover.',
			inputSchema: z.object({ path: pathSchema }),
			annotations: { readOnlyHint: true, idempotentHint: true },
		},
		async ({ path }) => {
			try {
				return ok(await ctx.bridge.request('get', { path }));
			} catch (error) {
				return fromError(error);
			}
		},
	);

	server.registerTool(
		'grandmcp_children',
		{
			title: 'List children',
			description: 'List the children of an object in the grandMA3 object tree (index, name, class, child count), paged.',
			inputSchema: z.object({
				path: pathSchema,
				offset: z.number().int().min(0).default(0),
				limit: z.number().int().min(1).max(500).default(100),
			}),
			annotations: { readOnlyHint: true, idempotentHint: true },
		},
		async ({ path, offset, limit }) => {
			try {
				return ok(await ctx.bridge.request('children', { path, offset, limit }));
			} catch (error) {
				return fromError(error);
			}
		},
	);
}
