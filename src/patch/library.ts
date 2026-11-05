import type { LibraryEntry, LibrarySource } from '../bridge/types.ts';

export interface LibraryHit extends LibraryEntry {
	/** 0..1, how much of the query the entry covers. */
	score: number;
	/** Every query word matched a word of the entry exactly. */
	exact: boolean;
}

export interface LibrarySearchOptions {
	limit?: number;
	/** Only entries with a mode of exactly this many DMX channels (e.g. the address gap in a patch list). */
	footprint?: number;
}

/** Manufacturer spellings that mean the same company in fixture libraries. */
const ALIASES: Record<string, string[]> = {
	adj: ['american dj'],
	'american dj': ['adj'],
	'clay paky': ['claypaky'],
	claypaky: ['clay paky'],
	'chauvet dj': ['chauvet'],
	'chauvet professional': ['chauvet'],
	'robe lighting': ['robe'],
	'martin professional': ['martin'],
	'ayrton sas': ['ayrton'],
	'polar lights': ['polarlights'],
	polarlights: ['polar lights'],
};

/** Ties go to the user's own files first, then MA3, the GDTF Share, MA's Fixture Share and the older MA2 library. */
const SOURCE_ORDER: Record<LibrarySource, number> = { user: 0, grandma3: 1, 'gdtf-share': 2, 'fixture-share': 3, grandma2: 4 };

function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/\.(p?xml|gdtf)$/, '')
		.replace(/[@_\-.,/()+&'"°]+/g, ' ')
		.split(/\s+/)
		.filter(Boolean);
}

/** Words that describe the fixture: manufacturer and model. Share file names end in a revision ("@1_0_1"), which is noise. */
function entryWords(entry: LibraryEntry): string[] {
	const [fileMaker = '', fileModel = ''] = entry.file.replace(/\.(p?xml|gdtf)$/i, '').split('@');
	const words = new Set([...tokenize(entry.manufacturer ?? fileMaker), ...tokenize(fileModel || entry.name), ...tokenize(entry.name)]);

	return [...words];
}

const isNumber = (t: string) => /^\d+$/.test(t);
const digitRuns = (t: string): string[] => t.match(/\d+/g) ?? [];

/** How well one query word is covered by the candidate's words (adjacent words may join, e.g. "led beam" = "ledbeam"). */
function wordScore(word: string, candidate: string[]): { score: number; exact: boolean } {
	if (candidate.includes(word)) {
		return { score: 1, exact: true };
	}

	for (let i = 0; i + 1 < candidate.length; i++) {
		if (`${candidate[i]}${candidate[i + 1]}` === word) {
			return { score: 1, exact: true };
		}
	}

	let best = 0;
	const runs = digitRuns(word);
	for (const c of candidate) {
		// "350w" vs "l350cmy": same number inside a model code.
		if (runs.some((r) => r.length >= 2 && digitRuns(c).includes(r))) {
			best = Math.max(best, 0.75);
		}

		if (isNumber(word) || isNumber(c) || Math.min(c.length, word.length) < 2) {
			continue;
		}

		if (c.startsWith(word) || word.startsWith(c)) {
			best = Math.max(best, 0.5);
		}
	}

	return { score: best, exact: false };
}

/** Scores each query word; two query words that together form one candidate word ("led beam" vs "ledbeam") both match. */
function scoreWords(words: string[], candidate: string[]): { score: number; exact: boolean }[] {
	const scores: { score: number; exact: boolean }[] = [];
	for (let i = 0; i < words.length; i++) {
		const word = words[i] as string;
		const next = words[i + 1];

		if (next !== undefined && !candidate.includes(word) && candidate.includes(`${word}${next}`)) {
			scores.push({ score: 1, exact: true }, { score: 1, exact: true });
			i++;
			continue;
		}

		scores.push(wordScore(word, candidate));
	}

	return scores;
}

function expandQuery(query: string): string[][] {
	const lower = query.toLowerCase();
	const variants = [tokenize(query)];
	for (const [from, tos] of Object.entries(ALIASES)) {
		if (new RegExp(`(^|\\s)${from}(\\s|$)`).test(lower)) {
			for (const to of tos) {
				variants.push(tokenize(lower.replace(from, to)));
			}
		}
	}

	return variants.filter((v) => v.length > 0);
}

/**
 * Ranks catalog entries against a free-text fixture name such as "ADJ Jolt Panel FXIP". The score is the share of
 * query words found in the entry's manufacturer and model, lightly penalised for model words the query does not
 * mention, so the closest model wins over its variants ("ledbeam 150 rgba" over "ledbeam 150 fw rgba").
 */
export function searchLibrary(entries: LibraryEntry[], query: string, options: LibrarySearchOptions = {}): LibraryHit[] {
	const { limit = 10, footprint } = options;
	const variants = expandQuery(query);

	if (variants.length === 0) {
		return [];
	}

	const hits: LibraryHit[] = [];
	for (const entry of entries) {
		if (entry.source === 'grandma3' && entry.file.startsWith('set@')) {
			continue; // stage elements and trusses, not fixtures
		}

		if (footprint !== undefined && !entry.modes.some((m) => m.footprint === footprint)) {
			continue;
		}

		const candidate = entryWords(entry);
		let best = { score: 0, exact: false };
		for (const words of variants) {
			const scores = scoreWords(words, candidate);
			const covered = scores.reduce((sum, s) => sum + s.score, 0) / words.length;
			const queryWords = new Set([...words, ...words.slice(1).map((w, i) => `${words[i]}${w}`)]);
			const extra = candidate.filter((c) => !queryWords.has(c)).length;
			const score = Math.max(0, covered - extra * 0.03);

			if (score > best.score) {
				best = { score, exact: scores.every((s) => s.exact) };
			}
		}

		if (best.score >= 0.5) {
			hits.push({ ...entry, score: Math.round(best.score * 1000) / 1000, exact: best.exact });
		}
	}

	return hits.sort((a, b) => b.score - a.score || SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source] || a.file.localeCompare(b.file)).slice(0, limit);
}
