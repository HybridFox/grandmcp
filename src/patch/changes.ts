import type { FixtureType, LiveFixture, LivePatch } from '../bridge/types.ts';

import { findType, formatAddress, Occupancy, parseAddress, pickMode, UNIVERSE_SIZE } from './planner.ts';
import type { PatchChangesInput } from './schema.ts';

export interface FixtureState {
	fid: number;
	name: string;
	type?: string;
	mode?: string;
	/** "U.AAA", or null when unpatched. */
	patch: string | null;
	footprint: number;
}

/** What the plugin's patch.change op receives for one fixture. patch "" unpatches; type and mode always travel together. */
export interface ChangeOps {
	fid: number;
	remove?: true;
	newFid?: number;
	name?: string;
	patch?: string;
	type?: string;
	mode?: string;
}

export interface PlannedChange {
	fid: number;
	stage: string;
	remove: boolean;
	before: FixtureState;
	/** Final state, absent for removals. */
	after?: FixtureState;
	/** The fixture type or mode changes, so programmed values for attributes the new mode lacks are dropped. */
	retype: boolean;
	ops: ChangeOps;
}

export interface ChangePlan {
	changes: PlannedChange[];
	errors: string[];
	warnings: string[];
}

function stateOf(f: LiveFixture): FixtureState {
	return { fid: Number(f.fid), name: f.name, type: f.type, mode: f.mode, patch: f.patch ?? null, footprint: f.footprint ?? 1 };
}

/**
 * Checks changes to existing fixtures (remove, new FID, rename, re-address, new type or mode) against the live patch.
 * Everything is judged on the final state, so swaps and moves into space freed by another change are fine. Pure:
 * no console access.
 */
export function planChanges(input: PatchChangesInput, live: LivePatch, types: FixtureType[]): ChangePlan {
	const errors: string[] = [];
	const warnings: string[] = [];
	const changes: PlannedChange[] = [];

	const fixtures = live.fixtures.filter((f) => f.idType === 'Fixture' && f.fid !== undefined);
	const byFid = new Map(fixtures.map((f) => [Number(f.fid), f]));
	const seen = new Set<number>();

	for (const change of input.changes) {
		const label = `FID ${change.fid}`;
		const fixture = byFid.get(change.fid);

		if (!fixture) {
			errors.push(`${label}: no fixture with this ID in the show`);
			continue;
		}

		if (seen.has(change.fid)) {
			errors.push(`${label}: listed more than once; combine its changes into one entry`);
			continue;
		}

		seen.add(change.fid);
		const before = stateOf(fixture);

		if (change.remove) {
			changes.push({ fid: change.fid, stage: fixture.stage, remove: true, before, retype: false, ops: { fid: change.fid, remove: true } });
			continue;
		}

		let type = fixture.type;
		let mode = fixture.mode;
		let footprint = before.footprint;
		let retype = false;

		if (change.type !== undefined || change.mode !== undefined) {
			const typeName = change.type ?? fixture.type;
			const matches = typeName ? findType(types, typeName) : [];

			if (matches.length !== 1) {
				errors.push(
					`${label}: ${matches.length === 0 ? `fixture type "${typeName}" is not in the show; import it first` : `${matches.length} fixture types are named "${typeName}"`}`,
				);
				continue;
			}

			const target = matches[0] as FixtureType;
			const picked = pickMode(target, change.mode ?? (change.type === undefined ? fixture.mode : undefined));

			if (typeof picked === 'string') {
				errors.push(`${label}: ${picked}`);
				continue;
			}

			if (picked.breaks > 1) {
				errors.push(`${label}: mode "${picked.name}" uses ${picked.breaks} DMX breaks, which is not supported yet`);
				continue;
			}

			retype = target.name !== fixture.type || picked.name !== fixture.mode;
			type = target.name;
			mode = picked.name;
			footprint = picked.footprint;

			if (retype && fixture.parent !== undefined) {
				errors.push(`${label}: changing the type or mode of a fixture inside a grouping fixture is not supported yet`);
				continue;
			}

			if (retype && fixture.subfixtures > 0) {
				warnings.push(`${label}: has ${fixture.subfixtures} sub-fixtures; check them after the type change`);
			}
		}

		let patch = before.patch;

		if (change.patch === 'none') {
			patch = null;
		} else if (change.patch !== undefined) {
			const at = parseAddress(change.patch);

			if (!at) {
				errors.push(`${label}: "${change.patch}" is not a valid address`);
				continue;
			}

			patch = formatAddress(at.universe, at.address);
		}

		const after: FixtureState = { fid: change.newFid ?? change.fid, name: change.name ?? fixture.name, type, mode, patch, footprint };
		const ops: ChangeOps = { fid: change.fid };

		if (after.fid !== before.fid) {
			ops.newFid = after.fid;
		}

		if (after.name !== before.name) {
			ops.name = after.name;
		}

		if (retype) {
			ops.type = type;
			ops.mode = mode;
		}

		// After a type change the address is set again explicitly, so the result never depends on what MA keeps.
		if (patch !== before.patch || retype) {
			ops.patch = patch ?? '';
		}

		if (Object.keys(ops).length === 1) {
			warnings.push(`${label}: already in the requested state, nothing to change`);
			continue;
		}

		changes.push({ fid: change.fid, stage: fixture.stage, remove: false, before, after, retype, ops });
	}

	// Removing a grouping fixture removes the fixtures under it too.
	const removedParents = new Set(changes.filter((c) => c.remove).map((c) => c.fid));
	const takenAlong = fixtures.filter((f) => f.parent !== undefined && removedParents.has(Number(f.parent)) && !seen.has(Number(f.fid)));
	for (const parentFid of removedParents) {
		const kids = takenAlong.filter((f) => Number(f.parent) === parentFid);

		if (kids.length > 0) {
			warnings.push(
				`FID ${parentFid} is a grouping fixture: removing it also removes the ${kids.length} fixture(s) under it (FID ${kids.map((f) => f.fid).join(', ')})`,
			);
		}
	}

	for (const c of changes) {
		if (!c.remove && c.before && removedParents.has(Number(byFid.get(c.fid)?.parent))) {
			errors.push(`FID ${c.fid}: its grouping fixture ${byFid.get(c.fid)?.parent} is removed in this plan, which removes it too`);
		}
	}

	const goneAlong = new Set(takenAlong.map((f) => Number(f.fid)));

	// Final state of every fixture in the show.
	const changed = new Map(changes.map((c) => [c.fid, c]));
	const finalStates = fixtures
		.filter((f) => !goneAlong.has(Number(f.fid)))
		.map((f) => {
			const c = changed.get(Number(f.fid));

			return { changed: c !== undefined, state: c ? c.after : stateOf(f) };
		})
		.filter((entry): entry is { changed: boolean; state: FixtureState } => entry.state !== undefined);

	const owners = new Map<number, { changed: boolean; state: FixtureState }>();
	for (const entry of finalStates) {
		const other = owners.get(entry.state.fid);

		if (other && (entry.changed || other.changed)) {
			errors.push(`FID ${entry.state.fid} would be used twice: by "${other.state.name}" and "${entry.state.name}"`);
		}

		owners.set(entry.state.fid, entry);
	}

	const occupancy = new Occupancy();
	const ordered = [...finalStates.filter((e) => !e.changed), ...finalStates.filter((e) => e.changed)];
	for (const { changed: isChanged, state } of ordered) {
		const at = state.patch ? parseAddress(state.patch) : undefined;

		if (!at) {
			continue;
		}

		const owner = `FID ${state.fid} "${state.name}"`;

		if (isChanged) {
			if (at.address + state.footprint - 1 > UNIVERSE_SIZE) {
				errors.push(`${owner} at ${state.patch} (${state.footprint} ch) runs past channel ${UNIVERSE_SIZE} of universe ${at.universe}`);
				continue;
			}

			const clash = occupancy.ownerIn(at.universe, at.address, state.footprint);

			if (clash) {
				errors.push(`${owner} at ${state.patch} (${state.footprint} ch) would overlap ${clash}`);
				continue;
			}
		}

		occupancy.claim(at.universe, at.address, state.footprint, owner);
	}

	const names = new Map<string, number>();
	for (const { state } of finalStates) {
		names.set(state.name, (names.get(state.name) ?? 0) + 1);
	}

	for (const c of changes) {
		if (c.ops.name && (names.get(c.ops.name) ?? 0) > 1) {
			warnings.push(`FID ${c.fid}: another fixture is also named "${c.ops.name}"; MA will rename one of them with a "#2" suffix`);
		}
	}

	return { changes, errors, warnings };
}
