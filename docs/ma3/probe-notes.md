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

## Fixture attributes

- Mode -> `DMXChannels` -> channel (`Coarse`/`Fine` offsets) -> `LogicalChannel` (`Attribute`) -> channel functions
  (`Attribute`, `DMXFrom`/`DMXTo` as 24-bit hex, `PhysicalFrom`/`PhysicalTo`) -> channel sets (named slots, DMX range
  only; their physical values are 0). Several functions of one channel can share an attribute name (the Robin's
  COLORMIXER has three "ColorMacro" functions). Function names carry an index suffix ("Shutter1Strobe 2").

## Presets

- Pools: 1 Dimmer, 2 Position, 3 Gobo, 4 Color, 5 Beam, 6 Focus, 7 Control, 8 Shapers, 9 Video, 21-25 All.
  `pool:Count()` is the slot capacity (1000) once used; the All pools have no slots in a new show, so `Create` fails
  there until something was stored. `Copy Preset` / `Move Preset` into such a pool works and initialises it.
- Preset XML: `<Preset Name=..><PresetData><Phaser IDType="0" ID="<fid>" Attribute=".." GridPos=".."
Selective="Selective"><Step Function="<function attribute>" .../></Phaser>`. Importing into a preset replaces it.
- Step values: `Absolute` = percent of the **whole channel** (all functions), i.e. exact DMX (DMX = pct/100 * FFFFFF),
  and MA derives the function from it. `AbsolutePhys` = physical value of the function named in `Function`, which is
  ambiguous when functions share an attribute (Congo blue landed on DMX 0). grandmcp writes `Absolute`.
- `GetPresetData(preset).by_fixtures[fid][attr]` reads it back: per step `absolute_value` (24-bit DMX, full = 2^24),
  `absolute` (percent within the function), `channel_function` (0-based); per phaser `speed`, `phase`, `measure`.
- MA's own Store records dimmer and colour presets as Universal (one sample per fixture type) by default.

## Effects (phasers)

- A phaser is a `Phaser` with several `Step`s: `Speed` (2^24 = 1 cycle per second = 60 BPM), `Phase` (degrees,
  per fixture), `Measure` (2^24 = 100 %), `SpeedMaster` ("Speed1".."Speed16"; a bare number is misread as an index,
  a full path is ignored). Steps: value plus `Width`, `Trans` (0 snap .. 100 fade), `Accel`, `Decel` in percent.
- MA's library effects are in `shared/resource/lib_presets/predefined_phaser.xml` (Universal, IDType 2).
- Speed masters: `MasterPool().Speed` holds Speed1..Speed16.

## Sequences and executors

- Sequence XML must start with `<Cue Name="OffCue" ...>` and `<Cue Name="CueZero" No="0">`; cues are mapped by
  position, so without them the first cues land on OffCue/CueZero. Cue names are read from the `Part`'s `Name`.
- Timing on the Part (`CueInFade`, `CueOutFade`, `CueInDelay`, `CueOutDelay`, per-feature `Preset<n>Fade`), trigger on
  the Cue (`TrigType` Go/Follow/Time, `TrigTime`).
- A preset reference in a cue: `AbsPreset="s4.20"` (pool.no) on the Phaser, values prefixed with `*`; MA exports it as
  `AbsPreset="sColor.'Name'"` and embeds a copy of the preset under `DependencyExport`.
- Importing over an existing sequence keeps leftovers (CueZero timing); delete and recreate instead.
- `Assign Sequence <n> At Page <p>.<exec>` assigns without a dialog and silently replaces what was there. Page
  children are the existing executors; find one by `No`, not by child index.
- Typing `Preset 4.20` after a selection does not load it into the programmer; `At Preset 4.20` does.

## Screenshots

- `Store Image 3.<n> /Screen "<screen>" /ScreenOnly "Yes"|"No"` stores a screenshot of a grandMA3 screen in image pool 3
  (`ShowData().MediaPools.Images`), no dialog. `image:Export(dir, file)` writes the PNG as `<Block Base64="...">`
  chunks, each encoded on its own: decode each block and join the bytes. Print Screen / F11 also saves PNGs to
  `gma3_library/media/images`.
- osascript cannot read window bounds without Accessibility permission, so screenshots go through grandMA3 instead.

## Playback and startup

- `sequence:HasActivePlayback()` is true while a sequence runs (`Go+ Sequence 10` / `Off Sequence 10`).
- No show-load hook was found: Agenda events are time based only (absolute or twilight times, repeat, valid duration).
- onPC starts a plugin at launch with `app_system.exe HOSTTYPE=onPC RUNPLUGIN="grandmcp.xml"-1` (manual: "Load a Show
  File During Startup"; `-1` is the Lua component). Verified on Windows 2.5.1.1: on a fresh unsaved show the plugin
  was imported into plugin slot 1 and running in local mode right after start, without arguments (so no `lan`/`dev`).
  Unverified: an occupied slot 1, loading another show afterwards, macOS.
- Windows Lua has no `/dev/urandom`; the network token falls back to PowerShell GUIDs through `io.popen` (not yet run on Windows).

## 3D

- Fixture position/rotation properties: `PosX/PosY/PosZ` (metres), `RotX/RotY/RotZ` (degrees, display has a "°"
  suffix); settable with `Set` in the patch edit copy, committed like other patch changes.
- `ShowData().WindowTypes` lists window types ("Window3D" is entry 1). grandMA3's own Add Window dialog runs
  `Store ScreenContent DEFAULT '<WindowType>' MinW=.. /NC`; `Store ScreenContent <screen> "Window3D" /NC` puts a 3D
  window on a given screen, no dialog. `ClassExists` returns false for window class names.
- The window holds a `View3D` object; its window's `WindowSettings` is a `View3DSettings` with `Camera`, `Stage`,
  `RenderQuality` and more. `Camera` is a reference: assign `CurrentProfile().Cameras[n]` (Auto, Front, Front/Left,
  Left, ..., Top, 2D ...); `Set(..., "Camera", "<name>")` is silently ignored.
- onPC renders fixtures and beams in the 3D window without MA hardware (checked on 2.5.1.1, macOS).
- **`Store Image /Screen` is wrong on Retina screens**: it grabs a normal-resolution region of the double-resolution
  framebuffer, i.e. the top-left quarter magnified. On the same Mac, capture the onPC window instead: the CoreGraphics
  window list (JXA `CGWindowListCopyWindowInfo(kCGWindowListOptionAll)`, no Accessibility permission) gives the
  window id of "Display <n> onPC ..." (layer 0), then `screencapture -x -o -l <id>`, which also works when the window
  is behind others or on another Space. The window title also carries the show name.
- Rotation: `RotX` 0 = hanging (beam down), 180 = standing (beam up).
- `ColorRGB_R/G/B` are additive RGB even on CMY fixtures (grandMA3 converts): R100 G0 B0 is red on a CMY mixer.
  Setting R0 G100 B100 to get "red" from cyan/magenta/yellow channels gives cyan.

## Executors, speed masters, pages

- Executor properties (`DataPool().Pages[p]` children, find by `No`): `Fader` (Master, Temp, X, XA, XB, Rate, Speed,
  Time), `KeyPress` / `KeyUnpress` (Go+, Go-, Toggle, Flash, On, Off, Top, Pause, Kill, Select, Learn, LearnSpeed, ...),
  `Width`, `Height`, `Object`. `Set` works directly and reads back.
- **Wide executors cover the slots to their right**: with 203 at Width 2, `Assign ... At Page 1.204` replaces 203's
  content. There is no executor object 204, so check which executor covers a slot.
- `Assign Master 3.<n> At Page p.e` puts speed master n on an executor; grandMA3 sets its button to LearnSpeed (tap).
  `Master 3.<n> At BPM <bpm>` (or Hz / Seconds) sets the speed, `Label Master 3.<n> "<name>"` names it.
- `Store Page <n>` creates a page, `Label Page <n> "<name>"` names it.
- Phaser `SpeedMaster` references the master **by its current name**: after renaming Speed1 to "Dimmer FX",
  `SpeedMaster="Speed1"` no longer resolves (stored as None). Write the current name.

## MAtricks

- `DataPool().MAtricks[n]`; properties `XBlock`, `XGroup`, `XWings`, `XWidth`, `XShift`, `XShuffle`, `XInv`,
  `PhaseFromX`/`PhaseToX`, `FadeFromX`/`FadeToX`, `DelayFromX`/`DelayToX` (also Y and Z). `Set` works; "1"/"None" =
  off. Command-line keywords like `MAtricksWings 2` do not exist in that spelling ("Object not found").

## Sequences: editing and replacing

- Importing XML over an existing sequence merges cue by cue _position_: removing a cue from the XML shifts the rest
  into the wrong slots. Do not use it for edits.
- Deleting a sequence empties every executor holding it. grandmcp remembers them (with fader/button/size) and
  reassigns after recreating.
- Single cues: build the cue in a scratch sequence, then `Copy Sequence <s> Cue <c> At Sequence <t> Cue <c>
/Overwrite /NoConfirmation`; the target keeps its identity. `Delete Sequence <s> Cue <c> /NoConfirmation`.
- The sequence pool has 1000 slots (`Count()`); creating sequence 9990 fails.
- Delete / copy / rename: `Delete <obj> /NoConfirmation`, `Copy <obj> At <obj> /Overwrite /NoConfirmation` (MA names the
  copy "<name>#2"), `Label <obj> "<name>"`.

## Appearances and layouts

- `ShowData().Appearances[n]` (`Create`), colour via `BackR`/`BackG`/`BackB`/`BackAlpha`; assign with
  `object.Appearance = appearance` (a reference, like the 3D camera).
- `Store Layout <n>` creates an empty layout (storing from a selection adds nothing); `Assign Fixture a + b At Layout
<n>` adds elements. Elements: `Object` (the fixture), `PosX`/`PosY`/`Width`/`Height` (default 50 x 50), `Action`
  SelectFixtures.
