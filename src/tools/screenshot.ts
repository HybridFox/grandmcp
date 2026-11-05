import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import type { AppContext } from '../context.ts';

import { fromError } from './result.ts';

/** grandMA3 exports images as base64 blocks that are each encoded on their own; join the bytes, not the strings. */
export function joinBlocks(blocks: string[]): Buffer {
	return Buffer.concat(blocks.map((b) => Buffer.from(b, 'base64')));
}

export function registerScreenshotTools(server: McpServer, ctx: AppContext): void {
	server.registerTool(
		'grandmcp_screenshot',
		{
			title: 'Screenshot',
			description:
				"Take a screenshot of one of grandMA3's screens, rendered by grandMA3 itself (works for onPC and consoles, also over the network). To check a look, ask the user to show a 3D window on that screen first.",
			inputSchema: z.object({
				screen: z.number().int().min(1).max(16).default(1).describe('grandMA3 screen (display) number.'),
				full: z.boolean().default(false).describe('Include the view bar and encoder bar instead of only the user area.'),
			}),
			annotations: { readOnlyHint: true, idempotentHint: false },
		},
		async ({ screen, full }) => {
			try {
				const result = await ctx.serialize(() => ctx.bridge.request<{ screen: number; blocks: string[] }>('screen.capture', { screen, full }, 30_000));
				const png = joinBlocks(result.blocks);

				return {
					content: [
						{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
						{ type: 'text', text: `Screen ${result.screen} of grandMA3.` },
					],
				};
			} catch (error) {
				return fromError(error);
			}
		},
	);
}
