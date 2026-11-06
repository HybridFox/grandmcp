import { describe, expect, it } from 'vitest';

import type { FixtureType, LivePatch } from '../src/bridge/types.ts';
import { formatAddress, parseAddress, planPatch } from '../src/patch/planner.ts';
import { patchPlanInputSchema } from '../src/patch/schema.ts';

const types: FixtureType[] = [
	{
		index: 1,
		name: 'Dimmer',
		manufacturer: 'Generic',
		modes: [
			{ name: '16 bit', footprint: 2, breaks: 1 },
			{ name: 'Mode 0', footprint: 1, breaks: 1 },
		],
	},
	{ index: 2, name: 'Robin LEDBeam 150 RGBA', manufacturer: 'Robe', modes: [{ name: 'Standard 16-Bit', footprint: 22, breaks: 1 }] },
	{ index: 3, name: 'Jolt Panel FX', manufacturer: 'ADJ', modes: [{ name: '81 Channel', footprint: 81, breaks: 1 }] },
	{ index: 4, name: 'Two Break', modes: [{ name: 'Split', footprint: 4, breaks: 2 }] },
	{ index: 5, name: 'Grouping', modes: [{ name: 'Default', footprint: 0, breaks: 1 }] },
];

const emptyPatch: LivePatch = { stages: ['Stage 1'], fixtures: [] };

const livePatch: LivePatch = {
	stages: ['Stage 1'],
	fixtures: [
		{
			stage: 'Stage 1',
			fid: '101',
			idType: 'Fixture',
			name: 'Dim 101',
			type: 'Dimmer',
			mode: 'Mode 0',
			patch: '1.001',
			footprint: 1,
			conflicted: false,
			children: 0,
			subfixtures: 0,
		},
		{
			stage: 'Stage 1',
			fid: '102',
			idType: 'Fixture',
			name: 'Dim 102',
			type: 'Dimmer',
			mode: 'Mode 0',
			patch: '1.002',
			footprint: 1,
			conflicted: false,
			children: 0,
			subfixtures: 0,
		},
	],
};

const plan = (fixtures: unknown[], live: LivePatch = emptyPatch, stage?: string) => planPatch(patchPlanInputSchema.parse({ fixtures, stage }), live, types);

describe('addresses', () => {
	it('parses report-style addresses without leading zeros', () => {
		expect(parseAddress('1.23')).toEqual({ universe: 1, address: 23 });
		expect(parseAddress('3.500')).toEqual({ universe: 3, address: 500 });
		expect(parseAddress('1.513')).toBeUndefined();
		expect(parseAddress('0.1')).toBeUndefined();
	});

	it('formats as MA writes them', () => {
		expect(formatAddress(1, 1)).toBe('1.001');
		expect(formatAddress(12, 345)).toBe('12.345');
	});
});

describe('planPatch', () => {
	it('lays out consecutive fixtures from an explicit start address', () => {
		const result = plan([{ fid: 301, count: 3, type: 'Robin LEDBeam 150 RGBA', patch: '3.1', name: 'Beam' }]);

		expect(result.errors).toEqual([]);
		expect(result.fixtures.map((f) => [f.fid, f.name, f.patch])).toEqual([
			[301, 'Beam 1', '3.001'],
			[302, 'Beam 2', '3.023'],
			[303, 'Beam 3', '3.045'],
		]);
	});

	it('requires a mode when the type has several', () => {
		const result = plan([{ fid: 1, type: 'Dimmer' }]);

		expect(result.errors[0]).toMatch(/several modes.*"16 bit" \(2 ch\)/);
	});

	it('matches type and mode names case-insensitively', () => {
		const result = plan([{ fid: 1, type: 'dimmer', mode: 'mode 0' }]);

		expect(result.errors).toEqual([]);
		expect(result.fixtures[0]).toMatchObject({ type: 'Dimmer', mode: 'Mode 0' });
	});

	it('reports missing types', () => {
		const result = plan([{ fid: 1, type: 'Polar Lights 350W BSW' }]);

		expect(result.missingTypes).toEqual(['Polar Lights 350W BSW']);
		expect(result.fixtures).toEqual([]);
	});

	it('auto-patches around fixtures already in the show', () => {
		const result = plan([{ fid: 103, count: 2, type: 'Dimmer', mode: '16 bit' }], livePatch);

		expect(result.errors).toEqual([]);
		expect(result.fixtures.map((f) => f.patch)).toEqual(['1.003', '1.005']);
	});

	it('moves to the next universe when one is full', () => {
		const free = plan([{ fid: 1, count: 7, type: 'Jolt Panel FX' }]);

		expect(free.errors).toEqual([]);
		expect(free.warnings).toEqual([]);
		expect(free.fixtures.map((f) => f.patch)).toEqual(['1.001', '1.082', '1.163', '1.244', '1.325', '1.406', '2.001']);
	});

	it('starts at the given universe and warns when the row continues past it', () => {
		const result = plan([{ fid: 1, count: 8, type: 'Jolt Panel FX', universe: 4 }]);

		expect(result.errors).toEqual([]);
		expect(result.fixtures.map((f) => f.patch)).toEqual(['4.001', '4.082', '4.163', '4.244', '4.325', '4.406', '5.001', '5.082']);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toMatch(/universe 4 is full: FID 7-8 continue in universe 5/);
	});

	it('rejects FIDs that exist in the show or twice in the plan', () => {
		const result = plan(
			[
				{ fid: 101, type: 'Dimmer', mode: 'Mode 0', patch: 'none' },
				{ fid: 200, type: 'Dimmer', mode: 'Mode 0', patch: 'none' },
				{ fid: 200, type: 'Dimmer', mode: 'Mode 0', patch: 'none' },
			],
			livePatch,
		);

		expect(result.errors).toHaveLength(2);
		expect(result.errors[0]).toMatch(/FID 101 is already used by "Dim 101" in the show/);
		expect(result.errors[1]).toMatch(/FID 200 is already used by FID 200/);
	});

	it('rejects overlaps with the show and within the plan', () => {
		const withShow = plan([{ fid: 1, type: 'Dimmer', mode: '16 bit', patch: '1.002' }], livePatch);

		expect(withShow.errors[0]).toMatch(/1\.002 overlaps FID 102 "Dim 102"/);

		const withinPlan = plan([
			{ fid: 1, type: 'Jolt Panel FX', patch: '2.1' },
			{ fid: 2, type: 'Robin LEDBeam 150 RGBA', patch: '2.50' },
		]);

		expect(withinPlan.errors[0]).toMatch(/FID 2 at 2\.050 overlaps FID 1/);
	});

	it('rejects fixtures that run past the end of the universe', () => {
		const result = plan([{ fid: 1, type: 'Jolt Panel FX', patch: '1.450' }]);

		expect(result.errors[0]).toMatch(/runs past channel 512/);
	});

	it('leaves fixtures unpatched with "none" and claims no channels', () => {
		const result = plan([
			{ fid: 1, count: 2, type: 'Jolt Panel FX', patch: 'none' },
			{ fid: 3, type: 'Jolt Panel FX' },
		]);

		expect(result.errors).toEqual([]);
		expect(result.fixtures.map((f) => f.patch)).toEqual([null, null, '1.001']);
	});

	it('refuses multi-break modes and unknown stages', () => {
		expect(plan([{ fid: 1, type: 'Two Break' }]).errors[0]).toMatch(/2 DMX breaks/);
		expect(plan([{ fid: 1, type: 'Dimmer', mode: 'Mode 0' }], emptyPatch, 'Stage 9').errors[0]).toMatch(/stage "Stage 9" does not exist/);
	});

	it('names fixtures after the type when no name is given', () => {
		const result = plan([{ fid: 7, type: 'Dimmer', mode: 'Mode 0' }]);

		expect(result.fixtures[0]?.name).toBe('Dimmer 7');
	});

	it('creates a grouping fixture and puts new fixtures under it', () => {
		const result = plan([
			{ fid: 2000, name: 'Truss Left', type: 'Grouping' },
			{ fid: 2001, count: 2, name: 'TL Beam', type: 'Robin LEDBeam 150 RGBA', patch: '5.1', parent: 2000 },
		]);

		expect(result.errors).toEqual([]);
		expect(result.fixtures.map((f) => [f.fid, f.patch, f.parent])).toEqual([
			[2000, null, undefined],
			[2001, '5.001', 2000],
			[2002, '5.023', 2000],
		]);
	});

	it('refuses to patch a grouping fixture or use a normal fixture as parent', () => {
		expect(plan([{ fid: 2000, type: 'Grouping', patch: '1.5' }]).errors[0]).toMatch(/no DMX channels/);
		expect(plan([{ fid: 1, type: 'Dimmer', mode: 'Mode 0', parent: 101 }], livePatch).errors[0]).toMatch(/parent FID 101 is not a grouping fixture/);
		expect(plan([{ fid: 1, type: 'Dimmer', mode: 'Mode 0', parent: 7 }]).errors[0]).toMatch(/parent FID 7 is neither/);
	});
});
