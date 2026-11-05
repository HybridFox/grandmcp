import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import type { LivePatch } from '../bridge/types.ts';
import type { AppContext } from '../context.ts';

import { failure, fromError, ok, WRITES_DISABLED } from './result.ts';

interface GroupInfo {
	no: number;
	name: string;
	fids: number[];
	/** Entries with another ID type (channel IDs and the like), not shown as FIDs. */
	otherIds: number;
	backup?: string;
}

interface MatricksInfo {
	no: number;
	name: string;
	block?: number;
	group?: number;
	wings?: number;
	width?: number;
	shift?: number;
	invert?: boolean;
	phaseFrom?: number;
	phaseTo?: number;
	fadeFrom?: number;
	fadeTo?: number;
	delayFrom?: number;
	delayTo?: number;
}

export function describeMatricks(m: MatricksInfo): string {
	const parts = (['block', 'group', 'wings', 'width', 'shift'] as const).filter((k) => m[k] !== undefined).map((k) => `${k} ${m[k]}`);

	if (m.invert) {
		parts.push('inverted');
	}

	for (const [label, from, to] of [
		['phase', m.phaseFrom, m.phaseTo],
		['fade', m.fadeFrom, m.fadeTo],
		['delay', m.delayFrom, m.delayTo],
	] as const) {
		if (from !== undefined || to !== undefined) {
			parts.push(`${label} ${from ?? 0}..${to ?? 0}`);
		}
	}

	return `MAtricks ${m.no} "${m.name}": ${parts.join(', ') || 'no pattern'}`;
}

/** "301-305, 1101" */
export function fidRanges(fids: number[]): string {
	const parts: string[] = [];
	let start: number | undefined;
	let prev: number | undefined;
	for (const fid of fids) {
		if (start !== undefined && prev !== undefined && fid === prev + 1) {
			prev = fid;
			continue;
		}

		if (start !== undefined) {
			parts.push(start === prev ? String(start) : `${start}-${prev}`);
		}

		start = prev = fid;
	}

	if (start !== undefined) {
		parts.push(start === prev ? String(start) : `${start}-${prev}`);
	}

	return parts.join(', ');
}

const groupNoSchema = z.number().int().min(1).max(9999).describe('Group pool number.');

export function registerGroupTools(server: McpServer, ctx: AppContext): void {
	server.registerTool(
		'grandmcp_group_list',
		{
			title: 'List groups',
			description: 'List the groups in the current data pool with their fixture IDs, in selection order.',
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true, idempotentHint: true },
		},
		async () => {
			try {
				const groups = await ctx.bridge.request<GroupInfo[]>('group.list', {}, 60_000);
				const text =
					groups.length === 0
						? 'There are no groups yet.'
						: groups
								.map(
									(g) =>
										`Group ${g.no} "${g.name}": ${g.fids.length} fixtures (${fidRanges(g.fids)})${g.otherIds ? ` + ${g.otherIds} other IDs` : ''}`,
								)
								.join('\n');

				return { content: [{ type: 'text', text }], structuredContent: { groups } };
			} catch (error) {
				return fromError(error);
			}
		},
	);

	server.registerTool(
		'grandmcp_group_store',
		{
			title: 'Store group',
			description: [
				'Create a group, or replace one with overwrite, containing exactly these fixtures in this order (the order is the selection order MAtricks and effects use).',
				"Does not touch the programmer or the user's selection. Replacing an existing group exports it first to gma3_library/datapools/groups.",
				'MA removes some characters from names (such as quotes and &); the result shows the stored name.',
			].join(' '),
			inputSchema: z.object({
				no: groupNoSchema,
				name: z.string().min(1).max(200),
				fids: z.array(z.number().int().min(1)).min(1).max(5000).describe('Fixture IDs in selection order.'),
				overwrite: z.boolean().default(false).describe('Replace the group if this pool number is taken.'),
			}),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
		},
		async ({ no, name, fids, overwrite }) => {
			if (!ctx.allowWrite) {
				return WRITES_DISABLED;
			}

			try {
				const live = await ctx.bridge.request<LivePatch>('patch.list');
				const known = new Set(live.fixtures.filter((f) => f.idType === 'Fixture' && f.fid !== undefined).map((f) => Number(f.fid)));
				const unknown = fids.filter((fid) => !known.has(fid));
				const duplicates = fids.filter((fid, i) => fids.indexOf(fid) !== i);

				if (unknown.length > 0 || duplicates.length > 0) {
					return failure(
						[
							unknown.length > 0 ? `No fixture with FID ${fidRanges(unknown)} in the show.` : '',
							duplicates.length > 0 ? `Listed more than once: ${fidRanges([...new Set(duplicates)])}.` : '',
						]
							.filter(Boolean)
							.join(' '),
					);
				}

				const group = await ctx.serialize(() => ctx.bridge.request<GroupInfo>('group.store', { no, name, fids, overwrite }));
				const lines = [`Stored group ${group.no} "${group.name}" with ${group.fids.length} fixtures (${fidRanges(group.fids)}).`];

				if (group.name !== name) {
					lines.push(`MA stored the name as "${group.name}".`);
				}

				if (group.backup) {
					lines.push(`The previous group was exported to ${group.backup}.`);
				}

				return ok(group, lines.join('\n'));
			} catch (error) {
				return fromError(error);
			}
		},
	);

	server.registerTool(
		'grandmcp_group_delete',
		{
			title: 'Delete group',
			description: 'Delete a group from the pool. It is exported to gma3_library/datapools/groups first.',
			inputSchema: z.object({ no: groupNoSchema }),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
		},
		async ({ no }) => {
			if (!ctx.allowWrite) {
				return WRITES_DISABLED;
			}

			try {
				const result = await ctx.serialize(() => ctx.bridge.request<{ no: number; backup: string }>('group.delete', { no }));

				return ok(result, `Deleted group ${result.no}. Exported to ${result.backup} first.`);
			} catch (error) {
				return fromError(error);
			}
		},
	);

	server.registerTool(
		'grandmcp_matricks_list',
		{
			title: 'List MAtricks',
			description: 'List the MAtricks pool: stored selection patterns (block, group, wings, width, shift, invert, phase/fade/delay spreads).',
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true, idempotentHint: true },
		},
		async () => {
			try {
				const list = await ctx.bridge.request<MatricksInfo[]>('matricks.list');
				const text = list.length === 0 ? 'No MAtricks.' : list.map(describeMatricks).join('\n');

				return { content: [{ type: 'text', text }], structuredContent: { matricks: list } };
			} catch (error) {
				return fromError(error);
			}
		},
	);

	server.registerTool(
		'grandmcp_matricks_store',
		{
			title: 'Store MAtricks',
			description: [
				'Create or replace a MAtricks pool object: a selection pattern the user calls live on top of a group, so one effect gives many variants.',
				'block = neighbours share a step, group = every n-th fixture (2 = odd/even), wings = mirror (2 = symmetric), width = how many fixtures are active at once, shift = move the pattern, invert = reverse; phaseFrom/phaseTo spread effect phase, fadeFrom/fadeTo and delayFrom/delayTo spread timing.',
			].join(' '),
			inputSchema: z.object({
				no: z.number().int().min(1).max(9999),
				name: z.string().min(1).max(100),
				overwrite: z.boolean().default(false),
				block: z.number().int().min(1).optional(),
				group: z.number().int().min(1).optional(),
				wings: z.number().int().min(1).optional(),
				width: z.number().int().min(1).optional(),
				shift: z.number().int().optional(),
				invert: z.boolean().optional(),
				phaseFrom: z.number().optional(),
				phaseTo: z.number().optional(),
				fadeFrom: z.number().min(0).optional(),
				fadeTo: z.number().min(0).optional(),
				delayFrom: z.number().min(0).optional(),
				delayTo: z.number().min(0).optional(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
		},
		async (input) => {
			if (!ctx.allowWrite) {
				return WRITES_DISABLED;
			}

			try {
				const result = await ctx.serialize(() => ctx.bridge.request<MatricksInfo>('matricks.store', input));

				return ok(result, `Stored ${describeMatricks(result)}`);
			} catch (error) {
				return fromError(error);
			}
		},
	);

	server.registerTool(
		'grandmcp_layout_list',
		{
			title: 'List layouts',
			description: 'List layout views (2D fixture maps) with their number of elements.',
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true, idempotentHint: true },
		},
		async () => {
			try {
				const list = await ctx.bridge.request<{ no: number; name: string; elements: number }[]>('layout.list');

				return {
					content: [{ type: 'text', text: list.map((l) => `Layout ${l.no} "${l.name}": ${l.elements} elements`).join('\n') || 'No layouts.' }],
					structuredContent: { layouts: list },
				};
			} catch (error) {
				return fromError(error);
			}
		},
	);

	server.registerTool(
		'grandmcp_layout_store',
		{
			title: 'Store layout',
			description: [
				'Create or replace a layout view: a 2D map of fixtures that selects them when tapped (handy for busking and for selection order).',
				'Give x/y per fixture (layout units, the default element is 50 x 50), or leave them out to place the fixture from its 3D position seen from above (scale layout units per metre, default 100).',
				'Replacing a layout exports the old one first.',
			].join(' '),
			inputSchema: z.object({
				no: z.number().int().min(1).max(999),
				name: z.string().min(1).max(100),
				overwrite: z.boolean().default(false),
				scale: z.number().positive().optional(),
				elements: z
					.array(
						z.object({
							fid: z.number().int().min(1),
							x: z.number().optional(),
							y: z.number().optional(),
							width: z.number().int().min(1).optional(),
							height: z.number().int().min(1).optional(),
						}),
					)
					.min(1)
					.max(2000),
			}),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
		},
		async (input) => {
			if (!ctx.allowWrite) {
				return WRITES_DISABLED;
			}

			try {
				const result = await ctx.serialize(() =>
					ctx.bridge.request<{ no: number; name: string; placed: number; problems: string[]; backup?: string; elements: unknown[] }>(
						'layout.store',
						input,
						60_000,
					),
				);
				const lines = [`Layout ${result.no} "${result.name}" with ${result.placed} placed fixtures.`];

				if (result.problems.length > 0) {
					lines.push(`Problems: ${result.problems.join('; ')}.`);
				}

				if (result.backup) {
					lines.push(`The previous layout was exported to ${result.backup}.`);
				}

				return ok(result, lines.join('\n'));
			} catch (error) {
				return fromError(error);
			}
		},
	);
}
