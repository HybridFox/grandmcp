import { describe, expect, it } from 'vitest';

import type { FixtureType, LiveFixture, LivePatch } from '../src/bridge/types.ts';
import { planChanges } from '../src/patch/changes.ts';
import { patchChangesInputSchema } from '../src/patch/schema.ts';

const types: FixtureType[] = [
	{
		index: 1,
		name: 'Dimmer',
		modes: [
			{ name: 'Mode 0', footprint: 1, breaks: 1 },
			{ name: '16 bit', footprint: 2, breaks: 1 },
		],
	},
	{
		index: 2,
		name: 'Beam',
		modes: [
			{ name: 'Mode 1', footprint: 22, breaks: 1 },
			{ name: 'Mode 2', footprint: 16, breaks: 1 },
		],
	},
	{ index: 3, name: 'Wash', modes: [{ name: '36ch ', footprint: 36, breaks: 1 }] },
];

const fixture = (fid: number, name: string, type: string, mode: string, footprint: number, patch?: string): LiveFixture => ({
	stage: 'Stage 1',
	fid: String(fid),
	idType: 'Fixture',
	name,
	type,
	mode,
	footprint,
	patch,
	conflicted: false,
	children: 0,
	subfixtures: 0,
});

const grouped: LivePatch = {
	stages: ['Stage 1'],
	fixtures: [
		{ ...fixture(2000, 'Truss', 'Grouping', 'Default', 0), children: 2 },
		{ ...fixture(2001, 'T1', 'Dimmer', 'Mode 0', 1, '5.001'), parent: '2000' },
		{ ...fixture(2002, 'T2', 'Dimmer', 'Mode 0', 1, '5.002'), parent: '2000' },
	],
};

const live: LivePatch = {
	stages: ['Stage 1'],
	fixtures: [
		fixture(101, 'Dim 1', 'Dimmer', 'Mode 0', 1, '1.001'),
		fixture(102, 'Dim 2', 'Dimmer', 'Mode 0', 1, '1.002'),
		fixture(301, 'Beam 1', 'Beam', 'Mode 1', 22, '3.001'),
		fixture(302, 'Beam 2', 'Beam', 'Mode 1', 22, '3.023'),
	],
};

const plan = (changes: unknown[]) => planChanges(patchChangesInputSchema.parse({ changes }), live, types);

describe('change schema', () => {
	it('rejects remove combined with other changes and empty changes', () => {
		expect(patchChangesInputSchema.safeParse({ changes: [{ fid: 1, remove: true, name: 'x' }] }).success).toBe(false);
		expect(patchChangesInputSchema.safeParse({ changes: [{ fid: 1 }] }).success).toBe(false);
	});
});

describe('planChanges', () => {
	it('removes fixtures and frees their channels and FIDs for other changes', () => {
		const result = plan([
			{ fid: 101, remove: true },
			{ fid: 102, newFid: 101, patch: '1.1' },
		]);

		expect(result.errors).toEqual([]);
		expect(result.changes.map((c) => c.ops)).toEqual([
			{ fid: 101, remove: true },
			{ fid: 102, newFid: 101, patch: '1.001' },
		]);
	});

	it('allows swapping FIDs and addresses', () => {
		const result = plan([
			{ fid: 301, newFid: 302, patch: '3.23' },
			{ fid: 302, newFid: 301, patch: '3.1' },
		]);

		expect(result.errors).toEqual([]);
	});

	it('rejects a new FID that another fixture keeps', () => {
		expect(plan([{ fid: 101, newFid: 102 }]).errors[0]).toMatch(/FID 102 would be used twice/);
	});

	it('checks overlaps on the final footprint after a mode change', () => {
		const grow = plan([{ fid: 101, type: 'Dimmer', mode: '16 bit' }]);

		expect(grow.errors[0]).toMatch(/FID 101 "Dim 1" at 1\.001 \(2 ch\) would overlap FID 102/);

		const shrink = plan([{ fid: 301, mode: 'Mode 2' }]);

		expect(shrink.errors).toEqual([]);
		expect(shrink.changes[0]).toMatchObject({ retype: true, ops: { fid: 301, type: 'Beam', mode: 'Mode 2', patch: '3.001' } });
	});

	it('needs a mode when the new type has several, and matches modes with trailing spaces', () => {
		expect(plan([{ fid: 101, type: 'Beam' }]).errors[0]).toMatch(/several modes/);

		const result = plan([{ fid: 301, type: 'Wash', patch: '4.1' }]);

		expect(result.errors).toEqual([]);
		expect(result.changes[0]?.ops).toEqual({ fid: 301, type: 'Wash', mode: '36ch ', patch: '4.001' });
	});

	it('rejects addresses past the end of the universe and unknown fixtures', () => {
		expect(plan([{ fid: 302, patch: '3.500' }]).errors[0]).toMatch(/runs past channel 512/);
		expect(plan([{ fid: 999, name: 'x' }]).errors[0]).toMatch(/FID 999: no fixture/);
	});

	it('unpatches with "none" and warns about no-op changes and duplicate names', () => {
		const result = plan([
			{ fid: 101, patch: 'none' },
			{ fid: 102, name: 'Dim 2' },
			{ fid: 301, name: 'Beam 2' },
		]);

		expect(result.errors).toEqual([]);
		expect(result.changes.map((c) => c.ops)).toEqual([
			{ fid: 101, patch: '' },
			{ fid: 301, name: 'Beam 2' },
		]);
		expect(result.warnings.join('\n')).toMatch(/FID 102: already in the requested state/);
		expect(result.warnings.join('\n')).toMatch(/also named "Beam 2"/);
	});

	it('rejects the same fixture listed twice', () => {
		expect(
			plan([
				{ fid: 101, name: 'a' },
				{ fid: 101, patch: 'none' },
			]).errors[0],
		).toMatch(/listed more than once/);
	});

	it('removes the fixtures under a grouping fixture along with it', () => {
		const withGrouping = [...types, { index: 9, name: 'Grouping', modes: [{ name: 'Default', footprint: 0, breaks: 1 }] }];
		const run = (changes: unknown[]) => planChanges(patchChangesInputSchema.parse({ changes }), grouped, withGrouping);
		const removal = run([{ fid: 2000, remove: true }]);

		expect(removal.errors).toEqual([]);
		expect(removal.warnings[0]).toMatch(/also removes the 2 fixture\(s\) under it \(FID 2001, 2002\)/);
		expect(
			run([
				{ fid: 2000, remove: true },
				{ fid: 2001, name: 'x' },
			]).errors[0],
		).toMatch(/grouping fixture 2000 is removed/);
		expect(run([{ fid: 2001, type: 'Dimmer', mode: '16 bit' }]).errors[0]).toMatch(/inside a grouping fixture is not supported/);
		expect(run([{ fid: 2001, name: 'T1 renamed', patch: '5.10' }]).errors).toEqual([]);
	});
});
