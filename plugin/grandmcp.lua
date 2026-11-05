-- grandmcp bridge: serves newline-delimited JSON over TCP from inside grandMA3.
--
--   request   {"id": <any>, "op": "<name>", "args": {...}}
--   response  {"id": <any>, "ok": true,  "result": <any>}
--             {"id": <any>, "ok": false, "code": "<code>", "error": "<message>"}
--
-- Start:    Plugin "grandmcp"            (or Plugin "grandmcp" "dev" to enable the probe ops)
-- Control:  Plugin "grandmcp" "stop" | "status" | "dev on" | "dev off"

local myHandle = select(4, ...)

local socket = require("socket")
local json = require("json")

local VERSION = "0.7.0"
local HOST = "127.0.0.1" -- unauthenticated: never bind beyond loopback
local PORT = 9810
local MAX_LINES_PER_TICK = 32
local MAX_LINE_BYTES = 4 * 1024 * 1024
local STALE_AFTER_S = 3

-- One server per console. `shared.current` survives between plugin calls (and reloads of this file) so
-- a control call can reach it, but each loaded copy only ever stops the instance it started itself:
-- after a re-import the old copy's late Cleanup must not touch the new server.
_G.__grandmcp = _G.__grandmcp or {}
local shared = _G.__grandmcp
local mine -- the instance this copy started
local pendingControlCleanups = 0

---------------------------------------------------------------------------
-- JSON-safe conversion
---------------------------------------------------------------------------

local function describeHandle(h)
	local d = { type = "handle" }
	local ok, v = pcall(HandleToStr, h)
	if ok then d.handle = v end
	ok, v = pcall(function() return h:ToAddr() end)
	if ok and v ~= nil then d.addr = v end
	ok, v = pcall(function() return h:GetClass() end)
	if ok and v ~= nil then d.class = v end
	ok, v = pcall(function() return h.name end)
	if ok and type(v) == "string" then d.name = v end
	return d
end

local function isArray(t)
	local n = #t
	local count = 0
	for k in pairs(t) do
		if type(k) ~= "number" or k < 1 or k > n or k % 1 ~= 0 then return false end
		count = count + 1
	end
	return count == n
end

local function sanitize(v, depth)
	depth = depth or 0
	local tv = type(v)
	if tv == "string" or tv == "boolean" or tv == "nil" then return v end
	if tv == "number" then
		if v ~= v or v == math.huge or v == -math.huge then return tostring(v) end
		return v
	end
	if tv == "userdata" then return describeHandle(v) end
	if tv ~= "table" then return "<" .. tv .. ">" end
	if depth >= 8 then return "<max depth>" end
	local out = {}
	if isArray(v) then
		for i = 1, #v do out[i] = sanitize(v[i], depth + 1) end
	else
		for k, val in pairs(v) do out[tostring(k)] = sanitize(val, depth + 1) end
	end
	return out
end

---------------------------------------------------------------------------
-- Ops
---------------------------------------------------------------------------

local function fail(code, message, detail)
	error({ code = code, message = message, detail = detail }, 0)
end

-- What an open pop-up asks: title, message and button labels, read from MA's MessageBox UI. Pop-ups are the user's
-- to answer; the bridge only reports them.
local function describeModal(m)
	if not m then return nil end
	local d = { title = nil, message = nil, buttons = {} }
	local function text(o)
		local ok, v = pcall(o.Get, o, "Text", Enums.Roles.Display)
		return ok and v ~= "" and v or nil
	end
	local function walk(h, depth)
		if depth > 12 then return end
		for _, c in ipairs(h:Children()) do
			local class = c:GetClass()
			if class == "TitleButton" and not d.title then d.title = text(c)
			elseif class == "Button" and text(c) then d.buttons[#d.buttons + 1] = text(c)
			elseif c.name == "Text" and text(c) and not d.message then d.message = text(c) end
			walk(c, depth + 1)
		end
	end
	pcall(walk, m, 0)
	return d
end

local function modalSummary(d)
	if not d then return "" end
	return string.format(' "%s": %s [buttons: %s]', tostring(d.title or "?"), tostring(d.message or ""), table.concat(d.buttons, " / "))
end

local function failModal(context)
	local d = describeModal(GetTopModal())
	fail("modal-open", context .. modalSummary(d) .. ". Ask the user to answer it on the console.", { dialog = d })
end

local function devEnabled()
	return shared.current ~= nil and shared.current.dev == true
end

local function requireDev()
	if not devEnabled() then fail("dev-disabled", 'start the plugin with Plugin "grandmcp" "dev on"') end
end

local ops = {}

ops.ping = function()
	return { pong = true, plugin = VERSION, time = socket.gettime() }
end

ops.info = function()
	return {
		plugin = VERSION,
		build = BuildDetails(),
		hostOS = HostOS(),
		showFileStatus = GetShowFileStatus(),
		modalOpen = GetTopModal() ~= nil,
		dialog = describeModal(GetTopModal()),
		commandLine = CmdObj():Get("Destination", Enums.Roles.Display),
		dev = devEnabled(),
	}
end

---------------------------------------------------------------------------
-- Object access
---------------------------------------------------------------------------

local function display(h, prop)
	local ok, v = pcall(h.Get, h, prop, Enums.Roles.Display)
	if ok then return v end
	return nil
end

local function blankToNil(s)
	if s == nil or s == "" or s == "None" then return nil end
	return s
end

local function props(h)
	local out = {}
	for i = 0, h:PropertyCount() - 1 do
		local name = h:PropertyName(i)
		local v = display(h, name)
		if v ~= nil and v ~= "" then out[name] = v end
	end
	return out
end

-- "LivePatch.Stages.Stage 1" (names from ShowData), "Root.ShowData...", or a numeric address like "14.9".
local function resolve(path)
	if type(path) ~= "string" or path == "" then fail("bad-args", "path must be a non-empty string") end
	if path:match("^[%d%.]+$") then
		local h = FromAddr(path)
		if not h then fail("not-found", "no object at address " .. path) end
		return h
	end
	local h, rest = ShowData(), path
	local first, remainder = path:match("^([^%.]+)%.?(.*)$")
	if first == "Root" then
		h, rest = Root(), remainder
	elseif first == "ShowData" then
		rest = remainder
	end
	for part in rest:gmatch("[^%.]+") do
		local n = tonumber(part)
		local child = n and h:Ptr(n) or nil
		if not child then
			local ok, c = pcall(function() return h[part] end)
			if ok and type(c) == "userdata" then child = c end
		end
		if not child then child = h:Find(part) end
		if not child then fail("not-found", "'" .. part .. "' not found under " .. tostring(h:ToAddr())) end
		h = child
	end
	return h
end

local function childSummary(c, index)
	return { index = index, name = c.name, class = c:GetClass(), count = c:Count() }
end

---------------------------------------------------------------------------
-- Patch reads (always from LivePatch: Patch() follows the edit copy while one is open)
---------------------------------------------------------------------------

local function modeInfo(mode)
	local breaks = {}
	for _, ch in ipairs(mode.DMXChannels:Children()) do breaks[display(ch, "DMXBreak") or "1"] = true end
	local count = 0
	for _ in pairs(breaks) do count = count + 1 end
	return { name = mode.name, footprint = tonumber(display(mode, "TotalFootprint")) or 0, breaks = count }
end

local function fixtureTypeInfo(ft, index)
	local modes = {}
	for i, m in ipairs(ft.DMXModes:Children()) do modes[i] = modeInfo(m) end
	return {
		index = index,
		name = ft.name,
		manufacturer = blankToNil(display(ft, "Manufacturer")),
		shortName = blankToNil(display(ft, "ShortName")),
		modes = modes,
	}
end

-- Children of class "Fixture" are fixtures under a grouping fixture; class "SubFixture" are cells of a multi-instance
-- fixture (pixel bars and the like), which have no FID of their own.
local function childCounts(f)
	local children, cells = 0, 0
	for _, c in ipairs(f:Children()) do
		if c:GetClass() == "Fixture" then children = children + 1 else cells = cells + 1 end
	end
	return children, cells
end

local function fixtureRow(f, stageName, parentFid)
	local ft = f:Get("FixtureType")
	local mode = f:Get("ModeDirect")
	local idType = display(f, "IDType") or ""
	local children, cells = childCounts(f)
	return {
		stage = stageName,
		fid = blankToNil(display(f, "FID")),
		cid = blankToNil(display(f, "CID")),
		idType = idType:match("'(.-)'") or idType,
		name = f.name,
		type = type(ft) == "userdata" and ft.name or nil,
		mode = type(mode) == "userdata" and mode.name or nil,
		patch = blankToNil(display(f, "Patch")),
		footprint = type(mode) == "userdata" and tonumber(display(mode, "TotalFootprint")) or nil,
		conflicted = display(f, "ConflitedPatch") == "Yes",
		parent = parentFid,
		children = children,
		subfixtures = cells,
	}
end

-- Calls visit(fixture, stageName, holder, index, parentFid) for every fixture, including those under grouping fixtures.
local function eachFixture(patchObj, visit)
	local function walk(holder, stageName, parentFid)
		for i, f in ipairs(holder:Children()) do
			if f:GetClass() == "Fixture" then
				if visit(f, stageName, holder, i, parentFid) then return true end
				if walk(f, stageName, blankToNil(display(f, "FID"))) then return true end
			end
		end
	end
	for _, stage in ipairs(patchObj.Stages:Children()) do
		if walk(stage.Fixtures, stage.name, nil) then return end
	end
end

-- Fixture with ID type "Fixture" and this FID in a patch object (also under grouping fixtures), with its stage name,
-- the object holding it (the stage's Fixtures or a grouping fixture) and its index there.
local function findFixture(patchObj, fid)
	local found
	eachFixture(patchObj, function(f, stageName, holder, index)
		if display(f, "FID") == tostring(fid) and (display(f, "IDType") or ""):match("'Fixture'") then
			found = { f, stageName, holder, index }
			return true
		end
	end)
	if found then return found[1], found[2], found[3], found[4] end
	return nil
end

local function indexIn(holder, handle)
	for i, child in ipairs(holder:Children()) do
		if child == handle then return i end
	end
	return nil
end

ops.get = function(args)
	local h = resolve(args.path)
	return { object = describeHandle(h), properties = props(h), childCount = h:Count() }
end

ops.children = function(args)
	local h = resolve(args.path)
	local offset = math.max(0, math.floor(tonumber(args.offset) or 0))
	local limit = math.min(500, math.max(1, math.floor(tonumber(args.limit) or 100)))
	local out = {}
	local total = h:Count()
	for i = offset + 1, math.min(total, offset + limit) do
		local c = h:Ptr(i)
		if c then out[#out + 1] = childSummary(c, i) end
	end
	return { object = describeHandle(h), total = total, offset = offset, children = out }
end

ops["patch.types"] = function()
	local out = {}
	for i, ft in ipairs(ShowData().LivePatch.FixtureTypes:Children()) do out[i] = fixtureTypeInfo(ft, i) end
	return out
end

ops["patch.list"] = function()
	local live = ShowData().LivePatch
	local stages, fixtures = {}, {}
	for _, stage in ipairs(live.Stages:Children()) do stages[#stages + 1] = stage.name end
	eachFixture(live, function(f, stageName, _, _, parentFid) fixtures[#fixtures + 1] = fixtureRow(f, stageName, parentFid) end)
	return { stages = stages, fixtures = fixtures }
end

---------------------------------------------------------------------------
-- Patch writes: edit copy -> change -> silent commit (no undo, so callers back up first)
---------------------------------------------------------------------------

local function destination()
	return display(CmdObj(), "Destination")
end

local function guardIdle()
	if GetTopModal() ~= nil then failModal("a pop-up is open on the console") end
	local dest = destination()
	if dest ~= "Root" then
		fail("busy", "the command line is at '" .. tostring(dest) .. "', not Root; someone may be editing. Run 'ChangeDestination Root' when done.")
	end
end

local function waitDestination(expected, timeout)
	local t0 = socket.gettime()
	while socket.gettime() - t0 < (timeout or 5) do
		coroutine.yield(0.05)
		if destination() == expected then return end
		if GetTopModal() ~= nil then failModal("a pop-up opened while the command line moved to " .. expected) end
	end
	fail("timeout", "command line did not reach " .. expected .. " (now at " .. tostring(destination()) .. ")")
end

local function checkName(name, what)
	if type(name) ~= "string" or name == "" or name:find('"', 1, true) then fail("bad-args", what .. " must be a non-empty string without quotes") end
	return name
end

local function enterPatchEdit(stageName)
	CmdIndirect("ChangeDestination Root")
	CmdIndirect('ChangeDestination "ShowData"."Patch"')
	waitDestination("ShowData.Patch")
	if stageName then
		CmdIndirect(string.format('ChangeDestination "Stages"."%s"."Fixtures"', stageName))
		waitDestination(stageName .. ".Fixtures")
	end
end

local function commitPatchEdit()
	CmdIndirect("ChangeDestination Root")
	waitDestination("Root", 10)
end

local function backupLivePatch(label)
	local sep = GetPathSeparator()
	local dir = GetPath(Enums.PathType.Library) .. sep .. "patch"
	local file = string.format("grandmcp-backup-%s-%s.xml", os.date("%Y%m%d-%H%M%S"), label)
	if not ShowData().LivePatch:Export(dir, file) then fail("backup-failed", "could not export the live patch to " .. dir) end
	return dir .. sep .. file
end

---------------------------------------------------------------------------
-- Fixture type catalog: MA's own library listing (CmdObj().Library), the list the import dialog shows. It covers
-- the MA3 and MA2 libraries, user files in gma3_library/fixturetypes and the GDTF / Fixture Share, with DMX modes.
---------------------------------------------------------------------------

local function normalizeSource(source)
	source = string.lower(source or "")
	if source:find("^user") then return "user" end
	if source:find("gdtf") then return "gdtf-share" end
	if source:find("fixture share") then return "fixture-share" end
	return source -- grandma3, grandma2
end

local function leavePatchEdit()
	if destination() ~= "Root" then pcall(commitPatchEdit) end
end

local function enterFixtureTypes()
	enterPatchEdit(nil)
	CmdIndirect('ChangeDestination "FixtureTypes"')
	waitDestination("FixtureTypes")
end

-- The listing is shared by every import dialog (plugins, macros, ...), so it only counts as the fixture catalog
-- while its destination is FixtureTypes.
local function catalogReady()
	local lib = CmdObj().Library
	return lib:Count() > 0 and display(lib, "LibraryDestination") == "FixtureTypes"
end

-- The listing is empty until someone opens an import dialog (or after a restart), and holds whatever that dialog
-- imports (plugins, macros, ...). Filling it needs the command line
-- in the patch's FixtureTypes, so this enters the edit copy and leaves it again without changing anything.
local function loadCatalog()
	guardIdle()
	local ok, err = pcall(function()
		enterFixtureTypes()
		-- Writing these profile switches (the source buttons of the import dialog) re-lists the library for wherever
		-- the command line is, so only touch them here, inside FixtureTypes, and leave them on afterwards.
		local profile = CurrentProfile()
		for _, key in ipairs({ "LoadFixtureLibraryMA", "LoadFixtureLibraryUser", "LoadFixtureLibraryShare" }) do
			if not profile[key] then profile[key] = true end
		end
		CmdIndirect("Call Library")
		-- Done once the listing belongs to FixtureTypes (the old listing may still be there for a moment) and its
		-- count has settled for 1.5 s (the Share part can arrive later than the local libraries).
		local t0, lastCount, stableSince = socket.gettime(), -1, socket.gettime()
		while socket.gettime() - t0 < 45 do
			coroutine.yield(0.25)
			if catalogReady() then
				local count = CmdObj().Library:Count()
				if count ~= lastCount then
					lastCount, stableSince = count, socket.gettime()
				elseif socket.gettime() - stableSince > 1.5 then
					return
				end
			end
		end
		fail("timeout", "the fixture library did not load within 45 s")
	end)
	leavePatchEdit()
	if not ok then error(err, 0) end
end

local function catalogEntry(e)
	local modes = {}
	for i, m in ipairs(e:Children()) do modes[i] = { name = display(m, "Mode"), footprint = tonumber(display(m, "DMXFootprint")) } end
	return {
		source = normalizeSource(display(e, "Source")),
		file = display(e, "FileName"),
		path = display(e, "Path"),
		manufacturer = blankToNil(display(e, "Manufacturer")),
		name = e.name,
		version = blankToNil(display(e, "Version")),
		modes = modes,
	}
end

-- Paged so a 25k-entry catalog never blocks the console for long. args: { offset, limit }
ops["library.catalog"] = function(args)
	if not catalogReady() then loadCatalog() end
	local lib = CmdObj().Library
	local total = lib:Count()
	local offset = math.max(0, math.floor(tonumber(args.offset) or 0))
	local limit = math.min(5000, math.max(1, math.floor(tonumber(args.limit) or 2000)))
	local entries = {}
	for i = offset + 1, math.min(total, offset + limit) do
		local e = lib:Ptr(i)
		if e then entries[#entries + 1] = catalogEntry(e) end
		if i % 250 == 0 then coroutine.yield() end
	end
	return { total = total, offset = offset, entries = entries }
end

-- Imports one catalog entry the way the import dialog does ("Import Lib <index>"); Share entries are downloaded into
-- gma3_library/fixturetypes first. args: { file, path? } as returned by library.catalog.
ops["patch.importType"] = function(args)
	local file = checkName(args.file, "file")
	local path = type(args.path) == "string" and args.path ~= "" and args.path or nil
	guardIdle()
	if not catalogReady() then loadCatalog() end
	local liveBefore = ShowData().LivePatch.FixtureTypes:Count()

	enterFixtureTypes()
	local ok, err = pcall(function()
		local lib = CmdObj().Library
		local index -- indexes shift whenever the listing is rescanned, so look it up right before importing
		for i = 1, lib:Count() do
			local e = lib:Ptr(i)
			if display(e, "FileName") == file and (path == nil or display(e, "Path") == path) then
				index = i
				break
			end
		end
		if not index then fail("not-found", "'" .. file .. "' is not in the fixture library") end

		local types = ShowData().Patch.FixtureTypes
		local before = types:Count()
		CmdIndirect(string.format("Import Lib %d /NC", index))
		local t0 = socket.gettime()
		while types:Count() <= before do
			coroutine.yield(0.1)
			if GetTopModal() ~= nil then failModal("a pop-up opened during the import") end
			if socket.gettime() - t0 > 90 then
				fail("timeout", "the import did not finish within 90 s (Share downloads need the World Server connection)")
			end
		end
	end)
	leavePatchEdit()
	if not ok then error(err, 0) end

	local live = ShowData().LivePatch.FixtureTypes
	if live:Count() <= liveBefore then fail("verify-failed", "no new fixture type in the live patch after the import") end
	return fixtureTypeInfo(live:Ptr(live:Count()), live:Count())
end

-- args: { stage, fixtures = [{ fid, name, type, mode, patch?, parent? }] }. parent is the FID of a grouping fixture,
-- in the show or earlier in the batch. Overlaps inside the batch are the caller's job: CheckFIDCollision and
-- CheckDMXCollision only see the committed patch.
ops["patch.add"] = function(args)
	local stageName = checkName(args.stage, "stage")
	if type(args.fixtures) ~= "table" or #args.fixtures == 0 then fail("bad-args", "fixtures must be a non-empty array") end
	guardIdle()

	local live = ShowData().LivePatch
	if not live.Stages[stageName] then fail("not-found", "no stage '" .. stageName .. "'") end
	local seen = {}
	for _, f in ipairs(args.fixtures) do
		local fid = math.tointeger(f.fid)
		if not fid or fid < 1 then fail("bad-args", "fid must be a positive integer") end
		if seen[fid] then fail("conflict", "FID " .. fid .. " appears twice in the batch") end
		seen[fid] = true
		local ft = live.FixtureTypes[checkName(f.type, "type")]
		if not ft then fail("not-found", "fixture type '" .. f.type .. "' is not in the show") end
		local mode = ft.DMXModes[checkName(f.mode, "mode")]
		if not mode then fail("not-found", "fixture type '" .. f.type .. "' has no mode '" .. f.mode .. "'") end
		if not CheckFIDCollision(fid, 1) then fail("conflict", "FID " .. fid .. " is already used") end
		if f.patch ~= nil and not CheckDMXCollision(mode, f.patch, 1) then fail("conflict", "DMX " .. f.patch .. " overlaps patched channels (FID " .. fid .. ")") end
		if f.parent ~= nil and not seen[math.tointeger(f.parent)] and not findFixture(live, f.parent) then
			fail("not-found", "parent FID " .. tostring(f.parent) .. " is neither in the show nor earlier in the batch")
		end
	end

	local backup = backupLivePatch("patch-add")
	enterPatchEdit(stageName)
	local edit = ShowData().Patch
	local okAll, err = pcall(function()
		for _, f in ipairs(args.fixtures) do
			local spec = { mode = edit.FixtureTypes[f.type].DMXModes[f.mode], amount = 1, fid = tostring(math.tointeger(f.fid)), name = f.name }
			if f.patch ~= nil then spec.patch = { f.patch } end
			if f.parent ~= nil then
				spec.parent = findFixture(edit, f.parent)
				if not spec.parent then fail("add-failed", "parent FID " .. tostring(f.parent) .. " not found in the edit copy") end
			end
			if not AddFixtures(spec) then fail("add-failed", "AddFixtures failed for FID " .. spec.fid) end
		end
	end)
	if not okAll then
		-- Undo our additions in the edit copy so the commit that leaves it changes nothing.
		local doomed = {}
		eachFixture(edit, function(f, _, holder, index)
			local fid = tonumber(display(f, "FID"))
			if fid and seen[fid] then table.insert(doomed, 1, { holder, index }) end -- deepest and last first
		end)
		for _, d in ipairs(doomed) do pcall(d[1].Delete, d[1], d[2]) end
		commitPatchEdit()
		error(err, 0)
	end
	commitPatchEdit()

	-- The commit replaces the LivePatch object, so handles taken before it are stale. From here on the change
	-- is in: a failing read-back must be reported as "committed, not verified", never as an error.
	local okRead, readBack = pcall(function()
		local byFid = {}
		eachFixture(ShowData().LivePatch, function(f, stage, _, _, parentFid)
			local fid = tonumber(display(f, "FID"))
			if fid and seen[fid] then byFid[fid] = fixtureRow(f, stage, parentFid) end
		end)
		local results, verified = {}, true
		for i, f in ipairs(args.fixtures) do
			local row = byFid[math.tointeger(f.fid)]
			local match = row ~= nil and row.type == f.type and row.mode == f.mode and row.patch == f.patch and not row.conflicted
				and (f.parent == nil or tonumber(row.parent) == math.tointeger(f.parent))
			verified = verified and match
			results[i] = { fid = f.fid, ok = match, actual = row }
		end
		return { verified = verified, results = results }
	end)
	if not okRead then
		return { backup = backup, committed = true, verified = false, results = {}, verifyError = tostring(type(readBack) == "table" and readBack.message or readBack) }
	end
	return { backup = backup, committed = true, verified = readBack.verified, results = readBack.results }
end

---------------------------------------------------------------------------
-- Changing existing fixtures
---------------------------------------------------------------------------

-- Inside the edit copy, absolute ChangeDestination paths resolve relative to the current destination and
-- "ChangeDestination Root" commits, so climb with ".." to get back to the patch root.
local function upToPatch()
	for _ = 1, 5 do
		local dest = destination()
		if dest == "ShowData.Patch" then return end
		CmdIndirect("ChangeDestination ..")
		local t0 = socket.gettime()
		repeat
			coroutine.yield(0.05)
		until destination() ~= dest or socket.gettime() - t0 > 3
	end
	fail("timeout", "could not get back to the patch root (now at " .. tostring(destination()) .. ")")
end

local function enterStage(stageName)
	upToPatch()
	CmdIndirect(string.format('ChangeDestination "Stages"."%s"."Fixtures"', stageName))
	waitDestination(stageName .. ".Fixtures")
end

-- Groups, cues, presets, layouts and worlds store fixtures as IDType="0" ID="<fid>" in their exported XML (the Lua tree
-- does not expose it), so export each object to a temp file and scan it. args: { fids = [...] }
ops["patch.usage"] = function(args)
	if type(args.fids) ~= "table" or #args.fids == 0 then fail("bad-args", "fids must be a non-empty array") end
	local wanted, usage = {}, {}
	for _, fid in ipairs(args.fids) do
		wanted[tostring(math.tointeger(fid))] = true
		usage[tostring(math.tointeger(fid))] = {}
	end
	local sep = GetPathSeparator()
	local dir, file = GetPath(Enums.PathType.Temp), "grandmcp_usage.xml"
	local pools = { { "Group", DataPool().Groups }, { "Sequence", DataPool().Sequences }, { "Layout", DataPool().Layouts }, { "World", DataPool().Worlds } }
	for _, presetPool in ipairs(DataPool().PresetPools:Children()) do
		pools[#pools + 1] = { "Preset " .. (tostring(display(presetPool, "No")):match("^%d+") or "?") .. ".", presetPool }
	end
	local scanned = 0
	for _, pool in ipairs(pools) do
		local label, holder = pool[1], pool[2]
		for _, obj in ipairs(holder and holder:Children() or {}) do
			if obj:Export(dir, file) then
				local f = io.open(dir .. sep .. file, "r")
				local xml = f and f:read("a") or ""
				if f then f:close() end
				local found = {}
				for id in xml:gmatch('IDType="0" ID="(%d+)"') do
					if wanted[id] and not found[id] then
						found[id] = true
						local no = tostring(display(obj, "No") or ""):match("^%d+") or "?"
						table.insert(usage[id], string.format("%s%s%s '%s'", label, label:sub(-1) == "." and "" or " ", no, tostring(obj.name)))
					end
				end
			end
			scanned = scanned + 1
			if scanned % 25 == 0 then coroutine.yield() end
		end
	end
	os.remove(dir .. sep .. file)
	return { usage = usage, scanned = scanned }
end

-- args: { changes = [{ fid, remove?, newFid?, name?, patch? ("U.AAA" or "" to unpatch), type?, mode? }] }. The planner
-- guarantees a consistent final state (unique FIDs, no overlaps), so intermediate overlaps are fine.
-- Order: type/mode (Assign) -> FID/name/patch -> deletes. Everything before the deletes is reverted on failure.
ops["patch.change"] = function(args)
	if type(args.changes) ~= "table" or #args.changes == 0 then fail("bad-args", "changes must be a non-empty array") end
	guardIdle()
	local live = ShowData().LivePatch
	for _, c in ipairs(args.changes) do
		if not findFixture(live, c.fid) then fail("not-found", "no fixture with FID " .. tostring(c.fid)) end
		if c.type ~= nil or c.mode ~= nil then
			local ft = live.FixtureTypes[checkName(c.type, "type")]
			if not ft or not ft.DMXModes[checkName(c.mode, "mode")] then fail("not-found", "no mode '" .. tostring(c.mode) .. "' in type '" .. tostring(c.type) .. "'") end
		end
		if c.name ~= nil then checkName(c.name, "name") end
	end

	local backup = backupLivePatch("patch-change")
	enterPatchEdit(nil)
	local edit = ShowData().Patch
	local targets = {}
	for i, c in ipairs(args.changes) do
		local f, stageName, holder = findFixture(edit, c.fid)
		if c.type ~= nil and holder ~= edit.Stages[stageName].Fixtures then
			leavePatchEdit()
			fail("unsupported", "changing the type or mode of a fixture inside a grouping fixture is not supported yet (FID " .. tostring(c.fid) .. ")")
		end
		targets[i] = { change = c, fixture = f, stage = stageName, holder = holder }
	end

	local undo = {} -- functions that restore what was changed, newest last
	local okEdit, err = pcall(function()
		for _, t in ipairs(targets) do
			local c, f = t.change, t.fixture
			if not c.remove and c.type ~= nil then
				local oldType, oldMode = f:Get("FixtureType").name, f:Get("ModeDirect").name
				local oldPatch = display(f, "Patch") or ""
				local function assign(typeName, modeName)
					enterStage(t.stage)
					local index = indexIn(edit.Stages[t.stage].Fixtures, f)
					if not index then fail("change-failed", "lost track of FID " .. tostring(c.fid)) end
					CmdIndirect(string.format('Assign FixtureType "%s"."DMXModes"."%s" At %d', typeName, modeName, index))
					local t0 = socket.gettime()
					repeat
						coroutine.yield(0.05)
						if GetTopModal() ~= nil then failModal("a pop-up opened while changing the mode of FID " .. tostring(c.fid)) end
					until (f:Get("ModeDirect") and f:Get("ModeDirect").name == modeName and f:Get("FixtureType").name == typeName) or socket.gettime() - t0 > 5
					if f:Get("ModeDirect").name ~= modeName then fail("change-failed", "MA did not change FID " .. tostring(c.fid) .. " to " .. typeName .. " / " .. modeName) end
				end
				assign(c.type, c.mode)
				undo[#undo + 1] = function()
					assign(oldType, oldMode)
					f:Set("Patch", oldPatch)
				end
				upToPatch()
			end
		end
		for _, t in ipairs(targets) do
			local c, f = t.change, t.fixture
			if not c.remove then
				for _, field in ipairs({ { "newFid", "FID" }, { "name", "Name" }, { "patch", "Patch" } }) do
					local value = c[field[1]]
					if value ~= nil then
						local old = display(f, field[2]) or ""
						f:Set(field[2], tostring(value))
						undo[#undo + 1] = function() f:Set(field[2], old) end
					end
				end
			end
		end
	end)
	if not okEdit then
		for i = #undo, 1, -1 do pcall(undo[i]) end
		leavePatchEdit()
		error(err, 0)
	end

	local okDelete, deleteErr = pcall(function()
		for _, t in ipairs(targets) do
			if t.change.remove then
				local holder = t.holder
				local index = indexIn(holder, t.fixture)
				if not index then fail("change-failed", "lost track of FID " .. tostring(t.change.fid) .. " before deleting it") end
				holder:Delete(index)
			end
		end
	end)
	commitPatchEdit()
	if not okDelete then
		fail("partial", "changes were committed but a delete failed (" .. tostring(type(deleteErr) == "table" and deleteErr.message or deleteErr) .. "). Backup: " .. backup)
	end

	local okRead, readBack = pcall(function()
		local current = ShowData().LivePatch
		local results, verified = {}, true
		for i, t in ipairs(targets) do
			local c = t.change
			local row, ok
			if c.remove then
				ok = findFixture(current, c.fid) == nil
			else
				local f, stageName = findFixture(current, c.newFid or c.fid)
				row = f and fixtureRow(f, stageName)
				ok = row ~= nil
					and (c.name == nil or row.name == c.name)
					and (c.patch == nil or (row.patch or "") == c.patch)
					and (c.type == nil or (row.type == c.type and row.mode == c.mode))
					and not row.conflicted
			end
			verified = verified and ok
			results[i] = { fid = c.fid, ok = ok, actual = row }
		end
		return { verified = verified, results = results }
	end)
	if not okRead then
		return { backup = backup, committed = true, verified = false, results = {}, verifyError = tostring(type(readBack) == "table" and readBack.message or readBack) }
	end
	return { backup = backup, committed = true, verified = readBack.verified, results = readBack.results }
end

---------------------------------------------------------------------------
-- Moving fixtures under a grouping fixture (or back to the top level). MA does this with Cut/Paste in the patch and
-- asks on the console whether to keep the absolute 3D position or the offset relative to the parent. That question
-- belongs to the user: patch.move stops and reports it, the user answers on the console, patch.moveFinish completes.
---------------------------------------------------------------------------

local pendingMove -- { stage, fids, parent, backup }

local function waitDestinationChange(from, timeout)
	local t0 = socket.gettime()
	repeat
		coroutine.yield(0.05)
		if GetTopModal() ~= nil then failModal("a pop-up opened while navigating the patch") end
	until destination() ~= from or socket.gettime() - t0 > (timeout or 3)
	if destination() == from then fail("timeout", "the command line did not leave " .. tostring(from)) end
end

-- Where each FID sits in a patch object: the parent FID, or false for the top level.
local function parentsOf(patchObj, fids)
	local wanted, out = {}, {}
	for _, fid in ipairs(fids) do wanted[tostring(fid)] = true end
	eachFixture(patchObj, function(f, _, _, _, parentFid)
		local fid = display(f, "FID")
		if wanted[fid] then out[fid] = parentFid or false end
	end)
	return out
end

local function movedAll(patchObj, fids, parent)
	local where = parentsOf(patchObj, fids)
	for _, fid in ipairs(fids) do
		local p = where[tostring(fid)]
		if p == nil or (parent and p ~= tostring(parent)) or (not parent and p ~= false) then return false end
	end
	return true
end

local function finishMove(move)
	pendingMove = nil
	leavePatchEdit()
	local where = parentsOf(ShowData().LivePatch, move.fids)
	local results, verified = {}, true
	for i, fid in ipairs(move.fids) do
		local p = where[tostring(fid)]
		local ok = (move.parent and p == tostring(move.parent)) or (not move.parent and p == false)
		verified = verified and ok
		results[i] = { fid = fid, ok = ok, parent = p or nil }
	end
	return { pending = false, moved = verified, backup = move.backup, results = results }
end

-- args: { fids = [...], parent = <grouping fixture FID> or nil for the stage's top level }
ops["patch.move"] = function(args)
	if type(args.fids) ~= "table" or #args.fids == 0 then fail("bad-args", "fids must be a non-empty array") end
	if pendingMove then fail("busy", "a move is waiting for an answer on the console; call patch.moveFinish first") end
	guardIdle()
	local live = ShowData().LivePatch
	local parent = args.parent ~= nil and math.tointeger(args.parent) or nil

	local stage, sourceParent
	local fids = {}
	for i, value in ipairs(args.fids) do
		local fid = math.tointeger(value)
		local f, stageName = findFixture(live, fid)
		if not f then fail("not-found", "no fixture with FID " .. tostring(value)) end
		if fid == parent then fail("bad-args", "FID " .. fid .. " cannot be moved into itself") end
		local children = childCounts(f)
		if children > 0 then fail("unsupported", "FID " .. fid .. " holds other fixtures; grouping fixtures cannot be nested") end
		local p = parentsOf(live, { fid })[tostring(fid)]
		if i == 1 then
			stage, sourceParent = stageName, p
		elseif stageName ~= stage or p ~= sourceParent then
			fail("bad-args", "all fixtures must currently sit in the same place (same stage and parent)")
		end
		fids[i] = fid
	end
	if (parent and sourceParent == tostring(parent)) or (not parent and sourceParent == false) then
		fail("bad-args", "the fixtures are already there")
	end
	if parent then
		local target, targetStage = findFixture(live, parent)
		if not target or targetStage ~= stage then fail("not-found", "no grouping fixture with FID " .. parent .. " on stage " .. stage) end
		if parentsOf(live, { parent })[tostring(parent)] ~= false then fail("unsupported", "FID " .. parent .. " is inside another grouping fixture") end
		local mode = target:Get("ModeDirect")
		if not mode or tonumber(display(mode, "TotalFootprint")) ~= 0 then fail("bad-args", "FID " .. parent .. " is not a grouping fixture") end
	end

	local backup = backupLivePatch("patch-move")
	enterPatchEdit(stage)
	local stageDest = stage .. ".Fixtures"
	local ok, err = pcall(function()
		local edit = ShowData().Patch
		local stageHolder = edit.Stages[stage].Fixtures
		local sourceHolder = stageHolder
		if sourceParent then
			local sp = findFixture(edit, sourceParent)
			sourceHolder = sp
			CmdIndirect("ChangeDestination " .. indexIn(stageHolder, sp))
			waitDestinationChange(stageDest)
		end
		local positions = {}
		for _, fid in ipairs(fids) do
			local f = findFixture(edit, fid)
			positions[#positions + 1] = tostring(indexIn(sourceHolder, f))
		end
		CmdIndirect("Cut " .. table.concat(positions, " + "))
		coroutine.yield(0.2)
		if sourceParent then
			local here = destination()
			CmdIndirect("ChangeDestination ..")
			waitDestinationChange(here)
		end
		local targetHolder = stageHolder
		if parent then
			targetHolder = findFixture(edit, parent)
			CmdIndirect("ChangeDestination " .. indexIn(stageHolder, targetHolder))
			waitDestinationChange(stageDest)
		end
		CmdIndirect("Paste " .. (targetHolder:Count() + 1))
	end)
	if not ok then
		-- Everything before the paste only marks fixtures (Cut), so leaving the edit copy changes nothing.
		leavePatchEdit()
		error(err, 0)
	end

	local move = { stage = stage, fids = fids, parent = parent, from = sourceParent, backup = backup }
	local t0 = socket.gettime()
	repeat
		coroutine.yield(0.1)
		if GetTopModal() ~= nil then
			pendingMove = move
			return { pending = true, dialog = describeModal(GetTopModal()), backup = backup }
		end
	until movedAll(ShowData().Patch, fids, parent) or socket.gettime() - t0 > 3
	return finishMove(move)
end

-- Completes a move after the user answered MA's question on the console. args: { cancel = true } undoes a move the
-- user no longer wants (only possible once the pop-up is closed).
ops["patch.moveFinish"] = function(args)
	local move = pendingMove
	if not move then fail("not-found", "no move is waiting") end
	if GetTopModal() ~= nil then
		return { pending = true, dialog = describeModal(GetTopModal()), backup = move.backup }
	end
	if destination() == "Root" then
		-- Someone left the patch edit already; report what the live patch looks like.
		pendingMove = nil
		local result = finishMove(move)
		result.note = "the patch edit was closed on the console before finishing"
		return result
	end
	if movedAll(ShowData().Patch, move.fids, move.parent) then
		if args.cancel then
			-- Oops undoes the last action on the console: right after the paste that is the paste, but verify.
			CmdIndirect("Oops")
			coroutine.yield(0.5)
			local back = parentsOf(ShowData().Patch, move.fids)
			for _, fid in ipairs(move.fids) do
				if back[tostring(fid)] ~= move.from then
					fail("cancel-failed", "Oops did not move the fixtures back; the patch edit is still open. Discard it in the Patch menu on the console.")
				end
			end
			local result = finishMove(move)
			result.cancelled = true
			return result
		end
		return finishMove(move)
	end
	-- Pop-up answered with Cancel: nothing moved.
	local result = finishMove(move)
	result.cancelled = true
	return result
end

---------------------------------------------------------------------------
-- Groups (selection groups in the current data pool). Read and written as MA's own XML, so the user's
-- programmer and selection are never touched.
---------------------------------------------------------------------------

local function exportText(obj)
	local sep = GetPathSeparator()
	local dir, file = GetPath(Enums.PathType.Temp), "grandmcp_export.xml"
	if not obj:Export(dir, file) then return nil end
	local f = io.open(dir .. sep .. file, "r")
	local text = f and f:read("a")
	if f then f:close() end
	os.remove(dir .. sep .. file)
	return text
end

local function groupInfo(g)
	local text = exportText(g) or ""
	local fids, other = {}, 0
	for idType, id in text:gmatch('<Item IDType="(%d+)" ID="(%d+)"') do
		if idType == "0" then fids[#fids + 1] = tonumber(id) else other = other + 1 end
	end
	return { no = tonumber(tostring(display(g, "No")):match("^%d+")), name = g.name, fids = fids, otherIds = other }
end

local function xmlEscape(s)
	return (tostring(s):gsub("&", "&amp;"):gsub("<", "&lt;"):gsub(">", "&gt;"):gsub('"', "&quot;"))
end

local function groupNo(value)
	local no = math.tointeger(value)
	if not no or no < 1 or no > 9999 then fail("bad-args", "group number must be 1-9999") end
	return no
end

local function backupGroup(g, no)
	local sep = GetPathSeparator()
	local dir = GetPath(Enums.PathType.Library) .. sep .. "datapools" .. sep .. "groups"
	CreateDirectoryRecursive(dir)
	local file = string.format("grandmcp-backup-%s-group%d.xml", os.date("%Y%m%d-%H%M%S"), no)
	if not g:Export(dir, file) then fail("backup-failed", "could not export group " .. no) end
	return dir .. sep .. file
end

ops["group.list"] = function()
	local out = {}
	for i, g in ipairs(DataPool().Groups:Children()) do
		out[#out + 1] = groupInfo(g)
		if i % 25 == 0 then coroutine.yield() end
	end
	return out
end

-- args: { no, name, fids, overwrite }. Creates or replaces the group at pool number `no` with exactly these fixtures.
ops["group.store"] = function(args)
	local no = groupNo(args.no)
	local name = args.name -- written as escaped XML, so quotes are fine here
	if type(name) ~= "string" or name == "" or #name > 200 then fail("bad-args", "name must be a non-empty string") end
	if type(args.fids) ~= "table" or #args.fids == 0 then fail("bad-args", "fids must be a non-empty array") end
	local groups = DataPool().Groups
	local existing = groups[no]
	if existing and not args.overwrite then
		fail("exists", string.format("group %d already exists ('%s'); pass overwrite to replace it", no, tostring(existing.name)))
	end
	local backup = existing and backupGroup(existing, no) or nil

	local items = {}
	for i, fid in ipairs(args.fids) do
		local id = math.tointeger(fid)
		if not id or id < 1 then fail("bad-args", "fids must be positive integers") end
		items[i] = string.format('            <Item IDType="0" ID="%d" X="%d" Y="0" Z="0"/>', id, i - 1)
	end
	local xml = table.concat({
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<GMA3 DataVersion="' .. xmlEscape(BuildDetails().BigVersion) .. '">',
		'    <Group Name="' .. xmlEscape(name) .. '">',
		'        <SelectionData Size="' .. #items .. '">',
		table.concat(items, "\n"),
		"        </SelectionData>",
		"    </Group>",
		"</GMA3>",
	}, "\n")
	local sep = GetPathSeparator()
	local dir, file = GetPath(Enums.PathType.Temp), "grandmcp_group.xml"
	local f = io.open(dir .. sep .. file, "w")
	if not f then fail("write-failed", "cannot write " .. dir .. sep .. file) end
	f:write(xml)
	f:close()

	local g = existing or groups:Create(no)
	local ok, imported = pcall(g.Import, g, dir .. sep, file)
	os.remove(dir .. sep .. file)
	if not ok or not imported then fail("import-failed", "MA could not import the group" .. (ok and "" or (": " .. tostring(imported)))) end
	local info = groupInfo(groups[no])
	info.backup = backup
	return info
end

-- args: { no }
ops["group.delete"] = function(args)
	local no = groupNo(args.no)
	guardIdle()
	local g = DataPool().Groups[no]
	if not g then fail("not-found", "no group " .. no) end
	local backup = backupGroup(g, no)
	CmdIndirect(string.format("Delete Group %d /NoConfirmation", no))
	local t0 = socket.gettime()
	repeat
		coroutine.yield(0.05)
		if GetTopModal() ~= nil then failModal("a pop-up opened while deleting group " .. no) end
	until DataPool().Groups[no] == nil or socket.gettime() - t0 > 5
	if DataPool().Groups[no] ~= nil then fail("delete-failed", "group " .. no .. " still exists") end
	return { no = no, backup = backup }
end

-- Probe ops for development; disabled unless started with "dev".
ops.cmd = function(args)
	requireDev()
	if type(args.command) ~= "string" then fail("bad-args", "command must be a string") end
	if GetTopModal() ~= nil then failModal("a pop-up is open on the console") end
	return { feedback = Cmd(args.command) }
end

ops.lua = function(args)
	requireDev()
	if type(args.code) ~= "string" then fail("bad-args", "code must be a string") end
	local env = setmetatable({}, { __index = _G })
	local chunk, err = load("return " .. args.code, "=probe", "t", env)
	if not chunk then chunk, err = load(args.code, "=probe", "t", env) end
	if not chunk then fail("lua-syntax", err) end
	local results = table.pack(chunk())
	local out = {}
	for i = 1, results.n do out[i] = sanitize(results[i]) end
	return out
end

---------------------------------------------------------------------------
-- Transport
---------------------------------------------------------------------------

local function sendAll(cl, data)
	local i, tries = 1, 0
	while i <= #data do
		local last, err, partialLast = cl.sock:send(data, i)
		if last then
			i = last + 1
		elseif err == "timeout" then
			i = (partialLast or (i - 1)) + 1
			tries = tries + 1
			if tries > 2000 then return false end
			coroutine.yield()
		else
			return false
		end
	end
	return true
end

local function reply(cl, response)
	local ok, encoded = pcall(json.encode, sanitize(response))
	if not ok then
		encoded = json.encode({ id = sanitize(response.id), ok = false, code = "encode-error", error = tostring(encoded) })
	end
	if not sendAll(cl, encoded .. "\n") then cl.dead = true end
end

local function onError(e)
	if type(e) == "table" and e.code then return e end
	return { code = "lua-error", message = tostring(e), traceback = debug.traceback("", 2) }
end

local function handleLine(cl, line)
	local okDecode, req = pcall(json.decode, line)
	if not okDecode or type(req) ~= "table" then
		return reply(cl, { ok = false, code = "bad-request", error = "invalid JSON request" })
	end
	local op = ops[req.op]
	if not op then
		return reply(cl, { id = req.id, ok = false, code = "unknown-op", error = "unknown op '" .. tostring(req.op) .. "'" })
	end
	local args = type(req.args) == "table" and req.args or {}
	local ok, result = xpcall(op, onError, args)
	if ok then
		reply(cl, { id = req.id, ok = true, result = result })
	else
		reply(cl, { id = req.id, ok = false, code = result.code, error = tostring(result.message), detail = result.detail, traceback = result.traceback })
	end
end

local function serviceClient(cl)
	for _ = 1, MAX_LINES_PER_TICK do
		local line, err, partial = cl.sock:receive("*l")
		if line then
			local full = cl.buf .. line
			cl.buf = ""
			handleLine(cl, full)
			if cl.dead then return end
		elseif err == "timeout" then
			cl.buf = cl.buf .. (partial or "")
			if #cl.buf > MAX_LINE_BYTES then cl.dead = true end
			return
		else
			cl.dead = true
			return
		end
	end
end

local function stopListening(inst)
	if inst.server then pcall(function() inst.server:close() end) end
	inst.server = nil
	inst.stopRequested = true
	if shared.current == inst then shared.current = nil end
end

local function closeInstance(inst)
	stopListening(inst)
	for _, cl in ipairs(inst.clients) do pcall(function() cl.sock:close() end) end
	inst.clients = {}
end

local function isAlive(inst)
	return inst.server ~= nil and not inst.stopRequested and socket.gettime() - inst.lastTick <= STALE_AFTER_S
end

local function serve(dev)
	local server, err = socket.bind(HOST, PORT)
	if not server then
		ErrPrintf("grandmcp: cannot listen on %s:%d (%s)", HOST, PORT, tostring(err))
		return
	end
	server:settimeout(0)
	local inst = { server = server, clients = {}, dev = dev, stopRequested = false, lastTick = socket.gettime() }
	mine = inst
	shared.current = inst
	Printf("grandmcp %s listening on %s:%d%s", VERSION, HOST, PORT, dev and " (dev ops enabled)" or "")

	local ok, loopErr = xpcall(function()
		while not inst.stopRequested do
			inst.lastTick = socket.gettime()
			local c = inst.server and inst.server:accept()
			if c then
				c:settimeout(0)
				pcall(function() c:setoption("tcp-nodelay", true) end)
				table.insert(inst.clients, { sock = c, buf = "" })
			end
			for i = #inst.clients, 1, -1 do
				local cl = inst.clients[i]
				serviceClient(cl)
				if cl.dead then
					pcall(function() cl.sock:close() end)
					table.remove(inst.clients, i)
				end
			end
			coroutine.yield()
		end
	end, debug.traceback)
	if not ok then ErrPrintf("grandmcp: loop crashed: %s", tostring(loopErr)) end
	closeInstance(inst)
	Printf("grandmcp stopped")
end

-- Dev: re-import this plugin from gma3_library/datapools/plugins and restart it, all queued on the
-- main task so it runs after this reply is sent.
ops.reload = function()
	requireDev()
	local plugin = myHandle and myHandle:Parent()
	local slot = plugin and tonumber(tostring(plugin:Get("No", Enums.Roles.Display)):match("^%d+"))
	if not slot then fail("not-found", "cannot find this plugin's pool slot") end
	stopListening(shared.current)
	CmdIndirect(string.format("Delete Plugin %d /NoConfirmation", slot))
	CmdIndirect(string.format('Import Plugin Library "grandmcp.xml" At Plugin %d', slot))
	CmdIndirect(string.format('Plugin %d "dev"', slot))
	return { slot = slot, reloading = true }
end

---------------------------------------------------------------------------
-- Plugin entry points
---------------------------------------------------------------------------

local function statusLine(inst)
	if not inst then return string.format("grandmcp %s: stopped", VERSION) end
	return string.format("grandmcp %s: running on %s:%d, %d client(s), dev ops %s", VERSION, HOST, PORT, #inst.clients, inst.dev and "on" or "off")
end

local function Main(_, argument)
	local arg = string.lower(tostring(argument or "")):match("^%s*(.-)%s*$")
	local current = shared.current
	-- A loop that stopped ticking without a Cleanup (e.g. a crash) is treated as gone.
	if current and not isAlive(current) then
		closeInstance(current)
		current = nil
	end

	if current or arg == "stop" or arg == "status" then
		pendingControlCleanups = pendingControlCleanups + 1 -- this call's Cleanup must not stop the server
		if not current then
			Printf("%s", statusLine(nil))
		elseif arg == "stop" then
			current.stopRequested = true
			Printf("grandmcp: stopping")
		elseif arg == "dev" or arg == "dev on" then
			current.dev = true
			Printf("grandmcp: dev ops on")
		elseif arg == "dev off" then
			current.dev = false
			Printf("grandmcp: dev ops off")
		else
			Printf("%s", statusLine(current))
		end
		return
	end
	serve(arg == "dev" or arg == "dev on")
end

local function Cleanup()
	if pendingControlCleanups > 0 then
		pendingControlCleanups = pendingControlCleanups - 1
		return
	end
	if mine then closeInstance(mine) end
end

return Main, Cleanup
