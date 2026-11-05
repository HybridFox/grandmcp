#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { registerPatchFromDocumentPrompt } from './prompts/patchFromDocument.ts';
import { registerInspectTools } from './tools/inspect.ts';
import { registerLibraryTools } from './tools/library.ts';
import { registerManualTools } from './tools/manual.ts';
import { registerPatchTools } from './tools/patch.ts';
import { registerStatusTools } from './tools/status.ts';
import { createContext } from './context.ts';

const ctx = createContext();

serveStdio(() => {
	const server = new McpServer({ name: 'grandmcp', version: '0.1.0' });
	registerStatusTools(server, ctx);
	registerInspectTools(server, ctx);
	registerLibraryTools(server, ctx);
	registerPatchTools(server, ctx);
	registerManualTools(server, ctx);
	registerPatchFromDocumentPrompt(server);

	return server;
});
