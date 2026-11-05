import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import type { Dialog, MoveResult } from '../bridge/types.ts';
import type { AppContext } from '../context.ts';

import { fromError, ok, WRITES_DISABLED } from './result.ts';

export function describeDialog(dialog: Dialog | undefined): string {
	if (!dialog) {
		return 'a pop-up';
	}

	return `"${dialog.title ?? 'pop-up'}": ${dialog.message ?? ''} (buttons: ${dialog.buttons.join(' / ')})`;
}

function report(result: MoveResult): CallToolResult {
	if (result.pending) {
		return ok(
			result,
			[
				`grandMA3 is asking on the console: ${describeDialog(result.dialog)}`,
				"This is the user's decision: tell them the question and ask them to answer it on the console. Do not answer it yourself.",
				'Once they have answered, call grandmcp_patch_move_finish.',
			].join('\n'),
		);
	}

	if (result.cancelled) {
		return ok(result, `Nothing was moved (cancelled).${result.note ? ` ${result.note}.` : ''}`);
	}

	const failed = (result.results ?? []).filter((r) => !r.ok);
	const summary = result.moved
		? `Moved ${result.results?.length ?? 0} fixture(s) and verified them in the live patch.`
		: `The move did not complete as planned for FID ${failed.map((r) => r.fid).join(', ')}. Check with grandmcp_patch_list.`;

	return ok(result, `${summary}${result.note ? ` (${result.note})` : ''}\nBackup of the previous patch: ${result.backup}`);
}

export function registerMoveTools(server: McpServer, ctx: AppContext): void {
	server.registerTool(
		'grandmcp_patch_move',
		{
			title: 'Move fixtures under a grouping fixture',
			description: [
				'Move existing fixtures under a grouping fixture, or back to the top level of their stage (parent omitted). FIDs, addresses, names, group membership and cues stay as they are, but grandMA3 moves the relocated fixtures to the end of the selection order of groups that contain them.',
				'All fixtures must currently sit in the same place. grandMA3 then usually asks on the console whether to keep the absolute 3D position or the offset relative to the parent: that question is for the user to answer on the console, after which grandmcp_patch_move_finish completes the move.',
			].join(' '),
			inputSchema: z.object({
				fids: z.array(z.number().int().min(1)).min(1).max(1000),
				parent: z.number().int().min(1).optional().describe('FID of the target grouping fixture; omit to move to the top level.'),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
		},
		async ({ fids, parent }) => {
			if (!ctx.allowWrite) {
				return WRITES_DISABLED;
			}

			try {
				return report(await ctx.serialize(() => ctx.bridge.request<MoveResult>('patch.move', { fids, ...(parent ? { parent } : {}) }, 60_000)));
			} catch (error) {
				return fromError(error);
			}
		},
	);

	server.registerTool(
		'grandmcp_patch_move_finish',
		{
			title: 'Finish a move',
			description: [
				"Complete a move after the user answered grandMA3's question on the console: commits and verifies, or reports that it was cancelled.",
				'If the pop-up is still open it reports the question again. cancel = true undoes a completed paste the user no longer wants.',
			].join(' '),
			inputSchema: z.object({ cancel: z.boolean().default(false) }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
		},
		async ({ cancel }) => {
			if (!ctx.allowWrite) {
				return WRITES_DISABLED;
			}

			try {
				return report(await ctx.serialize(() => ctx.bridge.request<MoveResult>('patch.moveFinish', { cancel }, 30_000)));
			} catch (error) {
				return fromError(error);
			}
		},
	);
}
