# grandMA3 probe notes (onPC 2.5.1.1, macOS)

Verified live through the bridge's dev `lua` op on 2026-11-05. `lua_functions_2.5.1.1.txt` is the
`HelpLua` dump for the same build.

## Runtime

- Lua 5.5. `require("socket")` and `require("json")` (rxi) ship in `shared/resource/lib_plugins/requirements`.
- `coroutine.yield(seconds)` works inside `xpcall`, so ops can wait for the main task.
- `CmdObj():Get("Destination", Enums.Roles.Display)` shows where the command line points
  (`Root`, `ShowData.Patch`, `Stage 1.Fixtures`).

## Patch objects

- `ShowData().LivePatch` (`14.9`) is the active patch. `ShowData().Patch` (`14.10`) is the edit copy.
- `Patch()` returns the **edit copy while one is open**, the live patch otherwise. Read from
  `ShowData().LivePatch` explicitly.
- Fixtures: `LivePatch.Stages[<stage>].Fixtures:Children()`. Useful properties (Display role):
  `FID`, `CID`, `IDTYPE`, `NAME`, `FIXTURETYPE`, `MODE`, `MODEDIRECT`, `PATCH` (`"1.001"`, empty when
  unpatched), `CONFLITEDPATCH` (sic), `STAGE`.
- DMX mode: `TOTALFOOTPRINT` is the channel count (16-bit dimmer = 2). Channels carry `DMXBREAK`.

## Edit cycle (no dialogs, verified)

1. `CmdIndirect('ChangeDestination Root')`, `CmdIndirect('ChangeDestination "ShowData"."Patch"')`.
2. Import a type into the edit copy:
   `ShowData().Patch.FixtureTypes:Acquire():Import(GetPath(Enums.PathType.GrandMA2Library) .. GetPathSeparator(), "generic@dimmer.pxml")`.
3. `CmdIndirect('ChangeDestination "Stages"."Stage 1"."Fixtures"')`, then
   `AddFixtures{mode = <DMXMode handle>, amount = 1, fid = "101", name = "...", patch = {"1.001"}}` returns `true`.
4. `CmdIndirect('ChangeDestination Root')` commits silently, with no undo.

## Gotchas

- `CheckFIDCollision` / `CheckDMXCollision` only see the **committed** patch. Fixtures added in the open
  edit copy still read as free, so overlaps inside one batch must be checked by the caller.
- `FixtureTypes.Source` is a `SourceType` enum (`show` / `library` / `PSR`), not a library selector.
  The `set 'FixtureTypes' Source='grandMA3'` line in `gma3internal_fixtures.lua` is stale.
- MA2 library files (`.pxml`) are encrypted on disk; read their modes from the library listing below instead.
- `LivePatch:Export(dir, file)` writes the full patch (types included) as XML, no dialog.
- `ShowData().Patch:Import(dir, file)` of such an export **merges**: fixtures in the file are restored, fixtures
  added since stay. The backup is a full record, not a one-step undo.
- The commit replaces the `LivePatch` object: handles taken before `ChangeDestination Root` are stale
  (indexing them returns nil). Re-read `ShowData().LivePatch` after every commit.
- MA2 library types use generic mode names: `robe@robin ledbeam 150 rgba.pxml` has "Mode 1" (22 ch, the
  manufacturer's "Standard 16-bit") and "Mode 2" (16 ch). Match modes by footprint, not by the document's name.

## Plugin lifecycle

- `ReloadAllPlugins` reloads the Lua stored in the show, not the file on disk. Picking up a new file takes
  `Delete Plugin <n> /NoConfirmation`, `Import Plugin Library "grandmcp.xml" At Plugin <n>`, `Plugin <n>`
  (the dev `reload` op queues exactly that with `CmdIndirect`).
- After a re-import the old copy's `Cleanup` still runs, late. Anything it closes must belong to that copy only,
  never to state shared through `_G`.

## Fixture catalog (`CmdObj().Library`)

- The import dialog's listing: one object per fixture type with `FileName`, `Path`, `Manufacturer`, `Version`,
  `Source` (`grandMA3`, `grandMA2`, `User [GDTF]`, `GDTF Share`, `Fixture Share`) and children per DMX mode
  (`Mode`, `DMXFootprint`). About 25,800 entries, 13,500 of them GDTF Share (`Path` = `ws://GDTFShare/id=<n>`).
- Filled by `Call Library` with the command line inside the patch's `FixtureTypes`. The source switches are
  `CurrentProfile().LoadFixtureLibraryMA / User / Share`; writing them re-lists the library for wherever the command
  line is at that moment, so only touch them inside `FixtureTypes`. The listing survives leaving the edit copy.
- It is **shared by every import dialog**: `Import Plugin Library ...` replaces it with the plugins folder. Check
  `LibraryDestination == "FixtureTypes"` before using it.
- `Import Lib <index> /NC` (command line in `FixtureTypes`) imports entry `<index>`, downloading Share entries via the
  World Server into `gma3_library/fixturetypes` first (~1 s). Indexes shift on every rescan: resolve right before.
- Catalog footprints are hints: the GDTF Share listing reported "126ch = 3" for a mode that imports as 126 channels.
  Mode names can carry trailing spaces (`"36ch "`).
- `shared/lib_fixture_types/worldserver/fixture_cache.dat` is MA's binary cache of the Share catalog, not downloads.
- Source of these findings: MA's own system tests in `lib_plugins/systemtests` (`system_test_fixture_import_shares*.lua`).

## Library paths (`GetPath(Enums.PathType.X)`)

- `GrandMA3Library`: `shared/lib_fixture_types/grandma3` (171 files, mostly `set@`)
- `GrandMA2Library`: `shared/lib_fixture_types/grandma2` (11,536 `.pxml` files)
- `UserFixtures`: `gma3_library/fixturetypes` (user GDTF / XML)
- `DirList(path, "generic@d*")` returns `{name, size, time}` rows.

## Changing existing fixtures (verified with a group and a cue referencing the fixtures)

- In the edit copy, `fixture:Set("FID", "150")`, `Set("Name", ...)` and `Set("Patch", "4.001")` / `Set("Patch", "")`
  work. `Set("FID", "")` does not clear an FID. Setting an FID another fixture holds bumps that fixture; swaps work as
  long as the final state is unique.
- `fixtureHolder:Delete(index)` removes a fixture (index = position in `Stage.Fixtures:Children()`).
- **Never `Set("Mode", ...)`**: every value format tried (name, index, address) blanks the mode _and_ the fixture type.
  Change type or mode with `Assign FixtureType "<type>"."DMXModes"."<mode>" At <index>` from the stage's `Fixtures`
  destination (via `CmdIndirect`, no dialog). It keeps the address; set it again anyway.
- Inside the edit copy `ChangeDestination "ShowData"."Patch"` resolves relative to the current destination and fails
  from `Stage 1.Fixtures`; climb with `ChangeDestination ..` instead (`ChangeDestination Root` would commit).
- Programming refers to fixtures by object: groups and cues follow an FID change and an address change. A deleted fixture
  silently drops out of groups. After a type or mode change, cue values are kept per attribute (Dimmer 50 survived
  Robin Mode 1 -> Mode 2 -> Generic Dimmer).
- `GetReferences()` / `GetDependencies()` return nothing for fixtures. Where a fixture is used is only visible in the
  exported XML of groups, sequences and presets: `IDType="0" ID="<fid>"` (`IDType` 0 = Fixture).
- MA keeps fixture names unique: adding a second "Beam 1" renames the older one to "Beam 1#2".

## Groups

- `DataPool().Groups[n]` is pool slot n; `Groups:Create(n)` makes it. `group:Import(dir, file)` of a group XML
  (`<Group Name=..><SelectionData Size=..><Item IDType="0" ID="301" X="0" Y="0" Z="0"/>...`) **replaces** its content.
- Reading a group without touching the programmer: export it and scan the `Item` elements. (Selecting it with
  `Group n` + `SelectionFirst` works too, but clears the user's selection.)
- MA strips `"` and `&` from object names.
- onPC without MA hardware outputs no DMX: `GetDMXValue` reads 0 even while a cue plays, so programming checks have to
  go through exports.

## Grouping fixtures

- MA3 library `generic@grouping.xml` = type "Grouping", one mode "Default" with 0 channels (`TOTALFOOTPRINT` 0).
- `AddFixtures{..., parent = <grouping fixture handle>}` (inside the stage's `Fixtures` in the edit copy) creates the
  fixture as a child of the grouping fixture: `parentFixture:Children()` holds it, class `Fixture`.
- Children of class `SubFixture` are something else: the cells of multi-instance fixtures (a pixel strip has 80,
  named "[Instance1]"...), without FID or patch. Walk only `Fixture` children to find nested fixtures.
- Deleting a grouping fixture deletes the fixtures under it.
- Moving existing fixtures: in the edit copy at the source holder (`<stage>.Fixtures`, or `ChangeDestination <index>`
  into a grouping fixture), `Cut 1 + 2` only marks them; nothing moves yet. Navigate to the target holder and
  `Paste <count + 1>`: a MessageBox "Move Fixtures" asks "keep their absolute position and rotation in 3D space, or
  their offset relative to their parent?" with buttons Absolute / Relative / Cancel. The paste completes only once it
  is answered (`LastCommand` stays at the previous command meanwhile); it does not time out (still open after 60 s).
- After the move (Absolute), FIDs, names and addresses are unchanged, cue and group references survive, but groups
  list the moved fixtures last: group 10 went from 301-305 to 303, 304, 305, 301, 302.
- Inside a grouping fixture the command-line destination shows the fixture's name ("Truss Test").
- `Oops` works inside the edit copy before the commit: it undid a completed paste, after which leaving the edit copy
  committed nothing.

## Pop-ups (MessageBox)

- `GetTopModal()` returns the MessageBox. Its title is the `TitleButton`'s `Text`, the question is a `UIObject` named
  "Text", and the answers are `Button`s under the `Commands` grid (`Text`, `AbsRect`).
- `Mouse(display, "move"/"press"/"release", ...)` could click them, but grandmcp deliberately never answers pop-ups:
  they are reported to the user, who answers on the console.
