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
	parent: z
		.number()
		.int()
		.min(1)
		.optional()
		.describe('FID of a grouping fixture (fixture type "Grouping") to put these fixtures under: one in the show or one created by an earlier row.'),
	universe: z
		.number()
		.int()
		.min(1)
		.max(1024)
		.optional()
		.describe(
			'Universe to start filling when patch is "auto" (default 1). When it is full the row continues in the next universe, and the plan warns about it.',
		),
});

export const patchPlanInputSchema = z.object({
	stage: z.string().min(1).optional().describe('Stage to patch into. Defaults to the first stage.'),
	fixtures: z.array(fixtureEntrySchema).min(1).max(1000),
});

export type FixtureEntry = z.output<typeof fixtureEntrySchema>;
export type PatchPlanInput = z.output<typeof patchPlanInputSchema>;

export const POSITION_FIELDS = ['posX', 'posY', 'posZ', 'rotX', 'rotY', 'rotZ'] as const;

/** One change to an existing fixture, found by its current FID. */
export const fixtureChangeSchema = z
	.object({
		fid: z.number().int().min(1).describe('Current fixture ID of the fixture to change.'),
		remove: z.boolean().optional().describe('Delete the fixture. Cannot be combined with other changes.'),
		newFid: z.number().int().min(1).optional().describe('New fixture ID. Groups and cues follow the fixture.'),
		name: z.string().min(1).optional().describe('New fixture name.'),
		patch: z
			.string()
			.regex(/^(none|\d{1,4}\.\d{1,3})$/, 'use "none" or "universe.address" like "1.23"')
			.optional()
			.describe('New start address ("universe.address") or "none" to unpatch.'),
		type: z.string().min(1).optional().describe('Change to this fixture type (must be in the show). Requires mode unless the type has a single mode.'),
		mode: z.string().min(1).optional().describe('Change to this DMX mode (of the new type, or of the current type).'),
		posX: z.number().optional().describe('3D position in metres: X (stage left/right).'),
		posY: z.number().optional().describe('3D position in metres: Y (downstage/upstage).'),
		posZ: z.number().optional().describe('3D position in metres: Z (height).'),
		rotX: z
			.number()
			.optional()
			.describe('3D rotation in degrees around X. In grandMA3, 0 = hanging from a truss (beam down), 180 = standing on the floor (beam up).'),
		rotY: z.number().optional().describe('3D rotation in degrees around Y.'),
		rotZ: z.number().optional().describe('3D rotation in degrees around Z (which way the fixture faces).'),
	})
	.refine(
		(c) =>
			!c.remove ||
			(POSITION_FIELDS.every((k) => c[k] === undefined) &&
				c.newFid === undefined &&
				c.name === undefined &&
				c.patch === undefined &&
				c.type === undefined &&
				c.mode === undefined),
		{
			message: 'remove cannot be combined with other changes',
		},
	)
	.refine((c) => c.remove || [c.newFid, c.name, c.patch, c.type, c.mode, ...POSITION_FIELDS.map((k) => c[k])].some((v) => v !== undefined), {
		message: 'give at least one change (remove, newFid, name, patch, type, mode or a 3D position/rotation)',
	});

export const patchChangesInputSchema = z.object({
	changes: z.array(fixtureChangeSchema).min(1).max(1000),
});

export type FixtureChange = z.output<typeof fixtureChangeSchema>;
export type PatchChangesInput = z.output<typeof patchChangesInputSchema>;
