-- Just enough of the engine for Anim.build: instances that hold children, a
-- KeyframeSequenceProvider that records what it was asked to register, and the
-- three helper modules Anim.luau requires.
local registered = {}
local dataOf = {}

local function make(class)
	local data = { ClassName = class, Name = class, Time = 0, Weight = 0, Loop = false, kids = {}, destroyed = false }
	local self
	local methods = {}
	function methods.GetChildren()
		return data.kids
	end
	function methods.GetKeyframes()
		local list = {}
		for _, kid in data.kids do
			if kid.ClassName == "Keyframe" then
				table.insert(list, kid)
			end
		end
		return list
	end
	function methods.Destroy()
		data.destroyed = true
	end
	function methods.Clone()
		local copy = make(class)
		local copyData = dataOf[copy]
		for key, value in data do
			if key ~= "kids" and key ~= "Parent" and key ~= "destroyed" then
				copyData[key] = value
			end
		end
		for _, kid in data.kids do
			kid:Clone().Parent = copy
		end
		return copy
	end
	self = setmetatable({}, {
		__index = function(_, key)
			if methods[key] then
				return function(_, ...)
					return methods[key](...)
				end
			end
			return data[key]
		end,
		__newindex = function(_, key, value)
			if key == "Parent" then
				data.Parent = value
				if value ~= nil then
					table.insert(dataOf[value].kids, self)
				end
			else
				data[key] = value
			end
		end,
	})
	dataOf[self] = data
	return self
end

local Instance = {
	new = function(class)
		return make(class)
	end,
}
-- Only `Anim.play`'s `prepare` callback reaches this: it clones Paths and
-- Dispatch onto the relay the same way Exec.luau's client path clones its
-- own dependencies. `make(...)` objects already have `:Clone()`, so no
-- separate stand-in type is needed.
local script = {
	Parent = {
		Parent = {
			Paths = make("Paths"),
			Dispatch = make("Dispatch"),
		},
	},
}
CFrame = { new = function() return "identity" end }
Enum = { AnimationPriority = {} }

local KeyframeSequenceProvider = {
	RegisterKeyframeSequence = function(_, sequence)
		-- Snapshot the times now: `build` destroys the sequence after registering.
		local times = {}
		for _, frame in sequence:GetKeyframes() do
			table.insert(times, frame.Time)
		end
		table.sort(times)
		table.insert(registered, { sequence = sequence, times = times })
		return string.rep("a", 31) .. tostring(#registered)
	end,
}
local game = {
	GetService = function()
		return KeyframeSequenceProvider
	end,
}

-- Rigs a test registers by path: `joints` is a list of { part0, part1 } names,
-- each a Motor6D in the model; `primary` names its PrimaryPart.
local rigs = {}
local function defineRig(path, joints, primary)
	local motors = {}
	for _, pair in joints do
		table.insert(motors, {
			IsA = function(_, class) return class == "Motor6D" end,
			Part0 = { Name = pair[1] },
			Part1 = { Name = pair[2] },
		})
	end
	rigs[path] = {
		GetDescendants = function() return motors end,
		PrimaryPart = if primary then { Name = primary } else nil,
	}
end

local Paths = {
	resolve = function(path)
		if rigs[path] ~= nil then
			return rigs[path]
		end
		return make("Folder")
	end,
	of = function(instance)
		return "Workspace.Rig." .. instance.Name
	end,
}
local Serialize = {
	parse = function(text)
		return true, "cf:" .. text, nil
	end,
	value = function(v)
		return v
	end,
}
local Undo = {
	record = function(_, _, body)
		return body(), true
	end,
}

-- Records exactly what `Anim.play` hands the relay, the same way
-- exec-client-stub.luau does for Exec.run's client path: `play` is not the
-- subject here, what it is CALLED with is. The test sets `nextRelayAnswer`
-- to script what the (fake) client reports back.
local relayCalls = {}
local nextRelayAnswer = nil
local ClientRelay = {
	playerFor = function(name)
		return { Name = name or "Player1" }
	end,
	run = function(player, name, source, attributes, timeout, prepare)
		local relay = make("LocalScript")
		if prepare then
			prepare(relay)
		end
		table.insert(relayCalls, {
			player = player,
			name = name,
			source = source,
			attributes = attributes,
			timeout = timeout,
			relay = relay,
		})
		return nextRelayAnswer or { ok = true, animationId = "session-hash", length = 1, looped = false, priority = "Action" }
	end,
}
