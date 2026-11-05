import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { createHash } from 'node:crypto';
import * as z from 'zod/v4';

import type { FixtureType, LivePatch, PatchAddResult } from '../bridge/types.ts';
import type { AppContext } from '../context.ts';
import { type ChangePlan, type FixtureState, planChanges } from '../patch/changes.ts';
import { type PatchPlan, type PlannedFixture, planPatch } from '../patch/planner.ts';
import { patchChangesInputSchema, patchPlanInputSchema } from '../patch/schema.ts';

import { failure, fromError, ok, WRITES_DISABLED } from './result.ts';

async function readPatch(ctx: AppContext): Promise<{ live: LivePatch; types: FixtureType[]; fingerprint: string }> {
	const live = await ctx.bridge.request<LivePatch>('patch.list');
	const types = await ctx.bridge.request<FixtureType[]>('patch.types');
	const fingerprint = createHash('sha256').update(JSON.stringify({ live, types })).digest('hex');

	return { live, types, fingerprint };
}

function table(rows: string[][]): string {
	const widths = rows[0]?.map((_, col) => Math.max(...rows.map((r) => (r[col] ?? '').length))) ?? [];

	return rows
		.map((r) =>
			r
				.map((cell, col) => cell.padEnd(widths[col] ?? 0))
				.join('  ')
				.trimEnd(),
		)
		.join('\n');
}

function fixtureTable(fixtures: PlannedFixture[]): string {
	return table([
		['FID', 'Name', 'Type', 'Mode', 'Ch', 'Patch'],
		...fixtures.map((f) => [String(f.fid), f.name, f.type, f.mode, String(f.footprint), f.patch ?? '-']),
	]);
}

function universeSummary(fixtures: PlannedFixture[]): string {
	const used = new Map<number, number>();
	for (const f of fixtures) {
		if (f.patch) {
			const universe = Number(f.patch.split('.')[0]);
			used.set(universe, (used.get(universe) ?? 0) + f.footprint);
		}
	}

	return [...used.entries()]
		.sort(([a], [b]) => a - b)
		.map(([u, ch]) => `universe ${u}: +${ch} ch`)
		.join(', ');
}

function describePlan(plan: PatchPlan, planId: string | undefined): string {
	const lines: string[] = [];

	if (planId) {
		lines.push(`Plan ${planId}: ${plan.fixtures.length} fixtures into "${plan.stage}". Nothing has been written yet.`);
		lines.push('Show this to the user and call grandmcp_patch_apply with the planId once they agree.');
	} else {
		lines.push(`Plan rejected: ${plan.errors.length} problem(s). Nothing was stored or written.`);
	}

	if (plan.errors.length > 0) {
		lines.push('', 'Problems:', ...plan.errors.map((e) => `- ${e}`));
	}

	if (plan.missingTypes.length > 0) {
		lines.push(
			'',
			`Missing fixture types: ${plan.missingTypes.map((t) => `"${t}"`).join(', ')}.`,
			'Find them with grandmcp_fixture_library_search, import with grandmcp_fixture_type_import, then plan again using the imported type names.',
		);
	}

	if (plan.warnings.length > 0) {
		lines.push('', 'Warnings:', ...plan.warnings.map((w) => `- ${w}`));
	}

	if (plan.fixtures.length > 0) {
		lines.push('', fixtureTable(plan.fixtures));
		const summary = universeSummary(plan.fixtures);

		if (summary) {
			lines.push('', summary);
		}
	}

	return lines.join('\n');
}

export function registerPatchTools(server: McpServer, ctx: AppContext): void {
	server.registerTool(
		'grandmcp_patch_list',
		{
			title: 'List patch',
			description:
				'List every fixture in the live patch: stage, FID, name, fixture type, DMX mode, footprint and address. Fixtures inside a grouping fixture are indented and show the FID they sit in.',
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true, idempotentHint: true },
		},
		async () => {
			try {
				const live = await ctx.bridge.request<LivePatch>('patch.list');
				const rows = live.fixtures.map((f) => [
					f.stage,
					f.parent ? `  ${f.fid ?? '-'}` : (f.fid ?? '-'),
					f.name,
					f.type ?? '?',
					f.mode ?? '?',
					String(f.footprint ?? '?'),
					f.patch ?? '-',
					f.parent ? `in ${f.parent}` : f.children > 0 ? `holds ${f.children}` : '',
					f.conflicted ? 'CONFLICT' : '',
				]);
				const text =
					live.fixtures.length === 0
						? `The patch is empty. Stages: ${live.stages.join(', ')}`
						: table([['Stage', 'FID', 'Name', 'Type', 'Mode', 'Ch', 'Patch', 'Grouping', ''], ...rows]);

				return { content: [{ type: 'text', text }] };
			} catch (error) {
				return fromError(error);
			}
		},
	);

	server.registerTool(
		'grandmcp_patch_plan',
		{
			title: 'Plan patch',
			description: [
				'Check a list of fixtures against the live patch and work out IDs and DMX addresses, without changing anything.',
				'Fixture types must already be in the show (grandmcp_fixture_types). Rows with patch "auto" get the first free block of channels; "none" leaves fixtures unpatched.',
				'Returns a readable plan and, when there are no problems, a planId for grandmcp_patch_apply. Always show the plan to the user before applying.',
			].join(' '),
			inputSchema: patchPlanInputSchema,
			annotations: { readOnlyHint: true, idempotentHint: true },
		},
		async (input) => {
			try {
				const { live, types, fingerprint } = await readPatch(ctx);
				const plan = planPatch(input, live, types);
				const planId = plan.errors.length === 0 ? ctx.plans.save({ kind: 'add', plan }, fingerprint) : undefined;

				return {
					content: [{ type: 'text', text: describePlan(plan, planId) }],
					structuredContent: { planId: planId ?? null, ...plan },
				};
			} catch (error) {
				return fromError(error);
			}
		},
	);

	server.registerTool(
		'grandmcp_patch_plan_changes',
		{
			title: 'Plan patch changes',
			description: [
				'Check changes to fixtures already in the show, without changing anything: remove, new fixture ID, rename, re-address or unpatch, and change fixture type or DMX mode.',
				'Fixtures are found by their current FID. Everything is checked on the final state, so swaps and moves into freed space work.',
				'The plan lists where removed or retyped fixtures are used (groups, cues, presets, layouts): removing a fixture drops it from them, and a type or mode change drops programmed values for attributes the new mode lacks. A new FID is safe: groups and cues follow the fixture.',
				'Returns a planId for grandmcp_patch_apply when there are no problems. Always show the plan to the user before applying.',
			].join(' '),
			inputSchema: patchChangesInputSchema,
			annotations: { readOnlyHint: true, idempotentHint: true },
		},
		async (input) => {
			try {
				const { live, types, fingerprint } = await readPatch(ctx);
				const plan = planChanges(input, live, types);
				const watched = plan.changes.filter((c) => c.remove || c.retype).map((c) => c.fid);

				if (watched.length > 0 && plan.errors.length === 0) {
					const { usage } = await ctx.bridge.request<{ usage: Record<string, string[]> }>('patch.usage', { fids: watched }, 120_000);
					for (const c of plan.changes) {
						const places = usage[String(c.fid)] ?? [];

						if (places.length > 0) {
							plan.warnings.push(
								c.remove
									? `FID ${c.fid} is used in ${places.join(', ')}; removing it drops it from them`
									: `FID ${c.fid} is used in ${places.join(', ')}; values for attributes that "${c.after?.mode}" lacks are dropped`,
							);
						}
					}
				}

				const planId = plan.errors.length === 0 && plan.changes.length > 0 ? ctx.plans.save({ kind: 'change', plan }, fingerprint) : undefined;

				return {
					content: [{ type: 'text', text: describeChanges(plan, planId) }],
					structuredContent: { planId: planId ?? null, ...plan },
				};
			} catch (error) {
				return fromError(error);
			}
		},
	);

	server.registerTool(
		'grandmcp_patch_apply',
		{
			title: 'Apply patch plan',
			description: [
				'Write a plan from grandmcp_patch_plan or grandmcp_patch_plan_changes to the console: backs up the live patch to gma3_library/patch, makes the changes in the patch edit copy, commits and reads everything back.',
				'The commit cannot be undone on the console; the backup XML is the record to recover from. Refused when the patch changed since the plan was made.',
			].join(' '),
			inputSchema: z.object({
				planId: z.string().min(1),
				duringPlayback: z
					.boolean()
					.default(false)
					.describe('Allow this while sequences are running. Only after the user explicitly agreed: it can change what the audience sees.'),
			}),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
		},
		async ({ planId, duringPlayback }) => {
			if (!ctx.allowWrite) {
				return WRITES_DISABLED;
			}

			const stored = ctx.plans.take(planId);

			if (!stored) {
				return failure(`No plan "${planId}" (plans expire after 30 minutes and can be applied once). Plan again.`);
			}

			try {
				return await ctx.serialize(async () => {
					const { fingerprint } = await readPatch(ctx);

					if (fingerprint !== stored.fingerprint) {
						return failure('The patch changed since this plan was made. Plan again and show the user the new plan.');
					}

					return stored.kind === 'add' ? applyAdd(ctx, stored.plan, duringPlayback) : applyChanges(ctx, stored.plan, duringPlayback);
				});
			} catch (error) {
				return fromError(error);
			}
		},
	);
}

function summarize(result: PatchAddResult, count: number, what: string): string {
	const failed = result.results.filter((r) => !r.ok);
	let summary: string;

	if (result.verifyError) {
		summary = `Committed ${count} ${what}, but reading them back failed (${result.verifyError}). Check with grandmcp_patch_list.`;
	} else if (result.verified) {
		summary = `Committed ${count} ${what} and verified them in the live patch.`;
	} else {
		summary = `Committed, but ${failed.length} fixture(s) did not read back as planned: FID ${failed.map((r) => r.fid).join(', ')}. Check with grandmcp_patch_list.`;
	}

	return `${summary}\nBackup of the previous patch: ${result.backup}`;
}

async function applyAdd(ctx: AppContext, plan: PatchPlan, duringPlayback: boolean): Promise<CallToolResult> {
	const fixtures = plan.fixtures.map((f) => ({
		fid: f.fid,
		name: f.name,
		type: f.type,
		mode: f.mode,
		...(f.patch ? { patch: f.patch } : {}),
		...(f.parent ? { parent: f.parent } : {}),
	}));
	const result = await ctx.bridge.request<PatchAddResult>('patch.add', { stage: plan.stage, fixtures, duringPlayback }, 30_000 + fixtures.length * 200);

	return ok(
		{ backup: result.backup, verified: result.verified, failed: result.results.filter((r) => !r.ok) },
		summarize(result, fixtures.length, `new fixtures into "${plan.stage}"`),
	);
}

async function applyChanges(ctx: AppContext, plan: ChangePlan, duringPlayback: boolean): Promise<CallToolResult> {
	const changes = plan.changes.map((c) => c.ops);
	const result = await ctx.bridge.request<PatchAddResult>('patch.change', { changes, duringPlayback }, 60_000 + changes.length * 500);

	return ok(
		{ backup: result.backup, verified: result.verified, failed: result.results.filter((r) => !r.ok) },
		summarize(result, changes.length, 'fixture changes'),
	);
}

function describeState(s: FixtureState): string {
	return `${s.fid} "${s.name}" ${s.type ?? '?'} / ${s.mode ?? '?'} @ ${s.patch ?? 'unpatched'}`;
}

function describeChanges(plan: ChangePlan, planId: string | undefined): string {
	const lines: string[] = [];

	if (planId) {
		lines.push(`Plan ${planId}: ${plan.changes.length} fixture change(s). Nothing has been written yet.`);
		lines.push('Show this to the user, including the warnings, and call grandmcp_patch_apply with the planId once they agree.');
	} else if (plan.errors.length > 0) {
		lines.push(`Plan rejected: ${plan.errors.length} problem(s). Nothing was stored or written.`);
	} else {
		lines.push('Nothing to change.');
	}

	if (plan.errors.length > 0) {
		lines.push('', 'Problems:', ...plan.errors.map((e) => `- ${e}`));
	}

	if (plan.warnings.length > 0) {
		lines.push('', 'Warnings:', ...plan.warnings.map((w) => `- ${w}`));
	}

	if (plan.changes.length > 0) {
		lines.push('');
		for (const c of plan.changes) {
			lines.push(c.remove || !c.after ? `REMOVE  ${describeState(c.before)}` : `CHANGE  ${describeState(c.before)}\n     ->  ${describeState(c.after)}`);
		}
	}

	return lines.join('\n');
}
