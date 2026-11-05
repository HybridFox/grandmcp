import { describe, expect, it } from 'vitest';

import { joinBlocks } from '../src/tools/screenshot.ts';

describe('joinBlocks', () => {
	it('decodes each block on its own before joining', () => {
		const parts = [Buffer.from([0x89, 0x50]), Buffer.from([0x4e, 0x47, 0x0d])];
		const joined = joinBlocks(parts.map((p) => p.toString('base64')));

		expect([...joined]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d]);
	});
});
