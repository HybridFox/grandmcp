import { describe, expect, it } from 'vitest';

import { joinBlocks, pickWindow } from '../src/tools/screenshot.ts';

describe('joinBlocks', () => {
	it('decodes each block on its own before joining', () => {
		const parts = [Buffer.from([0x89, 0x50]), Buffer.from([0x4e, 0x47, 0x0d])];
		const joined = joinBlocks(parts.map((p) => p.toString('base64')));

		expect([...joined]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d]);
	});
});

describe('pickWindow', () => {
	it('picks the window of the requested screen, or the only one', () => {
		const windows = [
			{ id: 1, name: 'Display 1 onPC 2.5.1.1 [Show]' },
			{ id: 2, name: 'Display 2 onPC 2.5.1.1 [Show]' },
		];

		expect(pickWindow(windows, 2)?.id).toBe(2);
		expect(pickWindow(windows, 3)).toBeUndefined();
		expect(pickWindow([{ id: 7, name: 'Display 1 onPC' }], 4)?.id).toBe(7);
		expect(
			pickWindow(
				[
					{ id: 9, name: 'Display 10 onPC' },
					{ id: 1, name: 'Display 1 onPC' },
				],
				1,
			)?.id,
		).toBe(1);
	});
});
