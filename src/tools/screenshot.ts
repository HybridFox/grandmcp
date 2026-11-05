import type { McpServer } from '@modelcontextprotocol/server';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import * as z from 'zod/v4';

import { config } from '../config.ts';
import type { AppContext } from '../context.ts';

import { fromError } from './result.ts';

const run = promisify(execFile);

/**
 * CoreGraphics window list via JXA: needs no Accessibility permission. All windows, not only the visible ones, so onPC
 * can be captured while it is behind other windows or on another Space. Returns onPC windows as { id, name }.
 */
const WINDOW_LIST_JXA = `ObjC.import("CoreGraphics");
const arr = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, 0));
const out = [];
for (let i = 0; i < arr.count; i++) {
	const w = arr.objectAtIndex(i);
	const owner = ObjC.unwrap(w.objectForKey("kCGWindowOwnerName")) || "";
	if (/grandMA3 onPC/i.test(owner) && ObjC.unwrap(w.objectForKey("kCGWindowLayer")) === 0) {
		out.push({ id: ObjC.unwrap(w.objectForKey("kCGWindowNumber")), name: ObjC.unwrap(w.objectForKey("kCGWindowName")) || "" });
	}
}
JSON.stringify(out);`;

/** Pick the onPC window for a grandMA3 screen ("Display 1 onPC ..."), or the only one there is. */
export function pickWindow(windows: { id: number; name: string }[], screen: number): { id: number; name: string } | undefined {
	return windows.find((w) => new RegExp(`^Display ${screen}\\b`).test(w.name)) ?? (windows.length === 1 ? windows[0] : undefined);
}

/** macOS capture of the onPC window, scaled to at most 1600 px. grandMA3's own capture crops on Retina screens. */
async function captureOnpcWindow(screen: number): Promise<Buffer> {
	const { stdout } = await run('osascript', ['-l', 'JavaScript', '-e', WINDOW_LIST_JXA]);
	const windows = JSON.parse(stdout.trim() || '[]') as { id: number; name: string }[];
	const window = pickWindow(windows, screen);

	if (!window) {
		throw new Error(`no onPC window for screen ${screen} (found: ${windows.map((w) => w.name || '(unnamed)').join(', ') || 'none'})`);
	}

	const dir = await mkdtemp(path.join(os.tmpdir(), 'grandmcp-'));
	const file = path.join(dir, 'screen.png');
	try {
		await run('screencapture', ['-x', '-o', '-l', String(window.id), file]);
		await run('sips', ['-Z', '1600', file]);

		return await readFile(file);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** grandMA3 exports images as base64 blocks that are each encoded on their own; join the bytes, not the strings. */
export function joinBlocks(blocks: string[]): Buffer {
	return Buffer.concat(blocks.map((b) => Buffer.from(b, 'base64')));
}

export function registerScreenshotTools(server: McpServer, ctx: AppContext): void {
	server.registerTool(
		'grandmcp_view3d',
		{
			title: '3D view',
			description: [
				"Make sure grandMA3's 3D window is on a screen (adds one if there is none, which changes that screen's layout) and optionally pick a camera (Front, Top, Front/Left, Auto, ...).",
				'Use it before grandmcp_screenshot to look at a look. On onPC without MA hardware the 3D view may not draw fixtures and beams.',
			].join(' '),
			inputSchema: z.object({
				screen: z.number().int().min(1).max(16).default(1),
				camera: z.string().min(1).optional().describe('Camera name, e.g. "Front", "Top", "Front/Left", "Auto".'),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
		},
		async ({ screen, camera }) => {
			try {
				const result = await ctx.serialize(() =>
					ctx.bridge.request<{ screen: number; created: boolean; camera: string; cameras: string[] }>('view3d', {
						screen,
						...(camera ? { camera } : {}),
					}),
				);

				return {
					content: [
						{
							type: 'text',
							text: `${result.created ? 'Added a 3D window to' : '3D window on'} screen ${result.screen}, camera ${result.camera}. Cameras: ${result.cameras.join(', ')}.`,
						},
					],
					structuredContent: result,
				};
			} catch (error) {
				return fromError(error);
			}
		},
	);

	server.registerTool(
		'grandmcp_screenshot',
		{
			title: 'Screenshot',
			description: [
				"Take a screenshot of one of grandMA3's screens, e.g. after grandmcp_view3d to look at a look in the 3D view (fixtures and beams render on onPC too).",
				"When onPC runs on this Mac, the onPC window is captured through macOS (grandMA3's own capture only grabs a corner on Retina screens); otherwise grandMA3 renders the screenshot itself, which also works over the network.",
			].join(' '),
			inputSchema: z.object({
				screen: z.number().int().min(1).max(16).default(1).describe('grandMA3 screen (display) number.'),
				full: z.boolean().default(false).describe('grandMA3 capture only: include the view bar and encoder bar.'),
				source: z.enum(['auto', 'window', 'grandma3']).default('auto').describe('auto = window capture when onPC runs on this Mac, else grandMA3.'),
			}),
			annotations: { readOnlyHint: true, idempotentHint: false },
		},
		async ({ screen, full, source }) => {
			try {
				const local = process.platform === 'darwin' && ['127.0.0.1', 'localhost', '::1'].includes(config.host);

				if (source === 'window' || (source === 'auto' && local)) {
					const png = await captureOnpcWindow(screen);

					return {
						content: [
							{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
							{ type: 'text', text: `onPC window for screen ${screen} (macOS capture).` },
						],
					};
				}

				const result = await ctx.serialize(() => ctx.bridge.request<{ screen: number; blocks: string[] }>('screen.capture', { screen, full }, 30_000));
				const png = joinBlocks(result.blocks);

				return {
					content: [
						{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
						{ type: 'text', text: `Screen ${result.screen} of grandMA3.` },
					],
				};
			} catch (error) {
				return fromError(error);
			}
		},
	);
}
