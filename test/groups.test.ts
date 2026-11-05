import { describe, expect, it } from 'vitest';

import { fidRanges } from '../src/tools/groups.ts';

describe('fidRanges', () => {
	it('collapses consecutive IDs and keeps the given order', () => {
		expect(fidRanges([301, 302, 303, 1101, 150])).toBe('301-303, 1101, 150');
		expect(fidRanges([5])).toBe('5');
		expect(fidRanges([])).toBe('');
	});
});
