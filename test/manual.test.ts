import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildManualIndex, extractPage, type ManualIndex, readManualPage, resolveManualDir } from '../src/tools/manual.ts';

function page(title: string, crumbs: string[], body: string): string {
	const breadcrumb = crumbs.map((crumb) => `<span class="CHBreadcrumb_item"><a href="x.html">${crumb}</a></span>`).join('<span> » </span>');

	return `<!DOCTYPE html><html><head><script>var x = 1;</script><title>${title}</title></head><body>
<nav>grandMA3 User Manual Publication navigation noise</nav>
<div id="offline-content"><table class="FlatTable"><tr><td><span class="CHBreadcrumb">${breadcrumb}</span></td><td>Version 2.5</td></tr></table>
${body}
</div>
<div id="offline-subtopics"><ul></ul></div>
</body></html>`;
}

const PAGES: Record<string, string> = {
	keyword_patch: page(
		'Patch Keyword',
		['grandMA3 User Manual', 'Command Syntax and Keywords', 'General Keywords', 'Patch'],
		`<p>The Patch keyword is used to edit the patch address of single fixtures.</p>
<h2>Syntax<a class="CHHeadingLink"></a></h2>
<p><strong>Patch Fixture [Fixture_Number] [Universe.Address]</strong></p>
<ul><li>Type <strong>Patch</strong></li><li>Type the shortcut <strong>Pat</strong></li></ul>
<table class="maInputBox"><tr><td class="maInputBoxImageCell"><img src="x.png"/></td><td class="maInputBoxTextCell">User name<span>[Fixture]</span>&gt;<span>Patch Fixture 2 3.123</span></td></tr></table>`,
	),
	lua_objectfree_addfixtures: page(
		'AddFixtures(table)',
		['grandMA3 User Manual', 'Plugins', 'Lua Functions - Object-Free API', 'AddFixtures'],
		`<p>The AddFixtures Lua function adds fixtures to the patch.</p>
<table class="CHCodeSample_container"><tr><td class="CHCodeSample_header"><div class="CHCodeSample_langName">Lua</div></td></tr>
<tr><td class="CHCodeSample_code"><pre><pre><span>local</span> t = {}
    t.fid = &quot;301&quot;
AddFixtures(t)</pre></pre></td></tr></table>`,
	),
	patch_add_fixtures: page(
		'Add Fixtures to the Show',
		['grandMA3 User Manual', 'Patch and Fixture Setup', 'Add Fixtures'],
		'<p>Open the patch menu to add fixtures. Every fixture needs a fixture type and a DMX address.</p>',
	),
	osc: page('OSC', ['grandMA3 User Manual', 'Remote In and Out', 'OSC'], '<p>Receive Command must be enabled for OSC command input.</p>'),
};

let dir: string;
let index: ManualIndex;

beforeAll(async () => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grandmcp-manual-'));
	for (const [name, html] of Object.entries(PAGES)) {
		fs.writeFileSync(path.join(dir, `${name}.html`), html);
	}
	fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a page');
	index = await buildManualIndex(dir);
});

afterAll(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('extractPage', () => {
	it('keeps title, section, syntax, list bullets, command lines and code', () => {
		const result = extractPage('keyword_patch', PAGES.keyword_patch ?? '');
		expect(result.title).toBe('Patch Keyword');
		expect(result.section).toBe('Command Syntax and Keywords » General Keywords');
		expect(result.text).toContain('## Syntax');
		expect(result.text).toContain('Patch Fixture [Fixture_Number] [Universe.Address]');
		expect(result.text).toContain('- Type Patch\n- Type the shortcut Pat');
		expect(result.text).toContain('Command line: Patch Fixture 2 3.123');
		expect(result.text).not.toContain('navigation noise');
		expect(result.text).not.toContain('Version 2.5');

		const lua = extractPage('lua_objectfree_addfixtures', PAGES.lua_objectfree_addfixtures ?? '');
		expect(lua.text).toContain('```lua\nlocal t = {}\n    t.fid = "301"\nAddFixtures(t)\n```');
	});
});

describe('ManualIndex.search', () => {
	it('indexes only .html files', () => {
		expect(index.size).toBe(4);
	});

	it('finds a Lua function by name first', () => {
		const [top] = index.search('AddFixtures', 3);
		expect(top?.page).toBe('lua_objectfree_addfixtures');
		expect(top?.snippet).toContain('AddFixtures');
	});

	it('ranks the keyword page first for a task description', () => {
		const hits = index.search('patch fixture address');
		expect(hits[0]?.page).toBe('keyword_patch');
		expect(hits.map((hit) => hit.page)).toContain('patch_add_fixtures');
	});

	it('respects the limit and returns nothing for stop words only', () => {
		expect(index.search('fixture', 1)).toHaveLength(1);
		expect(index.search('the a of')).toEqual([]);
		expect(index.search('zzzz-no-match')).toEqual([]);
	});
});

describe('readManualPage', () => {
	it('returns a header and the page text', async () => {
		const text = await readManualPage(dir, 'keyword_patch');
		expect(text.startsWith('# Patch Keyword\nSection: Command Syntax and Keywords » General Keywords\nPage: keyword_patch\n\n')).toBe(true);
	});

	it('accepts a trailing .html and truncates with a note', async () => {
		const text = await readManualPage(dir, 'keyword_patch.html', 60);
		expect(text).toContain('[truncated:');
	});

	it('rejects paths and unknown pages', async () => {
		await expect(readManualPage(dir, '../secret')).rejects.toThrow(/invalid page name/);
		await expect(readManualPage(dir, 'sub/page')).rejects.toThrow(/invalid page name/);
		await expect(readManualPage(dir, 'missing_page')).rejects.toThrow(/not found/);
	});
});

describe('resolveManualDir', () => {
	it('prefers GMA3_MANUAL_DIR', () => {
		expect(resolveManualDir({ GMA3_MANUAL_DIR: '/custom' }, '/nowhere')).toBe('/custom');
	});

	it('picks the highest installed version that has a manual', () => {
		const base = fs.mkdtempSync(path.join(os.tmpdir(), 'grandmcp-ma-'));
		try {
			for (const name of ['gma3_2.4.1', 'gma3_2.10.0', 'gma3_library', 'gma3_software_update']) {
				fs.mkdirSync(path.join(base, name, 'shared', 'language', 'HTML'), { recursive: true });
			}
			fs.mkdirSync(path.join(base, 'gma3_3.0.0'));
			expect(resolveManualDir({}, base)).toBe(path.join(base, 'gma3_2.10.0', 'shared', 'language', 'HTML'));
			expect(resolveManualDir({}, path.join(base, 'missing'))).toBeUndefined();
		} finally {
			fs.rmSync(base, { recursive: true, force: true });
		}
	});
});
