// Copies the grandmcp plugin into gma3_library/datapools/plugins so onPC can import it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from '../src/config.ts';

const source = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugin');
const target = path.join(config.libraryDir, 'datapools', 'plugins');

if (!fs.existsSync(config.libraryDir)) {
	console.error(`gma3_library not found at ${config.libraryDir} (set GMA3_LIBRARY to override)`);
	process.exit(1);
}

fs.mkdirSync(target, { recursive: true });
for (const file of ['grandmcp.xml', 'grandmcp.lua']) {
	fs.copyFileSync(path.join(source, file), path.join(target, file));
	console.info(`copied ${file} -> ${target}`);
}
