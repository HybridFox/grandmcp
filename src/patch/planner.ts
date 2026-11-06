import type { DmxMode, FixtureType, LivePatch } from '../bridge/types.ts';

import type { PatchPlanInput } from './schema.ts';

export const UNIVERSE_SIZE = 512;
export const MAX_UNIVERSE = 1024;

export interface PlannedFixture {
	fid: number;
	name: string;
	type: string;
	mode: string;
	footprint: number;
	/** "U.AAA", or null to leave unpatched. */
	patch: string | null;
	/** Index of the input row this fixture came from. */
	row: number;
	/** FID of the grouping fixture it goes under. */
	parent?: number;
}

export interface PatchPlan {
	stage: string;
	fixtures: PlannedFixture[];
	errors: string[];
	warnings: string[];
	/** Requested type names that are not in the show yet. */
	missingTypes: string[];
}

export function formatAddress(universe: number, address: number): string {
	return `${universe}.${String(address).padStart(3, '0')}`;
}

export function parseAddress(value: string): { universe: number; address: number } | undefined {
	const match = /^(\d{1,4})\.(\d{1,3})$/.exec(value.trim());

	if (!match) {
		return undefined;
	}

	const universe = Number(match[1]);
	const address = Number(match[2]);

	if (universe < 1 || universe > MAX_UNIVERSE || address < 1 || address > UNIVERSE_SIZE) {
		return undefined;
	}

	return { universe, address };
}

/** Which fixture owns each DMX channel, per universe. Index 0 is unused so addresses map 1:1. */
export class Occupancy {
	private readonly universes = new Map<number, (string | undefined)[]>();

	private channels(universe: number): (string | undefined)[] {
		let channels = this.universes.get(universe);

		if (!channels) {
			channels = new Array<string | undefined>(UNIVERSE_SIZE + 1);
			this.universes.set(universe, channels);
		}

		return channels;
	}

	/** First owner found in the range, or undefined when it is free. */
	ownerIn(universe: number, address: number, footprint: number): string | undefined {
		const channels = this.channels(universe);
		for (let a = address; a < address + footprint; a++) {
			if (channels[a] !== undefined) {
				return channels[a];
			}
		}

		return undefined;
	}

	claim(universe: number, address: number, footprint: number, owner: string): void {
		const channels = this.channels(universe);
		for (let a = address; a < address + footprint; a++) {
			channels[a] = owner;
		}
	}

	firstFree(universe: number, footprint: number): number | undefined {
		for (let address = 1; address + footprint - 1 <= UNIVERSE_SIZE; address++) {
			const owner = this.ownerIn(universe, address, footprint);

			if (owner === undefined) {
				return address;
			}
		}

		return undefined;
	}
}

export function findType(types: FixtureType[], name: string): FixtureType[] {
	const wanted = name.trim().toLowerCase();

	return types.filter((t) => t.name.toLowerCase() === wanted);
}

export function pickMode(type: FixtureType, requested: string | undefined): DmxMode | string {
	const names = type.modes.map((m) => `"${m.name}" (${m.footprint} ch)`).join(', ');

	if (requested === undefined) {
		if (type.modes.length === 1 && type.modes[0]) {
			return type.modes[0];
		}

		return `fixture type "${type.name}" has several modes, pick one: ${names}`;
	}

	// Library mode names can carry trailing spaces ("36ch "), so compare trimmed.
	const mode = type.modes.find((m) => m.name.trim().toLowerCase() === requested.trim().toLowerCase());

	return mode ?? `fixture type "${type.name}" has no mode "${requested}". Modes: ${names}`;
}

/**
 * Turns fixture rows into concrete fixtures with IDs and addresses, checked against the live patch and against
 * each other. Pure: no console access, so the whole plan can be reviewed before anything is written.
 */
export function planPatch(input: PatchPlanInput, live: LivePatch, types: FixtureType[]): PatchPlan {
	const errors: string[] = [];
	const warnings: string[] = [];
	const missingTypes = new Set<string>();
	const fixtures: PlannedFixture[] = [];

	const stage = input.stage ?? live.stages[0] ?? 'Stage 1';

	if (!live.stages.includes(stage)) {
		errors.push(`stage "${stage}" does not exist. Stages: ${live.stages.join(', ') || 'none'}`);
	}

	const occupancy = new Occupancy();
	const takenFids = new Map<number, string>();
	for (const f of live.fixtures) {
		if (f.idType === 'Fixture' && f.fid !== undefined) {
			takenFids.set(Number(f.fid), `"${f.name}" in the show`);
		}

		const at = f.patch ? parseAddress(f.patch) : undefined;

		if (at) {
			const footprint = f.footprint ?? 1;

			if (f.footprint === undefined) {
				warnings.push(`could not read the footprint of "${f.name}" at ${f.patch}; assuming 1 channel`);
			}

			occupancy.claim(at.universe, at.address, footprint, `FID ${f.fid ?? '-'} "${f.name}" (in the show)`);
		}
	}

	input.fixtures.forEach((entry, row) => {
		const label = `row ${row + 1} (${entry.type})`;
		const matches = findType(types, entry.type);

		if (matches.length === 0) {
			missingTypes.add(entry.type);
			errors.push(`${label}: fixture type "${entry.type}" is not in the show; import it first`);

			return;
		}

		if (matches.length > 1) {
			errors.push(`${label}: ${matches.length} fixture types are named "${entry.type}"; rename them in the show first`);

			return;
		}

		const type = matches[0] as FixtureType;
		const mode = pickMode(type, entry.mode);

		if (typeof mode === 'string') {
			errors.push(`${label}: ${mode}`);

			return;
		}

		if (mode.breaks > 1) {
			errors.push(`${label}: mode "${mode.name}" uses ${mode.breaks} DMX breaks, which is not supported yet`);

			return;
		}

		const grouping = mode.footprint === 0; // grouping fixtures have no DMX channels and are never patched

		if (grouping && entry.patch !== 'auto' && entry.patch !== 'none') {
			errors.push(`${label}: "${type.name}" has no DMX channels (a grouping fixture), so it cannot be patched; use patch "none"`);

			return;
		}

		if (mode.footprint < 0 || mode.footprint > UNIVERSE_SIZE) {
			errors.push(`${label}: mode "${mode.name}" reports a footprint of ${mode.footprint} channels`);

			return;
		}

		if (entry.parent !== undefined) {
			const parentFid = entry.parent;
			const inShow = live.fixtures.find((f) => f.idType === 'Fixture' && Number(f.fid) === parentFid);
			const inPlan = fixtures.find((f) => f.fid === parentFid);
			const parentFootprint = inShow ? inShow.footprint : inPlan?.footprint;

			if (!inShow && !inPlan) {
				errors.push(`${label}: parent FID ${parentFid} is neither in the show nor created by an earlier row`);

				return;
			}

			if (parentFootprint !== 0) {
				errors.push(`${label}: parent FID ${parentFid} is not a grouping fixture`);

				return;
			}

			if (inShow?.parent !== undefined) {
				errors.push(`${label}: parent FID ${parentFid} is itself inside a grouping fixture; use a top-level one`);

				return;
			}
		}

		const explicit = entry.patch === 'auto' || entry.patch === 'none' ? undefined : parseAddress(entry.patch);

		if (entry.patch !== 'auto' && entry.patch !== 'none' && !explicit) {
			errors.push(`${label}: "${entry.patch}" is not a valid address (universe 1-${MAX_UNIVERSE}, address 1-${UNIVERSE_SIZE})`);

			return;
		}

		let autoUniverse = entry.universe ?? 1;
		const spilled: number[] = [];

		for (let i = 0; i < entry.count; i++) {
			const fid = entry.fid + i;
			const name = entry.name ? (entry.count > 1 ? `${entry.name} ${i + 1}` : entry.name) : `${type.name} ${fid}`;
			const owner = `FID ${fid} "${name}"`;

			const fidOwner = takenFids.get(fid);

			if (fidOwner) {
				errors.push(`${label}: FID ${fid} is already used by ${fidOwner}`);
				continue;
			}

			takenFids.set(fid, `${owner} (${label})`);

			let patch: string | null = null;

			if (explicit) {
				const address = explicit.address + i * mode.footprint;

				if (address + mode.footprint - 1 > UNIVERSE_SIZE) {
					errors.push(
						`${label}: FID ${fid} at ${formatAddress(explicit.universe, address)} runs past channel ${UNIVERSE_SIZE} of universe ${explicit.universe}`,
					);
					continue;
				}

				const clash = occupancy.ownerIn(explicit.universe, address, mode.footprint);

				if (clash) {
					errors.push(`${label}: FID ${fid} at ${formatAddress(explicit.universe, address)} overlaps ${clash}`);
					continue;
				}

				occupancy.claim(explicit.universe, address, mode.footprint, owner);
				patch = formatAddress(explicit.universe, address);
			} else if (entry.patch === 'auto' && !grouping) {
				let address = occupancy.firstFree(autoUniverse, mode.footprint);

				while (address === undefined && autoUniverse < MAX_UNIVERSE) {
					autoUniverse++;
					address = occupancy.firstFree(autoUniverse, mode.footprint);
				}

				if (address === undefined) {
					errors.push(`${label}: no free block of ${mode.footprint} channels for FID ${fid} in universe ${autoUniverse}`);
					continue;
				}

				occupancy.claim(autoUniverse, address, mode.footprint, owner);
				patch = formatAddress(autoUniverse, address);

				if (entry.universe !== undefined && autoUniverse !== entry.universe) {
					spilled.push(fid);
				}
			}

			fixtures.push({
				fid,
				name,
				type: type.name,
				mode: mode.name,
				footprint: mode.footprint,
				patch,
				row,
				...(entry.parent ? { parent: entry.parent } : {}),
			});
		}

		if (spilled.length > 0) {
			const first = spilled[0] as number;
			const last = spilled[spilled.length - 1] as number;
			const fids = first === last ? `FID ${first}` : `FID ${first}-${last}`;
			const into = [...new Set(fixtures.filter((f) => spilled.includes(f.fid)).map((f) => (f.patch ?? '').split('.')[0]))].join(', ');

			warnings.push(`${label}: universe ${entry.universe} is full: ${fids} continue in universe ${into}`);
		}
	});

	return { stage, fixtures, errors, warnings, missingTypes: [...missingTypes] };
}
