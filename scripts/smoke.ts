// End-to-end check through a real MCP client against a running onPC with the plugin started.
//   pnpm smoke            read-only: status, tool list, patch, types, library search, manual search
//   pnpm smoke --write [--fid 301]   also imports a fixture type and patches 3 fixtures from that FID on
//                                    universe 3. Use an empty test show only.
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const write = process.argv.includes('--write');
const fidArg = process.argv.indexOf('--fid');
const fid = fidArg > 0 ? Number(process.argv[fidArg + 1]) : 301;
const client = new Client({ name: 'grandmcp-smoke', version: '0.1.0' });
await client.connect(
	new StdioClientTransport({
		command: process.execPath,
		args: ['src/index.ts'],
		env: { ...(process.env as Record<string, string>), GRANDMCP_ALLOW_WRITE: write ? '1' : '0' },
	}),
);

async function call(name: string, args: Record<string, unknown> = {}) {
	const result = await client.callTool({ name, arguments: args });
	const text = result.content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
	console.info(`\n### ${name} ${JSON.stringify(args)}${result.isError ? '  (isError)' : ''}\n${text.slice(0, 2500)}`);

	return result;
}

const { tools } = await client.listTools();
console.info(`tools: ${tools.map((t) => t.name).join(', ')}`);
const { prompts } = await client.listPrompts();
console.info(`prompts: ${prompts.map((p) => p.name).join(', ')}`);

await call('grandmcp_status');
await call('grandmcp_patch_list');
await call('grandmcp_fixture_types');
await call('grandmcp_fixture_library_search', { query: 'Robe Robin LEDBeam 150 RGBA', limit: 3 });
await call('grandmcp_fixture_library_search', { query: 'Polar Lights 350', footprint: 22, limit: 5 });
await call('grandmcp_manual_search', { query: 'AddFixtures', limit: 2 });

if (write) {
	const typeName = 'Robin LEDBeam 150 RGBA';
	const types = await call('grandmcp_fixture_types');
	const hasType = types.content.some((c) => c.type === 'text' && c.text.includes(`"${typeName}"`));

	if (!hasType) {
		await call('grandmcp_fixture_type_import', { file: 'robe@robin ledbeam 150 rgba.pxml' });
	}

	const plan = await call('grandmcp_patch_plan', { fixtures: [{ fid, count: 3, name: 'Beam', type: typeName, mode: 'Mode 1', patch: 'auto', universe: 3 }] });
	const planId = (plan.structuredContent as { planId?: string } | undefined)?.planId;

	if (planId) {
		await call('grandmcp_patch_apply', { planId });
		await call('grandmcp_patch_list');
		await call('grandmcp_patch_plan', { fixtures: [{ fid, count: 3, name: 'Beam', type: typeName, mode: 'Mode 1', patch: 'auto', universe: 3 }] });
	}
}

await client.close();
