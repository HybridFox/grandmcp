import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const GUIDE = `You are patching a grandMA3 show from a document (fixture report, equipment list, lighting plot, spreadsheet).

1. Read the document and build a table of fixture rows: manufacturer + model, DMX mode, quantity, DMX address
   ("universe.address", e.g. "1.23"; reports often drop the leading zeros), and any fixture number or name.
   Note the channel gaps between consecutive addresses: they tell you each mode's footprint and are a cross-check later.
2. Call grandmcp_status, then grandmcp_patch_list and grandmcp_fixture_types to see what the show already has.
3. For each fixture model that is not in the show, call grandmcp_fixture_library_search. The catalog covers the MA
   libraries, the user's files and the online GDTF Share. Documents often use marketing names ("LED 350W BSW Moving
   Head") where the catalog has model codes ("PL-L350CMY"), so search with manufacturer + model or model number
   ("Polar Lights 350") and pass footprint = the channel gap from step 1. Only "exact" hits are the same fixture; for
   anything else show the user the candidates with their modes and let them pick. If nothing fits, ask for a GDTF file
   in gma3_library/fixturetypes and search again with refresh.
4. Import the agreed types with grandmcp_fixture_type_import and check the modes it reports against the document:
   the footprint of the chosen mode must match the address gaps from step 1.
5. Fixture IDs: use the document's numbers if it has them. Otherwise propose a scheme (for example 101+ for the first
   model, 201+ for the next) and confirm it with the user. Fixtures without an address in the document get patch "none"
   unless the user wants them auto-patched.
6. Call grandmcp_patch_plan, show the user the full plan table and any warnings, and only call grandmcp_patch_apply
   after they agree. Afterwards, report the backup path and run grandmcp_patch_list to show the result.

Never invent DMX modes or addresses that are not in the document; ask instead.`;

export function registerPatchFromDocumentPrompt(server: McpServer): void {
	server.registerPrompt(
		'patch_from_document',
		{
			title: 'Patch from a document',
			description: 'Step-by-step guide for turning a fixture report, equipment list or plot into a grandMA3 patch.',
			argsSchema: z.object({ document: z.string().optional().describe('Path or name of the document to patch from.') }),
		},
		({ document }) => ({
			messages: [
				{
					role: 'user' as const,
					content: { type: 'text' as const, text: document ? `${GUIDE}\n\nThe document: ${document}` : GUIDE },
				},
			],
		}),
	);
}
