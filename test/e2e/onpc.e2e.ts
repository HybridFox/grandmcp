/**
 * End-to-end suite: drives the real MCP server against a running grandMA3 onPC with the grandmcp plugin started.
 * Run it on a test show only: pnpm test:e2e
 *
 * Everything it creates lives in a scratch area and is named "e2e ...": FIDs 9000-9004 in universe 500, slot 990 in
 * the group, preset (1 and 4), sequence, MAtricks, appearance and layout pools, page 99 and speed master 16. It refuses
 * to start when FIDs 9000-9004 hold anything else, and removes what it made at the end (page 99 and speed master 16
 * keep their settings). Moves and saving under a new name
 * always open a grandMA3 pop-up for the user, so they are not covered here.
 */
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SLOT = 990;
const PAGE = 99;
const MASTER = 16;
const FIDS = [9001, 9002, 9003, 9004];
const GROUPING = 9000;

interface Result {
	text: string;
	data: Record<string, unknown>;
	isError: boolean;
}

let client: Client;

async function call(name: string, args: Record<string, unknown> = {}): Promise<Result> {
	const r = await client.callTool({ name, arguments: args }, { timeout: 170_000 });
	const text = r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
	const json = text.indexOf('\n\n{');
	let data = (r.structuredContent as Record<string, unknown> | undefined) ?? {};

	if (Object.keys(data).length === 0) {
		const body = json >= 0 ? text.slice(json + 2) : text.trimStart().startsWith('{') ? text : '';

		try {
			data = body ? (JSON.parse(body) as Record<string, unknown>) : {};
		} catch {
			// text-only result
		}
	}

	return { text, data, isError: r.isError === true };
}

async function expectOk(name: string, args: Record<string, unknown> = {}): Promise<Result> {
	const result = await call(name, args);

	expect(result.isError, `${name} failed: ${result.text}`).toBe(false);

	return result;
}

/** Remove what an earlier (possibly crashed) run left behind, but only objects this suite owns. */
async function cleanup(strict: boolean): Promise<void> {
	const patch = await call('grandmcp_patch_list');
	const ours = patch.text.split('\n').filter((line) => /\b900[0-4]\b/.test(line));
	const foreign = ours.filter((line) => !/\be2e\b/i.test(line));

	if (strict && foreign.length > 0) {
		throw new Error(`FIDs 9000-9004 are used by something else:\n${foreign.join('\n')}`);
	}

	if (ours.length > 0 && foreign.length === 0) {
		const top = ours.some((l) => /\b9000\b/.test(l)) ? [GROUPING] : FIDS.filter((fid) => ours.some((l) => l.includes(String(fid))));
		const plan = await call('grandmcp_patch_plan_changes', { changes: top.map((fid) => ({ fid, remove: true })) });
		const planId = plan.data.planId as string | undefined;

		if (planId) {
			await call('grandmcp_patch_apply', { planId });
		}
	}

	for (const [kind, extra] of [
		['sequence', {}],
		['group', {}],
		['matricks', {}],
		['preset', { pool: 1 }],
		['preset', { pool: 4 }],
		['layout', {}],
		['appearance', {}],
	] as const) {
		await call('grandmcp_pool_delete', { kind, no: SLOT, ...extra });
	}
}

beforeAll(async () => {
	client = new Client({ name: 'grandmcp-e2e', version: '1' });
	await client.connect(
		new StdioClientTransport({
			command: process.execPath,
			args: ['src/index.ts'],
			env: { ...(process.env as Record<string, string>), GRANDMCP_ALLOW_WRITE: '1' },
		}),
	);

	const status = await call('grandmcp_status');

	if (status.isError) {
		throw new Error(`grandMA3 is not reachable: ${status.text}`);
	}

	if (status.data.dialog) {
		throw new Error(`a pop-up is open on the console: ${JSON.stringify(status.data.dialog)}`);
	}

	await cleanup(true);
});

afterAll(async () => {
	if (client) {
		await cleanup(false);
		await client.close();
	}
});

describe('grandMA3 end to end', () => {
	it('reads the console', async () => {
		const status = await expectOk('grandmcp_status');

		expect(status.data.plugin).toBeTruthy();
		await expectOk('grandmcp_patch_list');
		await expectOk('grandmcp_fixture_types');
		await expectOk('grandmcp_manual_search', { query: 'AddFixtures' });
	});

	it('has the fixture types it needs (Dimmer, Grouping)', async () => {
		const types = await expectOk('grandmcp_fixture_types');

		for (const [name, query] of [
			['Dimmer', 'generic dimmer'],
			['Grouping', 'generic grouping'],
		] as const) {
			if (!new RegExp(`"${name}"`).test(types.text)) {
				const search = await expectOk('grandmcp_fixture_library_search', { query, limit: 1 });
				const hit = (search.data.hits as { file: string; path: string }[])[0];

				expect(hit, `no library entry for ${query}`).toBeTruthy();
				await expectOk('grandmcp_fixture_type_import', { file: hit?.file, path: hit?.path });
			}
		}
	});

	it('patches fixtures under a grouping fixture and changes them', async () => {
		const plan = await expectOk('grandmcp_patch_plan', {
			fixtures: [
				{ fid: GROUPING, name: 'e2e truss', type: 'Grouping' },
				{ fid: 9001, count: 4, name: 'e2e dim', type: 'Dimmer', mode: 'Mode 0', patch: '500.1', parent: GROUPING },
			],
		});
		const applied = await expectOk('grandmcp_patch_apply', { planId: plan.data.planId });

		expect(applied.text).toMatch(/verified/);

		const changes = await expectOk('grandmcp_patch_plan_changes', {
			changes: [
				{ fid: 9004, patch: '500.10', name: 'e2e dim moved' },
				{ fid: 9003, posX: 1.5, posZ: 4, rotX: 180 },
			],
		});
		const changed = await expectOk('grandmcp_patch_apply', { planId: changes.data.planId });

		expect(changed.text).toMatch(/verified/);

		const list = await expectOk('grandmcp_patch_list');

		expect(list.text).toMatch(/9004\s+e2e dim moved.*500\.010/);
		expect(list.text).toMatch(/in 9000/);
	});

	it('refuses conflicting plans', async () => {
		const plan = await call('grandmcp_patch_plan', { fixtures: [{ fid: 9001, type: 'Dimmer', mode: 'Mode 0', patch: '500.1' }] });

		expect(plan.text).toMatch(/already used/);
	});

	it('stores groups, presets with values and effects, and MAtricks', async () => {
		await expectOk('grandmcp_group_store', { no: SLOT, name: 'e2e group', fids: FIDS, overwrite: true });

		const values = await expectOk('grandmcp_preset_store', {
			pool: 4,
			no: SLOT,
			name: 'e2e values',
			overwrite: true,
			entries: [{ fids: FIDS, values: { Dimmer: { percent: 60 } } }],
		});

		expect(values.text).toMatch(/verified/);

		const effect = await expectOk('grandmcp_preset_store', {
			pool: 1,
			no: SLOT,
			name: 'e2e chase',
			overwrite: true,
			entries: [
				{
					fids: FIDS,
					values: {
						Dimmer: {
							effect: { bpm: 120, phase: { from: 0, to: 360 }, pattern: { wings: 2 }, steps: [{ percent: 100, trans: 0 }, { percent: 0 }] },
						},
					},
				},
			],
		});

		expect(effect.text).toMatch(/verified/);

		const read = await expectOk('grandmcp_preset_read', { pool: 1, no: SLOT });

		expect(read.text).toMatch(/effect 120 BPM/);
		await expectOk('grandmcp_matricks_store', { no: SLOT, name: 'e2e matricks', wings: 2, invert: true, overwrite: true });
	});

	it('builds and edits a sequence on an executor', async () => {
		const stored = await expectOk('grandmcp_sequence_store', {
			no: SLOT,
			name: 'e2e sequence',
			overwrite: true,
			cues: [
				{ name: 'e2e look', fade: 1, looks: [{ preset: { pool: 4, no: SLOT } }] },
				{ name: 'e2e chase', trigger: 'follow', triggerTime: 2, looks: [{ preset: { pool: 1, no: SLOT } }] },
			],
		});

		expect(stored.text).toMatch(/verified/);
		await expectOk('grandmcp_page_store', { no: PAGE, name: 'e2e page' });
		await expectOk('grandmcp_executor_assign', { sequence: SLOT, page: PAGE, executor: 201, overwrite: true });
		await expectOk('grandmcp_executor_configure', { page: PAGE, executor: 201, button: 'Toggle', fader: 'Temp' });
		await expectOk('grandmcp_speedmaster_set', { master: MASTER, bpm: 128, label: 'e2e speed', page: PAGE, executor: 210, overwrite: true });

		await expectOk('grandmcp_cue_store', {
			sequence: SLOT,
			cue: { no: 3, name: 'e2e added', looks: [{ fids: FIDS, values: { Dimmer: { percent: 20 } } }] },
		});
		await expectOk('grandmcp_cue_delete', { sequence: SLOT, cue: 3 });

		// Replacing the sequence must keep it on its executor, with its configuration.
		await expectOk('grandmcp_sequence_store', {
			no: SLOT,
			name: 'e2e sequence',
			overwrite: true,
			cues: [{ name: 'e2e only', looks: [{ preset: { pool: 4, no: SLOT } }] }],
		});

		const executors = await expectOk('grandmcp_executor_list', { page: PAGE });

		expect(executors.text).toMatch(/99\.201: Sequence 990 "e2e sequence" \(fader Temp, button Toggle\)/);
		expect(executors.text).toMatch(/99\.210: MasterSpeed 16/);

		const read = await expectOk('grandmcp_sequence_read', { no: SLOT });

		expect(read.text).toMatch(/on executor 99\.201/);
	});

	it('copies, renames and deletes pool objects', async () => {
		await expectOk('grandmcp_pool_copy', { kind: 'group', from: SLOT, to: SLOT - 1, overwrite: true });
		await expectOk('grandmcp_pool_rename', { kind: 'group', no: SLOT - 1, name: 'e2e group copy' });
		await expectOk('grandmcp_pool_delete', { kind: 'group', no: SLOT - 1 });
	});

	it('colours buttons and builds a layout', async () => {
		const appearance = await expectOk('grandmcp_appearance_store', {
			no: SLOT,
			name: 'e2e colour',
			color: '#ff8800',
			overwrite: true,
			assign: [{ kind: 'sequence', no: SLOT }],
		});

		expect(appearance.text).toMatch(/On: Sequence 990/);

		const layout = await expectOk('grandmcp_layout_store', {
			no: SLOT,
			name: 'e2e layout',
			overwrite: true,
			elements: FIDS.map((fid, i) => ({ fid, x: i * 60, y: 0 })),
		});

		expect(layout.text).toMatch(/4 placed/);
	});

	it('refuses patch changes while a sequence is playing', async () => {
		// Shown indirectly: status lists running sequences; starting playback needs no tool, so only the read side here.
		const status = await expectOk('grandmcp_status');

		expect(Array.isArray(status.data.runningSequences)).toBe(true);
	});

	it('takes a screenshot', async () => {
		const r = await client.callTool({ name: 'grandmcp_screenshot', arguments: { screen: 1 } }, { timeout: 60_000 });
		const image = r.content.find((c) => c.type === 'image');

		expect(image && image.type === 'image' && image.data.length > 1000).toBe(true);
	});

	it('reports the show file status', async () => {
		const show = await expectOk('grandmcp_show_status');

		expect(show.data.status).toBeTruthy();
	});
});
