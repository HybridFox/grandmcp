#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { registerStatusTools } from './tools/status.ts';
import { createContext } from './context.ts';

const ctx = createContext();

serveStdio(() => {
	const server = new McpServer({ name: 'grandmcp', version: '0.1.0' });
	registerStatusTools(server, ctx);

	return server;
});
