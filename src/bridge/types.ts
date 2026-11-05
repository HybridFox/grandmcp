/** Shapes returned by the grandmcp Lua plugin's patch ops. */

export interface LiveFixture {
	stage: string;
	fid?: string;
	cid?: string;
	idType: string;
	name: string;
	type?: string;
	mode?: string;
	/** "U.AAA", absent when unpatched. */
	patch?: string;
	footprint?: number;
	conflicted: boolean;
	/** FID of the grouping fixture this fixture sits under. */
	parent?: string;
	/** Fixtures under this one (it is a grouping fixture). */
	children: number;
	/** Cells of a multi-instance fixture (pixel bars and the like); they have no FID of their own. */
	subfixtures: number;
}

export interface LivePatch {
	stages: string[];
	fixtures: LiveFixture[];
}

export interface DmxMode {
	name: string;
	footprint: number;
	breaks: number;
}

export interface FixtureType {
	index: number;
	name: string;
	manufacturer?: string;
	shortName?: string;
	modes: DmxMode[];
}

export type LibrarySource = 'user' | 'grandma3' | 'gdtf-share' | 'fixture-share' | 'grandma2';

/** One fixture type in MA's library listing (local libraries, user files and the online Shares). */
export interface LibraryEntry {
	source: LibrarySource;
	file: string;
	/** Folder for local files, "ws://GDTFShare/id=..." for Share entries. */
	path: string;
	manufacturer?: string;
	name: string;
	version?: string;
	/** Modes as listed in the catalog. Footprints are hints: verify them after import. */
	modes: { name: string; footprint?: number }[];
}

export interface CatalogPage {
	total: number;
	offset: number;
	entries: LibraryEntry[];
}

export interface PatchAddResult {
	backup: string;
	committed: boolean;
	verified: boolean;
	/** Set when the read-back after the commit failed; the change is in, but unchecked. */
	verifyError?: string;
	results: { fid: number; ok: boolean; actual?: LiveFixture }[];
}

/** An open MA pop-up, as the plugin reads it. */
export interface Dialog {
	title?: string;
	message?: string;
	buttons: string[];
}

export interface MoveResult {
	pending: boolean;
	dialog?: Dialog;
	moved?: boolean;
	cancelled?: boolean;
	note?: string;
	backup: string;
	results?: { fid: number; ok: boolean; parent?: string }[];
}
