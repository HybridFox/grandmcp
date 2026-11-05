import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HTMLElement, type Node, NodeType, parse } from 'node-html-parser';
import * as z from 'zod/v4';

import type { AppContext } from '../context.ts';

import { fromError, ok } from './result.ts';

export interface ManualPage {
	page: string;
	title: string;
	section: string;
	text: string;
}

export interface ManualHit {
	page: string;
	title: string;
	section: string;
	snippet: string;
	score: number;
}

/** MALightingTechnology base folder that holds the versioned gma3_* installs. */
function defaultMaBase(): string {
	if (process.platform === 'win32') {
		return 'C:\\ProgramData\\MALightingTechnology';
	}

	return path.join(os.homedir(), 'MALightingTechnology');
}

function compareVersions(a: string, b: string): number {
	const pa = a.split('.').map(Number);
	const pb = b.split('.').map(Number);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const diff = (pa[i] ?? 0) - (pb[i] ?? 0);

		if (diff !== 0) {
			return diff;
		}
	}

	return 0;
}

/** GMA3_MANUAL_DIR, else shared/language/HTML of the highest installed gma3_<version>. */
export function resolveManualDir(env: NodeJS.ProcessEnv = process.env, base: string = defaultMaBase()): string | undefined {
	if (env.GMA3_MANUAL_DIR) {
		return env.GMA3_MANUAL_DIR;
	}

	let entries: string[];
	try {
		entries = fs.readdirSync(base);
	} catch {
		return undefined;
	}
	const versions = entries
		.map((name) => /^gma3_(\d+(?:\.\d+)*)$/.exec(name))
		.filter((match): match is RegExpExecArray => match !== null)
		.sort((a, b) => compareVersions(b[1] ?? '', a[1] ?? ''));
	for (const match of versions) {
		const dir = path.join(base, match[0], 'shared', 'language', 'HTML');

		if (fs.existsSync(dir)) {
			return dir;
		}
	}

	return undefined;
}

// ---------------------------------------------------------------------------
// HTML → text
// ---------------------------------------------------------------------------

const SKIP_TAGS = new Set(['script', 'style', 'img', 'button', 'noscript', 'svg']);
const BLOCK_TAGS = new Set(['p', 'div', 'figure', 'figcaption', 'section', 'article', 'main', 'blockquote', 'ul', 'ol', 'dl', 'dt', 'dd', 'tbody', 'thead']);
const CODE_MARK = '\u0000';

function inlineText(text: string): string {
	return text.replace(/\s+/g, ' ');
}

class TextBuilder {
	private out = '';
	readonly code: string[] = [];

	push(text: string): void {
		this.out += text;
	}

	block(): void {
		this.out += '\n\n';
	}

	line(): void {
		this.out += '\n';
	}

	addCode(code: string, lang: string): void {
		this.code.push('```' + lang.toLowerCase() + '\n' + code.replace(/^\n+|\s+$/g, '') + '\n```');
		this.out += `\n\n${CODE_MARK}${this.code.length - 1}${CODE_MARK}\n\n`;
	}

	result(): string {
		const normalised = this.out
			.replace(/\u00a0/g, ' ')
			.split('\n')
			.map((line) => line.replace(/[ \t]+/g, ' ').trim())
			.join('\n')
			.replace(/\n{3,}/g, '\n\n')
			.trim();

		return normalised.replace(new RegExp(`${CODE_MARK}(\\d+)${CODE_MARK}`, 'g'), (_, index: string) => this.code[Number(index)] ?? '');
	}
}

function walk(node: Node, out: TextBuilder, listDepth: number): void {
	if (node.nodeType === NodeType.TEXT_NODE) {
		out.push(inlineText(node.text));

		return;
	}

	if (!(node instanceof HTMLElement)) {
		return;
	}

	const tag = node.tagName?.toLowerCase() ?? '';

	if (SKIP_TAGS.has(tag)) {
		return;
	}

	const classes = node.classList;

	if (tag === 'table' && classes.contains('CHCodeSample_container')) {
		const code = node.querySelector('td.CHCodeSample_code');
		const lang = node.querySelector('.CHCodeSample_langName')?.text.trim() ?? '';

		if (code) {
			out.addCode(code.text, lang);
		}

		return;
	}

	if (tag === 'table' && classes.contains('maInputBox')) {
		const cell = node.querySelector('td.maInputBoxTextCell');
		const raw = inlineText(cell?.text ?? '').trim();
		// Drop the "User name[Fixture]>" prompt so only the typed command remains.
		const command = raw.replace(/^.*?\]\s*>\s*/, '');

		if (command) {
			out.block();
			out.push(`Command line: ${command}`);
			out.block();
		}

		return;
	}

	// The breadcrumb table is extracted separately as the section.
	if (tag === 'table' && classes.contains('FlatTable')) {
		return;
	}

	if (tag === 'pre') {
		out.addCode(node.text, '');

		return;
	}

	if (tag === 'tr') {
		const cells = node.childNodes
			.filter((child): child is HTMLElement => child instanceof HTMLElement && ['td', 'th'].includes(child.tagName.toLowerCase()))
			.map((cell) => {
				const nested = new TextBuilder();
				for (const child of cell.childNodes) {
					walk(child, nested, listDepth);
				}

				return nested.result().replace(/\n+/g, ' ');
			});
		out.line();
		out.push(cells.join(' | '));
		out.line();

		return;
	}

	if (/^h[1-6]$/.test(tag)) {
		const text = inlineText(node.text).trim();

		if (text) {
			out.block();
			out.push(`${'#'.repeat(Number(tag[1]))} ${text}`);
			out.block();
		}

		return;
	}

	if (tag === 'br') {
		out.line();

		return;
	}

	if (tag === 'li') {
		out.line();
		out.push(`${'  '.repeat(Math.max(0, listDepth - 1))}- `);
		for (const child of node.childNodes) {
			walk(child, out, listDepth);
		}

		return;
	}

	const isList = tag === 'ul' || tag === 'ol';
	const isBlock = BLOCK_TAGS.has(tag) || tag === 'table';

	if (isBlock) {
		out.block();
	}

	for (const child of node.childNodes) {
		walk(child, out, isList ? listDepth + 1 : listDepth);
	}

	if (isBlock) {
		out.block();
	}
}

function sliceBetween(html: string, start: string, end: string): string | undefined {
	const from = html.indexOf(start);

	if (from < 0) {
		return undefined;
	}

	const to = html.indexOf(end, from);

	return html.slice(from, to < 0 ? undefined : to);
}

function decodeEntities(text: string): string {
	return parse(`<b>${text}</b>`).text;
}

/** Title, breadcrumb section and readable text of one manual page. */
export function extractPage(page: string, html: string): ManualPage {
	const titleMatch = /<title>([\s\S]*?)<\/title>/i.exec(html) ?? /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
	const title = decodeEntities(inlineText(titleMatch?.[1] ?? '').trim()) || page;

	const content = sliceBetween(html, '<div id="offline-content">', '<div id="offline-subtopics">') ?? sliceBetween(html, '<body', '</body>') ?? html;
	const root = parse(content, { blockTextElements: { script: true, style: true, noscript: true } });

	const crumbs = root
		.querySelectorAll('.CHBreadcrumb_item')
		.map((item) => inlineText(item.text).trim())
		.filter(Boolean);
	const section = crumbs.slice(1, -1).join(' » ');

	const out = new TextBuilder();
	walk(root, out, 0);
	const text = out
		.result()
		.replace(/^grandMA3 User Manual Publication\s*/, '')
		.replace(/^Version \d+(\.\d+)*\s*/m, '');

	return { page, title, section, text };
}

// ---------------------------------------------------------------------------
// Index and search
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
	'the',
	'a',
	'an',
	'to',
	'of',
	'in',
	'how',
	'do',
	'i',
	'is',
	'for',
	'and',
	'with',
	'on',
	'what',
	'can',
	'my',
	'it',
	'or',
	'by',
	'from',
]);

function tokenize(query: string): string[] {
	return [
		...new Set(
			query
				.toLowerCase()
				.split(/[^a-z0-9]+/)
				.filter((token) => token.length > 0 && !STOP_WORDS.has(token)),
		),
	];
}

function countOccurrences(haystack: string, needle: string, cap = 50): number {
	let count = 0;
	let index = haystack.indexOf(needle);
	while (index >= 0 && count < cap) {
		count++;
		index = haystack.indexOf(needle, index + needle.length);
	}

	return count;
}

function wordMatch(haystack: string, token: string): boolean {
	return new RegExp(`(^|[^a-z0-9])${token}([^a-z0-9]|$)`).test(haystack);
}

interface IndexedPage extends ManualPage {
	lowerTitle: string;
	lowerText: string;
}

export class ManualIndex {
	readonly dir: string;
	private readonly pages: IndexedPage[];

	constructor(dir: string, pages: ManualPage[]) {
		this.dir = dir;
		this.pages = pages.map((page) => ({ ...page, lowerTitle: page.title.toLowerCase(), lowerText: page.text.toLowerCase() }));
	}

	get size(): number {
		return this.pages.length;
	}

	search(query: string, limit = 8): ManualHit[] {
		const tokens = tokenize(query);

		if (tokens.length === 0) {
			return [];
		}

		const phrase = query.toLowerCase().replace(/\s+/g, ' ').trim();
		const rawWords = query.split(/\s+/).filter(Boolean);
		// CamelCase words (AddFixtures, ChangeDestination) are Lua functions or keywords; a lone capitalised word is likely a keyword.
		const looksCamel = rawWords.some((word) => /^[A-Z][a-z]+[A-Z]\w*/.test(word) || word.includes('('));
		const looksKeyword = looksCamel || (rawWords.length === 1 && /^[A-Z]/.test(rawWords[0] ?? '')) || /\b(keyword|syntax|command)\b/i.test(query);

		const hits: ManualHit[] = [];
		for (const page of this.pages) {
			let score = 0;
			let matched = 0;
			for (const token of tokens) {
				let tokenScore = 0;

				if (page.lowerTitle.includes(token)) {
					tokenScore += wordMatch(page.lowerTitle, token) ? 15 : 10;
				}

				if (page.page.includes(token)) {
					tokenScore += 6;
				}

				const count = countOccurrences(page.lowerText, token);

				if (count > 0) {
					tokenScore += 2 * Math.log2(1 + count);
				}

				if (tokenScore > 0) {
					matched++;
					score += tokenScore;
				}

				if (page.page === `keyword_${token}` || page.page === `lua_objectfree_${token}` || page.page === `lua_object_${token}`) {
					score += 40;
				}
			}

			if (matched === 0) {
				continue;
			}

			// Pages missing some query terms fall back sharply.
			score *= (matched / tokens.length) ** 2;

			if (tokens.length > 1) {
				if (page.lowerTitle.includes(phrase)) {
					score += 20;
				} else if (page.lowerText.includes(phrase)) {
					score += 8;
				}
			}

			if (looksCamel && page.page.startsWith('lua_')) {
				score *= 1.4;
			}

			if (looksKeyword && page.page.startsWith('keyword_')) {
				score *= 1.4;
			}

			hits.push({ page: page.page, title: page.title, section: page.section, snippet: '', score });
		}

		hits.sort((a, b) => b.score - a.score);
		const top = hits.slice(0, limit);
		for (const hit of top) {
			const page = this.pages.find((candidate) => candidate.page === hit.page);
			hit.snippet = page ? makeSnippet(page, phrase, tokens) : '';
			hit.score = Math.round(hit.score * 10) / 10;
		}

		return top;
	}
}

function makeSnippet(page: IndexedPage, phrase: string, tokens: string[], width = 200): string {
	let at = page.lowerText.indexOf(phrase);

	if (at < 0) {
		for (const token of [...tokens].sort((a, b) => b.length - a.length)) {
			at = page.lowerText.indexOf(token);

			if (at >= 0) {
				break;
			}
		}
	}

	if (at < 0) {
		at = 0;
	}

	const start = Math.max(0, at - Math.floor(width / 3));
	const end = Math.min(page.text.length, start + width);
	const body = inlineText(page.text.slice(start, end)).trim();

	return `${start > 0 ? '…' : ''}${body}${end < page.text.length ? '…' : ''}`;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await fn(items[index] as T);
		}
	});
	await Promise.all(workers);

	return results;
}

/** Reads and indexes every .html page in `dir`. */
export async function buildManualIndex(dir: string): Promise<ManualIndex> {
	const files = (await fs.promises.readdir(dir)).filter((file) => file.toLowerCase().endsWith('.html'));
	const pages = await mapLimit(files, 64, async (file) =>
		extractPage(file.slice(0, -'.html'.length), await fs.promises.readFile(path.join(dir, file), 'utf8')),
	);

	return new ManualIndex(dir, pages);
}

const indexes = new Map<string, Promise<ManualIndex>>();

function getIndex(dir: string): Promise<ManualIndex> {
	let index = indexes.get(dir);

	if (!index) {
		index = buildManualIndex(dir);
		index.catch(() => indexes.delete(dir));
		indexes.set(dir, index);
	}

	return index;
}

/** Plain text of one page, truncated to `maxChars`. */
export async function readManualPage(dir: string, page: string, maxChars = 12000): Promise<string> {
	const name = page.replace(/\.html$/i, '');

	if (!/^[A-Za-z0-9_.-]+$/.test(name) || name.includes('..')) {
		throw new Error(`invalid page name '${page}': pass a page name from grandmcp_manual_search, e.g. 'keyword_patch'`);
	}

	const file = path.join(dir, `${name}.html`);

	if (!fs.existsSync(file)) {
		throw new Error(`manual page '${name}' not found; use grandmcp_manual_search to find page names`);
	}

	const { title, section, text } = extractPage(name, await fs.promises.readFile(file, 'utf8'));
	const header = `# ${title}\n${section ? `Section: ${section}\n` : ''}Page: ${name}\n\n`;

	if (text.length <= maxChars) {
		return header + text;
	}

	return `${header}${text.slice(0, maxChars)}\n\n[truncated: showing ${maxChars} of ${text.length} characters; call again with a larger maxChars to read more]`;
}

function manualDirOrThrow(): string {
	const dir = resolveManualDir();

	if (!dir || !fs.existsSync(dir)) {
		throw new Error(
			'grandMA3 manual not found. It ships with onPC under MALightingTechnology/gma3_<version>/shared/language/HTML; set GMA3_MANUAL_DIR to point at it.',
		);
	}

	return dir;
}

export function registerManualTools(server: McpServer, _ctx: AppContext): void {
	server.registerTool(
		'grandmcp_manual_search',
		{
			title: 'Search the grandMA3 manual',
			description:
				'Full-text search over the grandMA3 user manual installed with onPC (same version as the console software). ' +
				'Use it to look up exact command-line keyword syntax and Lua API functions instead of guessing; then read the page with grandmcp_manual_read. ' +
				"Tips: search a keyword or Lua function by name ('Patch', 'AddFixtures', 'ChangeDestination') or describe the task ('patch fixture address').",
			inputSchema: z.object({
				query: z.string().min(1).describe('Keyword, Lua function name, or a short description of what you want to do'),
				limit: z.number().int().min(1).max(25).optional().describe('Maximum number of pages to return (default 8)'),
			}),
			annotations: { readOnlyHint: true, idempotentHint: true },
		},
		async ({ query, limit }) => {
			try {
				const index = await getIndex(manualDirOrThrow());
				const hits = index.search(query, limit ?? 8);

				return ok(hits, hits.length ? `${hits.length} page(s) for '${query}'` : `no manual pages match '${query}'`);
			} catch (error) {
				return fromError(error);
			}
		},
	);

	server.registerTool(
		'grandmcp_manual_read',
		{
			title: 'Read a grandMA3 manual page',
			description:
				'Read one page of the installed grandMA3 manual as plain text, with syntax lines, command-line examples and Lua code samples. ' +
				'Pass a page name returned by grandmcp_manual_search (e.g. keyword_patch, lua_objectfree_addfixtures). Prefer this over guessing syntax.',
			inputSchema: z.object({
				page: z.string().min(1).describe("Page name without .html, e.g. 'keyword_patch'"),
				maxChars: z.number().int().min(500).max(200000).optional().describe('Truncate the text after this many characters (default 12000)'),
			}),
			annotations: { readOnlyHint: true, idempotentHint: true },
		},
		async ({ page, maxChars }): Promise<CallToolResult> => {
			try {
				const text = await readManualPage(manualDirOrThrow(), page, maxChars ?? 12000);

				return { content: [{ type: 'text', text }] };
			} catch (error) {
				return fromError(error);
			}
		},
	);
}
