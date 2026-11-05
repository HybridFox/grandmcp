import { defineConfig } from 'vitest/config';

// End-to-end suite against a running grandMA3 onPC with the grandmcp plugin. Opt-in: pnpm test:e2e.
export default defineConfig({
	test: {
		include: ['test/e2e/**/*.e2e.ts'],
		testTimeout: 180_000,
		hookTimeout: 180_000,
		fileParallelism: false,
		sequence: { concurrent: false },
	},
});
