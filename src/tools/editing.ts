import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import type { AppContext } from '../context.ts';

import { fromError, ok, WRITES_DISABLED } from './result.ts';
import { cueSchema } from './sequences.ts';

const kindSchema = z.enum(['preset', 'sequence', 'group', 'matricks', 'layout', 'appearance']);

type ReadValue = { slot?: string; percent?: number; physical?: number; function?: string; effect?: { steps: ReadValue[]; bpm: number; phase: number } };

interface PresetRead {
	pool: number;
	no: number;
	name: string;
	fixtures: { fid: number; type?: string; values: Record<string, ReadValue> }[];
}

interface SequenceRead {
	no: number;
	name: string;
	executors: string[];
	cues: { no: number; name: string; fade?: string; trigger?: string; triggerTime?: string; presets: string[]; ownValueFixtures: number[] }[];
}

function describeValue(v: ReadValue): string {
	if (v.effect) {
		return `effect ${v.effect.bpm} BPM, phase ${v.effect.phase}°: ${v.effect.steps.map(describeValue).join(' > ')}`;
	}

	if (v.slot) {
		return v.slot;
	}

	return v.percent !== undefined ? `${v.percent}%` : '?';
}

export function describePresetRead(p: PresetRead): string {
	const lines = [`Preset ${p.pool}.${p.no} "${p.name}" (${p.fixtures.length} fixtures)`];
	const seen = new Map<string, number[]>();
	for (const f of p.fixtures) {
		const key = `${f.type ?? '?'}: ${Object.entries(f.values)
			.map(([attr, v]) => `${attr} ${describeValue(v)}`)
			.join(', ')}`;
		seen.set(key, [...(seen.get(key) ?? []), f.fid]);
	}

	for (const [key, fids] of seen) {
		lines.push(`- FID ${fids.join(', ')} ${key}`);
	}

	return lines.join('\n');
}

export function describeSequenceRead(s: SequenceRead): string {
	const lines = [`Sequence ${s.no} "${s.name}"${s.executors.length ? ` on executor ${s.executors.join(', ')}` : ''}`];
	for (const c of s.cues) {
		const parts = [...c.presets.map((p) => `preset ${p}`), ...(c.ownValueFixtures.length ? [`own values on FID ${c.ownValueFixtures.join(', ')}`] : [])];
		lines.push(
			`  ${c.no} "${c.name}" fade ${c.fade ?? '0'}${c.trigger && c.trigger !== 'Go' ? ` ${c.trigger.toLowerCase()} ${c.triggerTime ?? ''}` : ''}: ${parts.join('; ') || 'empty'}`,
		);
	}

	return lines.join('\n');
}
const poolField = z.number().int().min(1).max(30).optional().describe('Preset pool, required for kind "preset".');

function needsPool(kind: string, pool: number | undefined): string | undefined {
	return kind === 'preset' && pool === undefined ? 'kind "preset" needs a pool' : undefined;
}

export function registerEditingTools(server: McpServer, ctx: AppContext): void {
	server.registerTool(
		'grandmcp_preset_read',
		{
			title: 'Read preset',
			description:
				'Read what a preset contains, per fixture and attribute, in the same terms grandmcp_preset_store uses: the slot a value falls in, or percent and physical value, and effects with steps, BPM and phase.',
			inputSchema: z.object({ pool: z.number().int().min(1).max(30), no: z.number().int().min(1) }),
			annotations: { readOnlyHint: true, idempotentHint: true },
		},
		async (input) => {
			try {
				const result = await ctx.bridge.request<PresetRead>('preset.read', input, 60_000);

				return ok(result, describePresetRead(result));
			} catch (error) {
				return fromError(error);
			}
		},
	);

	server.registerTool(
		'grandmcp_sequence_read',
		{
			title: 'Read sequence',
			description:
				'Read a sequence: its cues with timing and triggers, which presets each cue references, which fixtures carry their own values, and which executors hold it.',
			inputSchema: z.object({ no: z.number().int().min(1) }),
			annotations: { readOnlyHint: true, idempotentHint: true },
		},
		async (input) => {
			try {
				const result = await ctx.bridge.request<SequenceRead>('sequence.read', input, 60_000);

				return ok(result, describeSequenceRead(result));
			} catch (error) {
				return fromError(error);
			}
		},
	);

	server.registerTool(
		'grandmcp_cue_store',
		{
			title: 'Store one cue',
			description:
				'Add or replace a single cue in an existing sequence (same cue format as grandmcp_sequence_store) without rewriting the rest. The sequence keeps its executors. Replacing exports the sequence first.',
			inputSchema: z.object({
				sequence: z.number().int().min(1),
				cue: cueSchema.extend({ no: z.number().positive() }),
				overwrite: z.boolean().default(false),
			}),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
		},
		async (input) => {
			if (!ctx.allowWrite) {
				return WRITES_DISABLED;
			}

			try {
				const result = await ctx.serialize(() =>
					ctx.bridge.request<{ sequence: number; cue: { no: number; name: string; fade?: string }; replaced: boolean; backup?: string }>(
						'cue.store',
						input,
						120_000,
					),
				);

				return ok(
					result,
					`${result.replaced ? 'Replaced' : 'Added'} cue ${result.cue.no} "${result.cue.name}" in sequence ${result.sequence}.${result.backup ? ` Previous sequence exported to ${result.backup}.` : ''}`,
				);
			} catch (error) {
				return fromError(error);
			}
		},
	);

	server.registerTool(
		'grandmcp_cue_delete',
		{
			title: 'Delete one cue',
			description: 'Delete a single cue from a sequence. The sequence is exported first.',
			inputSchema: z.object({ sequence: z.number().int().min(1), cue: z.number().positive() }),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
		},
		async (input) => {
			if (!ctx.allowWrite) {
				return WRITES_DISABLED;
			}

			try {
				const result = await ctx.serialize(() => ctx.bridge.request<{ sequence: number; cue: number; backup?: string }>('cue.delete', input));

				return ok(result, `Deleted cue ${result.cue} from sequence ${result.sequence}. Exported to ${result.backup} first.`);
			} catch (error) {
				return fromError(error);
			}
		},
	);

	server.registerTool(
		'grandmcp_pool_delete',
		{
			title: 'Delete pool object',
			description: 'Delete a preset, sequence, group, MAtricks, layout or appearance. It is exported to gma3_library/datapools first.',
			inputSchema: z.object({ kind: kindSchema, pool: poolField, no: z.number().int().min(1) }),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
		},
		async (input) => {
			if (!ctx.allowWrite) {
				return WRITES_DISABLED;
			}

			const problem = needsPool(input.kind, input.pool);

			if (problem) {
				return fromError(new Error(problem));
			}

			try {
				const result = await ctx.serialize(() => ctx.bridge.request<{ deleted: string; name: string; backup?: string }>('pool.delete', input));

				return ok(result, `Deleted ${result.deleted} "${result.name}". Exported to ${result.backup} first.`);
			} catch (error) {
				return fromError(error);
			}
		},
	);

	server.registerTool(
		'grandmcp_pool_copy',
		{
			title: 'Copy pool object',
			description:
				'Copy a preset (within its pool), sequence, group, MAtricks, layout or appearance to another slot, e.g. to make a variant. Replacing an existing target needs overwrite and exports it first.',
			inputSchema: z.object({
				kind: kindSchema,
				pool: poolField,
				from: z.number().int().min(1),
				to: z.number().int().min(1),
				overwrite: z.boolean().default(false),
			}),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
		},
		async (input) => {
			if (!ctx.allowWrite) {
				return WRITES_DISABLED;
			}

			const problem = needsPool(input.kind, input.pool);

			if (problem) {
				return fromError(new Error(problem));
			}

			try {
				const result = await ctx.serialize(() => ctx.bridge.request<{ copied: string; to: string; name: string }>('pool.copy', input));

				return ok(result, `Copied ${result.copied} to ${result.to} ("${result.name}").`);
			} catch (error) {
				return fromError(error);
			}
		},
	);

	server.registerTool(
		'grandmcp_pool_rename',
		{
			title: 'Rename pool object',
			description: 'Rename a preset, sequence, group, MAtricks, layout or appearance.',
			inputSchema: z.object({ kind: kindSchema, pool: poolField, no: z.number().int().min(1), name: z.string().min(1).max(100) }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
		},
		async (input) => {
			if (!ctx.allowWrite) {
				return WRITES_DISABLED;
			}

			const problem = needsPool(input.kind, input.pool);

			if (problem) {
				return fromError(new Error(problem));
			}

			try {
				const result = await ctx.serialize(() => ctx.bridge.request<{ renamed: string; name: string }>('pool.rename', input));

				return ok(result, `${result.renamed} is now "${result.name}".`);
			} catch (error) {
				return fromError(error);
			}
		},
	);

	server.registerTool(
		'grandmcp_appearance_list',
		{
			title: 'List appearances',
			description: 'List appearances (button colours) with their colour.',
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true, idempotentHint: true },
		},
		async () => {
			try {
				const list = await ctx.bridge.request<{ no: number; name: string; color: string }[]>('appearance.list');

				return {
					content: [{ type: 'text', text: list.map((a) => `${a.no} "${a.name}" ${a.color}`).join('\n') || 'No appearances.' }],
					structuredContent: { appearances: list },
				};
			} catch (error) {
				return fromError(error);
			}
		},
	);

	server.registerTool(
		'grandmcp_appearance_store',
		{
			title: 'Store appearance',
			description:
				'Create or replace an appearance (a button colour) and optionally put it on presets, sequences, groups or MAtricks, e.g. a red appearance on the red colour palette and the sequences that use it, so the layout reads at a glance.',
			inputSchema: z.object({
				no: z.number().int().min(1).max(999),
				name: z.string().min(1).max(100),
				color: z.string().regex(/^#?[0-9a-fA-F]{6}$/, 'use "#RRGGBB"'),
				overwrite: z.boolean().default(false),
				assign: z.array(z.object({ kind: kindSchema, pool: poolField, no: z.number().int().min(1) })).optional(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
		},
		async (input) => {
			if (!ctx.allowWrite) {
				return WRITES_DISABLED;
			}

			try {
				const result = await ctx.serialize(() =>
					ctx.bridge.request<{ no: number; name: string; color: string; assigned: string[]; problems: string[] }>('appearance.store', input),
				);
				const lines = [`Appearance ${result.no} "${result.name}" ${result.color}.`];

				if (result.assigned.length > 0) {
					lines.push(`On: ${result.assigned.join(', ')}.`);
				}

				if (result.problems.length > 0) {
					lines.push(`Not assigned: ${result.problems.join('; ')}.`);
				}

				return ok(result, lines.join('\n'));
			} catch (error) {
				return fromError(error);
			}
		},
	);
}
