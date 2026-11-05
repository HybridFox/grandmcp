import { describe, expect, it } from 'vitest';

import { presetValueSchema } from '../src/tools/presets.ts';

describe('preset values', () => {
	it('takes exactly one of slot, percent or physical', () => {
		expect(presetValueSchema.safeParse({ slot: 'C3' }).success).toBe(true);
		expect(presetValueSchema.safeParse({ physical: 8, function: 'Shutter1Strobe' }).success).toBe(true);
		expect(presetValueSchema.safeParse({ slot: 'C3', percent: 50 }).success).toBe(false);
		expect(presetValueSchema.safeParse({}).success).toBe(false);
		expect(presetValueSchema.safeParse({ percent: 120 }).success).toBe(false);
	});

	it('takes an effect with at least two steps instead of a static value', () => {
		const chase = { effect: { bpm: 120, phase: { from: 0, to: 360 }, steps: [{ percent: 100, width: 25, trans: 0 }, { percent: 0 }] } };

		expect(presetValueSchema.safeParse(chase).success).toBe(true);
		expect(presetValueSchema.safeParse({ effect: { ...chase.effect, speedMaster: 1 } }).success).toBe(true);
		expect(presetValueSchema.safeParse({ effect: { ...chase.effect, speedMaster: 17 } }).success).toBe(false);
		expect(presetValueSchema.safeParse({ ...chase, percent: 50 }).success).toBe(false);
		expect(presetValueSchema.safeParse({ effect: { steps: [{ slot: 'C1' }] } }).success).toBe(false);
		expect(presetValueSchema.safeParse({ effect: { steps: [{ slot: 'C1' }, { slot: 'C2', percent: 3 }] } }).success).toBe(false);
	});
});

describe('cues', () => {
	it('accepts preset references and value looks', async () => {
		const { cueSchema } = await import('../src/tools/sequences.ts');

		expect(cueSchema.safeParse({ name: 'a', looks: [{ preset: { pool: 4, no: 1 } }] }).success).toBe(true);
		expect(cueSchema.safeParse({ looks: [{ fids: [1], values: { Dimmer: { percent: 50 } } }], trigger: 'follow', triggerTime: 2 }).success).toBe(true);
		expect(cueSchema.safeParse({ looks: [] }).success).toBe(false);
		expect(cueSchema.safeParse({ looks: [{ preset: { pool: 4, no: 1 } }], trigger: 'later' }).success).toBe(false);
	});
});

describe('read summaries', () => {
	it('groups fixtures with identical values and names effects', async () => {
		const { describePresetRead, describeSequenceRead } = await import('../src/tools/editing.ts');
		const preset = describePresetRead({
			pool: 1,
			no: 4,
			name: 'Wave',
			fixtures: [
				{ fid: 201, type: 'PL', values: { Dimmer: { effect: { bpm: 132, phase: 0, steps: [{ percent: 100 }, { percent: 10 }] } } } },
				{ fid: 202, type: 'PL', values: { Color1: { slot: 'C3' } } },
				{ fid: 203, type: 'PL', values: { Color1: { slot: 'C3' } } },
			],
		});

		expect(preset).toContain('FID 201 PL: Dimmer effect 132 BPM, phase 0°: 100% > 10%');
		expect(preset).toContain('FID 202, 203 PL: Color1 C3');
		expect(
			describeSequenceRead({
				no: 20,
				name: 'T',
				executors: ['2.201'],
				cues: [{ no: 1, name: 'a', fade: '1.00', presets: ['s4.1'], ownValueFixtures: [301] }],
			}),
		).toContain('1 "a" fade 1.00: preset s4.1; own values on FID 301');
	});
});
