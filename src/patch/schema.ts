import * as z from 'zod/v4';

/** The contract between "Claude read a plot" and "the planner patches it": one row per fixture group. */
export const fixtureEntrySchema = z.object({
	fid: z.number().int().min(1).describe('Fixture ID of the first fixture. With count > 1 the following fixtures get consecutive IDs.'),
	count: z.number().int().min(1).max(512).default(1).describe('Number of identical fixtures in this row.'),
	name: z.string().min(1).optional().describe('Fixture name. With count > 1 it gets " 1", " 2", ... appended. Defaults to "<type> <fid>".'),
	type: z.string().min(1).describe('Fixture type name exactly as it exists in the show (see grandmcp_fixture_types).'),
	mode: z.string().min(1).optional().describe('DMX mode name. May be omitted when the type has a single mode.'),
	patch: z
		.string()
		.regex(/^(auto|none|\d{1,4}\.\d{1,3})$/, 'use "auto", "none" or "universe.address" like "1.23"')
		.default('auto')
		.describe(
			'Start address as "universe.address" (e.g. "1.23" or "2.001"), "auto" for the first free block, or "none" to leave unpatched. With count > 1 the fixtures follow each other.',
		),
	universe: z
		.number()
		.int()
		.min(1)
		.max(1024)
		.optional()
		.describe('Universe to fill when patch is "auto". Defaults to 1, moving on to the next universe when full.'),
});

export const patchPlanInputSchema = z.object({
	stage: z.string().min(1).optional().describe('Stage to patch into. Defaults to the first stage.'),
	fixtures: z.array(fixtureEntrySchema).min(1).max(1000),
});

export type FixtureEntry = z.output<typeof fixtureEntrySchema>;
export type PatchPlanInput = z.output<typeof patchPlanInputSchema>;
