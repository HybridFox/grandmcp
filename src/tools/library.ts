import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import type { FixtureType } from '../bridge/types.ts';
import type { AppContext } from '../context.ts';
import { searchLibrary } from '../patch/library.ts';

import { failure, fromError, ok, WRITES_DISABLED } from './result.ts';

export function describeTypes(types: FixtureType[]): string {
	if (types.length === 0) {
		return 'The show has no fixture types yet.';
	}

	return types.map((t) => `- "${t.name}" (${t.manufacturer ?? '?'}): ${t.modes.map((m) => `"${m.name}" ${m.footprint} ch`).join(', ')}`).join('\n');
}

export function registerLibraryTools(server: McpServer, ctx: AppContext): void {
	server.registerTool(
		'grandmcp_fixture_types',
		{
			title: 'Show fixture types',
			description:
				'List the fixture types already in the show with their DMX modes and footprints. Patch plans can only use these; import missing ones with grandmcp_fixture_type_import.',
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true, idempotentHint: true },
		},
		async () => {
			try {
				const types = await ctx.bridge.request<FixtureType[]>('patch.types');

				return ok(types, describeTypes(types));
			} catch (error) {
				return fromError(error);
			}
		},
	);

	server.registerTool(
		'grandmcp_fixture_library_search',
		{
			title: 'Search fixture library',
			description: [
				"Search grandMA3's fixture catalog: the MA3 and MA2 libraries, the user's own files (gma3_library/fixturetypes) and the online GDTF Share and MA Fixture Share (about 25,000 types).",
				'Search with manufacturer and model, e.g. "Robe Robin LEDBeam 150 RGBA". Marketing names from documents often differ from model codes, so also try shorter queries ("Polar Lights 350") and pass footprint = the channel count the document implies to narrow it down.',
				'Results list each entry\'s DMX modes. "exact" means every query word matched; anything else may be a different model or variant, so confirm with the user before importing.',
				'The first search of a session loads the catalog from the console, which takes about 20 seconds; it is then cached for 30 minutes (refresh reloads it).',
			].join(' '),
			inputSchema: z.object({
				query: z.string().min(2),
				footprint: z.number().int().min(1).max(512).optional().describe('Only types with a DMX mode of exactly this many channels.'),
				limit: z.number().int().min(1).max(25).default(8),
				refresh: z.boolean().default(false).describe('Reload the catalog from the console first, e.g. after the user added GDTF files.'),
			}),
			annotations: { readOnlyHint: true, idempotentHint: true },
		},
		async ({ query, footprint, limit, refresh }) => {
			try {
				if (refresh) {
					ctx.invalidateLibrary();
				}

				const hits = searchLibrary(await ctx.library(), query, { limit, footprint });

				if (hits.length === 0) {
					return ok(
						[],
						`No catalog match for "${query}"${footprint ? ` with a ${footprint}-channel mode` : ''}. Try a shorter query (manufacturer + model number), or ask the user for a GDTF file in gma3_library/fixturetypes.`,
					);
				}

				const lines = hits.map(
					(h) =>
						`${h.score.toFixed(2)} ${h.exact ? 'exact' : 'near '}  ${h.manufacturer ?? '?'} ${h.name}  [${h.source}]  modes: ${h.modes.map((m) => `${m.name.trim()} (${m.footprint ?? '?'} ch)`).join(', ')}\n      file: ${h.file}${h.path.startsWith('ws://') ? `  path: ${h.path}` : ''}`,
				);

				return { content: [{ type: 'text', text: lines.join('\n') }], structuredContent: { hits } };
			} catch (error) {
				return fromError(error);
			}
		},
	);

	server.registerTool(
		'grandmcp_fixture_type_import',
		{
			title: 'Import fixture type',
			description: [
				'Import a fixture type from the catalog into the show, using file (and path for Share entries) from grandmcp_fixture_library_search.',
				'GDTF/Fixture Share entries are downloaded first and also saved in gma3_library/fixturetypes. Returns the imported type with its real DMX modes: check the footprint against the document.',
				'Commits immediately (no undo) but only adds a type; existing fixtures are untouched.',
			].join(' '),
			inputSchema: z.object({
				file: z.string().min(1).describe('File name exactly as returned by the search.'),
				path: z.string().optional().describe('Path from the search result; required to pick the right Share entry ("ws://GDTFShare/id=...").'),
				duringPlayback: z
					.boolean()
					.default(false)
					.describe('Allow this while sequences are running. Only after the user explicitly agreed: it can change what the audience sees.'),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
		},
		async ({ file, path, duringPlayback }) => {
			if (!ctx.allowWrite) {
				return WRITES_DISABLED;
			}

			try {
				const entry = (await ctx.library()).find((e) => e.file === file && (path === undefined || e.path === path));

				if (!entry) {
					return failure(`"${file}" is not in the catalog. Use the file and path exactly as grandmcp_fixture_library_search returned them.`);
				}

				const types = await ctx.bridge.request<FixtureType[]>('patch.types');
				const existing = types.find((t) => t.name.toLowerCase() === entry.name.toLowerCase());

				if (existing) {
					return ok(
						existing,
						`The show already has a fixture type named "${existing.name}":\n${describeTypes([existing])}\nUse it, or rename it in the show before importing another version.`,
					);
				}

				const imported = await ctx.serialize(() =>
					ctx.bridge.request<FixtureType>('patch.importType', { file: entry.file, path: entry.path, duringPlayback }, 120_000),
				);

				return ok(imported, `Imported "${imported.name}":\n${describeTypes([imported])}`);
			} catch (error) {
				return fromError(error);
			}
		},
	);
}
