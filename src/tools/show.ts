import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import type { Dialog } from '../bridge/types.ts';
import type { AppContext } from '../context.ts';

import { describeDialog } from './move.ts';
import { fromError, ok, WRITES_DISABLED } from './result.ts';

interface SaveResult {
	pending: boolean;
	dialog?: Dialog;
	saved?: boolean;
	name?: string;
	file?: string;
	size?: number;
}

function report(result: SaveResult): CallToolResult {
	if (result.pending) {
		return ok(
			result,
			[
				`grandMA3 is asking on the console before saving: ${describeDialog(result.dialog)}`,
				"This is the user's decision: tell them the question and ask them to answer it on the console. Do not answer it yourself.",
				'Once they have answered, call grandmcp_show_save_finish.',
			].join('\n'),
		);
	}

	return ok(
		result,
		result.saved
			? `Saved the show${result.name ? ` "${result.name}"` : ''} to ${result.file}.`
			: 'The show was not saved (cancelled on the console, or the save did not finish).',
	);
}

export function registerShowTools(server: McpServer, ctx: AppContext): void {
	server.registerTool(
		'grandmcp_show_status',
		{
			title: 'Show file status',
			description: 'The current show file name (empty if it was never saved), its status, the show folder, and any pop-up waiting on the console.',
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true, idempotentHint: true },
		},
		async () => {
			try {
				const s = await ctx.bridge.request<{ name?: string; status: string; folder: string; dialog?: Dialog; pendingSave?: string }>('show.status');
				const lines = [`Show: ${s.name ? `"${s.name}"` : 'never saved'} (${s.status}), folder ${s.folder}.`];

				if (s.dialog) {
					lines.push(`Waiting on the console: ${describeDialog(s.dialog)}`);
				}

				return ok(s, lines.join('\n'));
			} catch (error) {
				return fromError(error);
			}
		},
	);

	server.registerTool(
		'grandmcp_show_save',
		{
			title: 'Save show',
			description: [
				'Save the show file, under its current name or a new one. Everything the other tools change lives only in the running show until it is saved: offer to save after a block of work.',
				'grandMA3 may ask on the console first (for example when the name changes); that question is for the user, after which grandmcp_show_save_finish confirms the save.',
				'Saving under an existing name overwrites that file.',
			].join(' '),
			inputSchema: z.object({ name: z.string().min(1).max(100).optional().describe('New show name; omit to save under the current name.') }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
		},
		async ({ name }) => {
			if (!ctx.allowWrite) {
				return WRITES_DISABLED;
			}

			try {
				return report(await ctx.serialize(() => ctx.bridge.request<SaveResult>('show.save', name ? { name } : {}, 60_000)));
			} catch (error) {
				return fromError(error);
			}
		},
	);

	server.registerTool(
		'grandmcp_show_save_finish',
		{
			title: 'Finish saving',
			description: "Confirm a save after the user answered grandMA3's question on the console. Reports the question again if it is still open.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
		},
		async () => {
			if (!ctx.allowWrite) {
				return WRITES_DISABLED;
			}

			try {
				return report(await ctx.serialize(() => ctx.bridge.request<SaveResult>('show.saveFinish', {}, 60_000)));
			} catch (error) {
				return fromError(error);
			}
		},
	);
}
