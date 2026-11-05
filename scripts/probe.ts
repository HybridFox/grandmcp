// Dev CLI against the running plugin:
//   pnpm probe ping | info
//   pnpm probe cmd 'Fixture 1 At 50'
//   pnpm probe lua 'return Patch():Children()'
//   pnpm probe raw <op> '<json args>'
import { BridgeClient, BridgeError } from '../src/bridge/client.ts';
import { config } from '../src/config.ts';

const [op = 'ping', ...rest] = process.argv.slice(2);
const bridge = new BridgeClient({ host: config.host, port: config.port, timeoutMs: config.timeoutMs });

function argsFor(): [string, Record<string, unknown>] {
	if (op === 'cmd') return ['cmd', { command: rest.join(' ') }];

	if (op === 'lua') return ['lua', { code: rest.join(' ') }];

	if (op === 'raw') return [rest[0] ?? 'ping', rest[1] ? (JSON.parse(rest[1]) as Record<string, unknown>) : {}];

	return [op, {}];
}

try {
	const [name, args] = argsFor();
	const result = await bridge.request(name, args);
	console.info(JSON.stringify(result, null, 2));
} catch (error) {
	if (error instanceof BridgeError) {
		console.error(`[${error.code}/${error.outcome}] ${error.message}`);

		if (error.traceback) console.error(error.traceback);
	} else {
		console.error(error);
	}

	process.exitCode = 1;
} finally {
	bridge.close();
}
