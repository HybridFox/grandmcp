import os from 'node:os';
import path from 'node:path';

function intEnv(name: string, fallback: number): number {
	const raw = process.env[name];

	if (raw === undefined || raw === '') return fallback;

	const value = Number.parseInt(raw, 10);

	if (!Number.isFinite(value)) throw new Error(`${name} must be an integer, got '${raw}'`);

	return value;
}

/** gma3_library: user data shared by all installed MA3 versions. */
function defaultLibraryDir(): string {
	if (process.platform === 'win32') return 'C:\\ProgramData\\MALightingTechnology\\gma3_library';

	return path.join(os.homedir(), 'MALightingTechnology', 'gma3_library');
}

export const config = {
	host: process.env.GRANDMCP_HOST ?? '127.0.0.1',
	port: intEnv('GRANDMCP_PORT', 9810),
	timeoutMs: intEnv('GRANDMCP_TIMEOUT_MS', 15000),
	allowWrite: process.env.GRANDMCP_ALLOW_WRITE === '1',
	libraryDir: process.env.GMA3_LIBRARY ?? defaultLibraryDir(),
};
