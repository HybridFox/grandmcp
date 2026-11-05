import { randomUUID } from 'node:crypto';

import { BridgeClient } from './bridge/client.ts';
import type { CatalogPage, LibraryEntry } from './bridge/types.ts';
import type { ChangePlan } from './patch/changes.ts';
import type { PatchPlan } from './patch/planner.ts';
import { config } from './config.ts';

const PLAN_TTL_MS = 30 * 60 * 1000;
const LIBRARY_TTL_MS = 30 * 60 * 1000;
const CATALOG_PAGE = 2000;

/** A reviewed plan waiting for grandmcp_patch_apply: new fixtures, or changes to existing ones. */
export type PlanEntry = { kind: 'add'; plan: PatchPlan } | { kind: 'change'; plan: ChangePlan };

export type StoredPlan = PlanEntry & {
	/** Fingerprint of the live patch the plan was made against. */
	fingerprint: string;
	createdAt: number;
};

/** Long-lived state shared by every McpServer instance the stdio factory creates. */
export interface AppContext {
	bridge: BridgeClient;
	allowWrite: boolean;
	/** Runs console writes one at a time. */
	serialize<T>(work: () => Promise<T>): Promise<T>;
	plans: {
		save(entry: PlanEntry, fingerprint: string): string;
		take(id: string): StoredPlan | undefined;
	};
	/** MA's fixture catalog, cached: the first read of a session takes a while (25k+ entries). */
	library(): Promise<LibraryEntry[]>;
	invalidateLibrary(): void;
}

export function createContext(): AppContext {
	const bridge = new BridgeClient({ host: config.host, port: config.port, timeoutMs: config.timeoutMs });

	let queue: Promise<unknown> = Promise.resolve();
	const plans = new Map<string, StoredPlan>();
	let libraryCache: { entries: LibraryEntry[]; at: number } | undefined;
	let libraryLoad: Promise<LibraryEntry[]> | undefined;

	return {
		bridge,
		allowWrite: config.allowWrite,
		serialize<T>(work: () => Promise<T>): Promise<T> {
			const run = queue.then(work, work);
			queue = run.catch(() => undefined);

			return run;
		},
		plans: {
			save(entry, fingerprint) {
				const now = Date.now();
				for (const [id, stored] of plans) {
					if (now - stored.createdAt > PLAN_TTL_MS) {
						plans.delete(id);
					}
				}

				const id = `plan-${randomUUID().slice(0, 8)}`;
				plans.set(id, { ...entry, fingerprint, createdAt: now });

				return id;
			},
			take(id) {
				const stored = plans.get(id);
				plans.delete(id);

				if (!stored || Date.now() - stored.createdAt > PLAN_TTL_MS) {
					return undefined;
				}

				return stored;
			},
		},
		library() {
			if (libraryCache && Date.now() - libraryCache.at < LIBRARY_TTL_MS) {
				return Promise.resolve(libraryCache.entries);
			}

			libraryLoad ??= (async () => {
				const entries: LibraryEntry[] = [];
				let total = Infinity;
				while (entries.length < total) {
					const page = await bridge.request<CatalogPage>('library.catalog', { offset: entries.length, limit: CATALOG_PAGE }, 120_000);
					total = page.total;

					if (page.entries.length === 0) {
						break;
					}

					entries.push(...page.entries);
				}

				libraryCache = { entries, at: Date.now() };

				return entries;
			})().finally(() => {
				libraryLoad = undefined;
			});

			return libraryLoad;
		},
		invalidateLibrary() {
			libraryCache = undefined;
		},
	};
}
