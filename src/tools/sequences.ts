import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import type { AppContext } from '../context.ts';

import { presetValueSchema } from './presets.ts';
import { fromError, ok, WRITES_DISABLED } from './result.ts';

interface CueInfo {
	no: number;
	name: string;
	trigger?: string;
	triggerTime?: string;
	fade?: string;
	outFade?: string;
}

interface SequenceInfo {
	no: number;
	name: string;
	cues: CueInfo[];
}

interface StoreResult extends SequenceInfo {
	values: number;
	expectedValues: number;
	verified: boolean;
	backup?: string;
}

const lookSchema = z.union([
	z.object({
		preset: z.object({ pool: z.number().int().min(1), no: z.number().int().min(1) }),
		fids: z.array(z.number().int().min(1)).optional().describe('Only these fixtures of the preset; default all.'),
	}),
	z.object({
		fids: z.array(z.number().int().min(1)).min(1),
		values: z.record(z.string().min(1), presetValueSchema),
	}),
]);

export const cueSchema = z.object({
	no: z.number().positive().optional().describe('Cue number; defaults to the position in the list (1, 2, 3, ...).'),
	name: z.string().min(1).max(200).optional(),
	fade: z.number().min(0).optional().describe('Fade-in time in seconds.'),
	outFade: z.number().min(0).optional().describe('Fade-out time in seconds (defaults to the fade-in time).'),
	delay: z.number().min(0).optional(),
	outDelay: z.number().min(0).optional(),
	trigger: z.enum(['go', 'follow', 'time']).optional().describe('go = wait for Go, follow = run after the previous cue, time = run after triggerTime.'),
	triggerTime: z.number().min(0).optional(),
	looks: z
		.array(lookSchema)
		.min(1)
		.describe('What the cue contains: preset references (the cue follows the preset when it changes) and/or explicit values for fixtures.'),
});

function describeCue(c: CueInfo): string {
	const trigger = c.trigger && c.trigger !== 'Go' ? ` ${c.trigger.toLowerCase()} ${c.triggerTime ?? ''}`.trimEnd() : '';

	return `  ${c.no} "${c.name}" fade ${c.fade ?? '0'}${c.outFade && c.outFade !== c.fade ? `/${c.outFade}` : ''}${trigger}`;
}

export function registerSequenceTools(server: McpServer, ctx: AppContext): void {
	server.registerTool(
		'grandmcp_sequence_list',
		{
			title: 'List sequences',
			description: 'List sequences with their cues, fade times and triggers.',
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true, idempotentHint: true },
		},
		async () => {
			try {
				const sequences = await ctx.bridge.request<SequenceInfo[]>('sequence.list', {}, 60_000);
				const text = sequences.map((s) => [`Sequence ${s.no} "${s.name}" (${s.cues.length} cues)`, ...s.cues.map(describeCue)].join('\n')).join('\n');

				return { content: [{ type: 'text', text: text || 'No sequences.' }], structuredContent: { sequences } };
			} catch (error) {
				return fromError(error);
			}
		},
	);

	server.registerTool(
		'grandmcp_sequence_store',
		{
			title: 'Store sequence',
			description: [
				'Create or replace a sequence (cue list) without touching the programmer. Each cue has a name, timing, a trigger and looks.',
				'A look is a preset reference ({ preset: { pool, no } }, optionally limited to some fixtures) or explicit values per fixture (same value format as grandmcp_preset_store).',
				'Prefer preset references for busking shows: change the preset and every cue using it follows. Replacing a sequence exports the old one to gma3_library/datapools/sequences first.',
			].join(' '),
			inputSchema: z.object({
				no: z.number().int().min(1).max(9999),
				name: z.string().min(1).max(200),
				overwrite: z.boolean().default(false),
				cues: z.array(cueSchema).min(1).max(999),
			}),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
		},
		async (input) => {
			if (!ctx.allowWrite) {
				return WRITES_DISABLED;
			}

			try {
				const result = await ctx.serialize(() => ctx.bridge.request<StoreResult>('sequence.store', input, 120_000));
				const lines = [
					result.verified
						? `Stored sequence ${result.no} "${result.name}" with ${result.cues.length} cues, verified.`
						: `Stored sequence ${result.no} "${result.name}", but it did not read back as expected (${result.cues.length} of ${input.cues.length} cues, ${result.values} of ${result.expectedValues} values).`,
					...result.cues.map(describeCue),
				];

				if (result.backup) {
					lines.push(`The previous sequence was exported to ${result.backup}.`);
				}

				return ok(result, lines.join('\n'));
			} catch (error) {
				return fromError(error);
			}
		},
	);

	server.registerTool(
		'grandmcp_executor_list',
		{
			title: 'List executors',
			description: 'List the executors (faders and buttons) on a page that have something assigned.',
			inputSchema: z.object({ page: z.number().int().min(1).default(1) }),
			annotations: { readOnlyHint: true, idempotentHint: true },
		},
		async ({ page }) => {
			try {
				const result = await ctx.bridge.request<{ page: number; executors: { executor: number; class: string; name: string; no?: number }[] }>(
					'executor.list',
					{ page },
				);
				const text =
					result.executors.length === 0
						? `Page ${page} has no assigned executors.`
						: result.executors.map((e) => `${page}.${e.executor}: ${e.class} ${e.no ?? ''} "${e.name}"`).join('\n');

				return { content: [{ type: 'text', text }], structuredContent: result };
			} catch (error) {
				return fromError(error);
			}
		},
	);

	server.registerTool(
		'grandmcp_executor_assign',
		{
			title: 'Assign sequence to executor',
			description:
				'Put a sequence on an executor (a fader or button) of a page, e.g. page 1 executor 201. Refuses to replace something already on the executor unless overwrite is set.',
			inputSchema: z.object({
				sequence: z.number().int().min(1),
				page: z.number().int().min(1).default(1),
				executor: z.number().int().min(1),
				overwrite: z.boolean().default(false),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
		},
		async (input) => {
			if (!ctx.allowWrite) {
				return WRITES_DISABLED;
			}

			try {
				const result = await ctx.serialize(() =>
					ctx.bridge.request<{ sequence: number; page: number; executor: number; name: string }>('executor.assign', input),
				);

				return ok(result, `Sequence ${result.sequence} "${result.name}" is on executor ${result.page}.${result.executor}.`);
			} catch (error) {
				return fromError(error);
			}
		},
	);
}
