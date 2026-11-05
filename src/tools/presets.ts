import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import type { AppContext } from '../context.ts';

import { fidRanges } from './groups.ts';
import { fromError, ok, WRITES_DISABLED } from './result.ts';

interface AttributeInfo {
	type: string;
	mode: string;
	attributes: { attribute: string; functions: { name: string; attribute?: string; physFrom?: number; physTo?: number; slots: string[] }[] }[];
}

interface PresetInfo {
	pool: number;
	poolName: string;
	no: number;
	name: string;
	fixtures: number[];
	attributes: string[];
}

interface StoreResult {
	pool: number;
	no: number;
	name: string;
	values: number;
	effects?: number;
	verified: boolean;
	mismatches: string[];
	backup?: string;
}

const POOLS = 'Pools: 1 Dimmer, 2 Position, 3 Gobo, 4 Color, 5 Beam, 6 Focus, 7 Control, 8 Shapers, 9 Video, 21-25 All (mixed attributes, for complete looks).';

const singleValueFields = {
	slot: z.string().min(1).optional().describe('Named slot of the attribute, e.g. a color wheel position "C3", a gobo "G2", "open", or a gel macro.'),
	percent: z.number().min(0).max(100).optional().describe("0-100 across the function's range, e.g. Dimmer 80, Pan 50 (= centre)."),
	physical: z.number().optional().describe("Value in the function's physical unit, e.g. Pan -45 (degrees), Zoom 20 (degrees), strobe 8 (Hz)."),
	function: z.string().min(1).optional().describe('Channel function to use when the attribute has several, e.g. "Shutter1Strobe".'),
};

const oneValue = (v: { slot?: string; percent?: number; physical?: number }) => [v.slot, v.percent, v.physical].filter((x) => x !== undefined).length === 1;

export const effectStepSchema = z
	.object({
		...singleValueFields,
		width: z.number().min(0).max(100).optional().describe('How much of its step time the value is held, in percent (default 100).'),
		trans: z.number().min(0).max(100).optional().describe('Transition into the step: 0 = snap, 100 = smooth fade (default 100).'),
	})
	.refine(oneValue, { message: 'give exactly one of slot, percent or physical per step' });

export const effectSchema = z.object({
	steps: z.array(effectStepSchema).min(2).max(48),
	bpm: z.number().positive().max(3000).default(60).describe('Speed: full cycles per minute.'),
	speedMaster: z
		.number()
		.int()
		.min(1)
		.max(16)
		.optional()
		.describe('Link the effect to speed master 1-16 so its speed follows that master (BPM tap) when busking.'),
	pattern: z
		.object({
			blocks: z.number().int().min(1).optional().describe('Neighbouring fixtures share a step in blocks of this size.'),
			groups: z.number().int().min(1).optional().describe('Every n-th fixture shares a step (2 = odd/even).'),
			wings: z.number().int().min(1).optional().describe('Mirror the pattern across this many wings (2 = symmetric from the outside in).'),
			invert: z.boolean().optional().describe('Reverse the order (with wings 2: from the centre out).'),
		})
		.optional()
		.describe("How the phase spread is laid over the fixtures, like MAtricks on one axis, in the order of the entry's fids."),
	phase: z
		.object({ from: z.number(), to: z.number() })
		.optional()
		.describe("Phase spread over the entry's fixtures in degrees, e.g. { from: 0, to: 360 } for a chase across them, omitted = all in sync."),
});

export const presetValueSchema = z
	.object({ ...singleValueFields, effect: effectSchema.optional().describe('An effect (phaser) instead of a static value.') })
	.refine((v) => (v.effect ? [v.slot, v.percent, v.physical].every((x) => x === undefined) : oneValue(v)), {
		message: 'give exactly one of slot, percent, physical or effect',
	});

export function registerPresetTools(server: McpServer, ctx: AppContext): void {
	server.registerTool(
		'grandmcp_fixture_attributes',
		{
			title: 'Fixture attributes',
			description:
				'What a fixture type can do: its attributes (Dimmer, Pan, Color1, Gobo1, Zoom, Shutter1, ...), each with channel functions, physical ranges and named slots (wheel positions, gel macros, strobe modes). Use it before building presets so values match the real fixture.',
			inputSchema: z.object({ type: z.string().min(1), mode: z.string().min(1).optional() }),
			annotations: { readOnlyHint: true, idempotentHint: true },
		},
		async ({ type, mode }) => {
			try {
				const info = await ctx.bridge.request<AttributeInfo>('fixture.attributes', { type, ...(mode ? { mode } : {}) });
				const lines = [`${info.type} / ${info.mode}`];
				for (const a of info.attributes) {
					const fns = a.functions
						.filter((f) => !/^nofeature/i.test(f.name))
						.map((f) => `${f.name} [${f.physFrom ?? '?'}..${f.physTo ?? '?'}]${f.slots.length ? ` slots: ${f.slots.join(', ')}` : ''}`);
					lines.push(`- ${a.attribute}: ${fns.join(' | ')}`);
				}

				return { content: [{ type: 'text', text: lines.join('\n') }], structuredContent: { ...info } };
			} catch (error) {
				return fromError(error);
			}
		},
	);

	server.registerTool(
		'grandmcp_preset_list',
		{
			title: 'List presets',
			description: `List presets with their fixtures and attributes. ${POOLS}`,
			inputSchema: z.object({ pool: z.number().int().min(1).max(30).optional() }),
			annotations: { readOnlyHint: true, idempotentHint: true },
		},
		async ({ pool }) => {
			try {
				const presets = await ctx.bridge.request<PresetInfo[]>('preset.list', pool ? { pool } : {}, 60_000);
				const text =
					presets.length === 0
						? 'No presets.'
						: presets
								.map((p) => `${p.pool}.${p.no} "${p.name}" (${p.poolName}): ${p.attributes.join(', ')} on FID ${fidRanges(p.fixtures)}`)
								.join('\n');

				return { content: [{ type: 'text', text }], structuredContent: { presets } };
			} catch (error) {
				return fromError(error);
			}
		},
	);

	server.registerTool(
		'grandmcp_preset_store',
		{
			title: 'Store preset',
			description: [
				'Create or replace a preset from explicit values per fixture, without touching the programmer.',
				'Each entry gives fixture IDs and attribute values; values are a named slot, a percent of the range, a physical value (see grandmcp_fixture_attributes), or an effect: steps of such values with a speed in BPM and a phase spread over the fixtures (e.g. a dimmer chase or a color chase).',
				'Values are converted per fixture type and verified after import. Replacing a preset exports the old one to gma3_library/datapools/presets first.',
				POOLS,
			].join(' '),
			inputSchema: z.object({
				pool: z.number().int().min(1).max(30),
				no: z.number().int().min(1).max(9999),
				name: z.string().min(1).max(200),
				overwrite: z.boolean().default(false),
				entries: z
					.array(
						z.object({
							fids: z.array(z.number().int().min(1)).min(1),
							values: z
								.record(z.string().min(1), presetValueSchema)
								.describe('Attribute name -> value, e.g. { "Dimmer": { "percent": 100 }, "Color1": { "slot": "C3" } }.'),
						}),
					)
					.min(1),
			}),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
		},
		async (input) => {
			if (!ctx.allowWrite) {
				return WRITES_DISABLED;
			}

			try {
				const result = await ctx.serialize(() => ctx.bridge.request<StoreResult>('preset.store', input, 60_000));
				const lines = [
					result.verified
						? `Stored preset ${result.pool}.${result.no} "${result.name}" with ${result.values} values${result.effects ? ` and ${result.effects} effect channels` : ''}, verified.`
						: `Stored preset ${result.pool}.${result.no} "${result.name}", but ${result.mismatches.length} value(s) did not come out as intended:`,
					...result.mismatches.map((m) => `- ${m}`),
				];

				if (result.backup) {
					lines.push(`The previous preset was exported to ${result.backup}.`);
				}

				return ok(result, lines.join('\n'));
			} catch (error) {
				return fromError(error);
			}
		},
	);
}
