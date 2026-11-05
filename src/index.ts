#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { registerBuildBuskingShowPrompt } from './prompts/buildBuskingShow.ts';
import { registerPatchFromDocumentPrompt } from './prompts/patchFromDocument.ts';
import { registerGroupTools } from './tools/groups.ts';
import { registerInspectTools } from './tools/inspect.ts';
import { registerLibraryTools } from './tools/library.ts';
import { registerManualTools } from './tools/manual.ts';
import { registerMoveTools } from './tools/move.ts';
import { registerPatchTools } from './tools/patch.ts';
import { registerPresetTools } from './tools/presets.ts';
import { registerScreenshotTools } from './tools/screenshot.ts';
import { registerSequenceTools } from './tools/sequences.ts';
import { registerStatusTools } from './tools/status.ts';
import { createContext } from './context.ts';

const ctx = createContext();

serveStdio(() => {
	const server = new McpServer({ name: 'grandmcp', version: '0.1.0' });
	registerStatusTools(server, ctx);
	registerInspectTools(server, ctx);
	registerLibraryTools(server, ctx);
	registerPatchTools(server, ctx);
	registerMoveTools(server, ctx);
	registerGroupTools(server, ctx);
	registerPresetTools(server, ctx);
	registerSequenceTools(server, ctx);
	registerScreenshotTools(server, ctx);
	registerManualTools(server, ctx);
	registerPatchFromDocumentPrompt(server);
	registerBuildBuskingShowPrompt(server);

	return server;
});
