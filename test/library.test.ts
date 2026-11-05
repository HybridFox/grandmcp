import { describe, expect, it } from 'vitest';

import type { LibraryEntry, LibrarySource } from '../src/bridge/types.ts';
import { searchLibrary } from '../src/patch/library.ts';

const entry = (source: LibrarySource, file: string, manufacturer: string, name: string, footprints: number[] = [], path = '/lib'): LibraryEntry => ({
	source,
	file,
	path,
	manufacturer,
	name,
	modes: footprints.map((footprint) => ({ name: `${footprint}ch`, footprint })),
});

const catalog: LibraryEntry[] = [
	entry('grandma2', 'robe@robin ledbeam 150.pxml', 'Robe', 'Robin LEDBeam 150', [16]),
	entry('grandma2', 'robe@robin ledbeam 150 rgba.pxml', 'Robe', 'Robin LEDBeam 150 RGBA', [22, 16]),
	entry('grandma2', 'robe@robin ledbeam 150 fw rgba.pxml', 'Robe', 'Robin LEDBeam 150 FW RGBA', [22]),
	entry('grandma2', 'look solutions@unique 2 1.pxml', 'Look Solutions', 'Unique 2.1', [2]),
	entry('grandma2', 'adj@jolt panel fx.pxml', 'ADJ', 'Jolt Panel FX', [6, 126]),
	entry('gdtf-share', 'ADJ@Jolt Panel FXIP@25-13-05 Release.gdtf', 'ADJ', 'Jolt Panel FXIP', [81, 141], 'ws://GDTFShare/id=96668'),
	entry('gdtf-share', 'Polarlights@PL-L350CMY@PL-L350CMY.gdtf', 'Polarlights', 'PL-L350CMY', [22], 'ws://GDTFShare/id=165002'),
	entry('gdtf-share', 'Polarlights@PL-L350B@PL-L350B.gdtf', 'Polarlights', 'PL-L350B', [20], 'ws://GDTFShare/id=161495'),
	entry('gdtf-share', 'Polar Lights@PL-L250BWS@1_0_1.gdtf', 'Polar Lights', 'PL-L250BWS', [22], 'ws://GDTFShare/id=107131'),
	entry('user', 'Jolt Panel FXIP.gdtf', 'ADJ', 'Jolt Panel FXIP', [81]),
	entry('grandma3', 'set@trusses_eurotruss_C-HUELSE3.xml', 'Eurotruss', 'C-HUELSE3'),
	entry('grandma2', 'generic@dimmer.pxml', 'Generic', 'Dimmer', [1, 2]),
];

const top = (query: string, footprint?: number) => searchLibrary(catalog, query, { limit: 5, footprint });

describe('searchLibrary', () => {
	it('ranks the exact model above its variants', () => {
		const hits = top('Robe Robin LEDBeam 150 RGBA');

		expect(hits[0]).toMatchObject({ file: 'robe@robin ledbeam 150 rgba.pxml', exact: true, score: 1 });
		expect(hits[1]?.file).toBe('robe@robin ledbeam 150 fw rgba.pxml');
	});

	it('treats "2.1" like "2 1"', () => {
		expect(top('Look Solutions Unique 2.1')[0]).toMatchObject({ file: 'look solutions@unique 2 1.pxml', exact: true });
	});

	it("prefers the user's copy, then Share entries, over the MA2 library for the same fixture", () => {
		const hits = top('ADJ Jolt Panel FXIP');

		expect(hits.map((h) => h.source).slice(0, 2)).toEqual(['user', 'gdtf-share']);
		expect(hits.find((h) => h.file === 'adj@jolt panel fx.pxml')?.exact).toBe(false);
	});

	it('ignores the revision part of Share file names', () => {
		expect(top('Polar Lights PL-L250BWS')[0]).toMatchObject({ name: 'PL-L250BWS', exact: true, score: 1 });
	});

	it('matches numbers inside model codes and narrows by footprint', () => {
		const names = top('Polar Lights 350').map((h) => h.name);

		expect(names).toContain('PL-L350CMY');
		expect(names).toContain('PL-L350B');
		const narrowed = top('Polar Lights 350', 22).map((h) => h.name);

		expect(narrowed[0]).toBe('PL-L350CMY');
		expect(narrowed).not.toContain('PL-L350B');
	});

	it('joins split words and knows manufacturer aliases', () => {
		expect(top('robe robin led beam 150 rgba')[0]?.file).toBe('robe@robin ledbeam 150 rgba.pxml');
		expect(top('American DJ Jolt Panel FX').map((h) => h.file)).toContain('adj@jolt panel fx.pxml');
	});

	it('skips MA3 set@ stage elements and unrelated queries', () => {
		expect(top('eurotruss')).toEqual([]);
		expect(top('Claypaky Sharpy')).toEqual([]);
	});
});
