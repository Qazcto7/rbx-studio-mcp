-- Enough of the engine and of ClientRelay to drive Input.send and see what it
-- hands the relay. The relay is not the subject (scripts/test-input-relay.mjs
-- runs that); the subject is what the server side remembers BETWEEN calls:
-- which buttons an earlier `press` deliberately left down, so the next relay
-- does not release them up front and call a requested hold "stuck".
local relayCalls = {}
-- What the next ClientRelay.run answers, as the client would report it.
local nextRelayAnswer: { [string]: any } = { ok = true }

-- One table per player name, like a Player instance; `newPlaytest` replaces
-- them, the way a new playtest makes new Player objects.
local players = {}
local function newPlaytest()
	players = {}
end

local ClientRelay = {
	playerFor = function(name)
		local key = name or "Player1"
		players[key] = players[key] or { Name = key }
		return players[key]
	end,
	run = function(player, name, source, attributes, timeout)
		table.insert(relayCalls, { player = player, name = name, attributes = attributes, timeout = timeout })
		return nextRelayAnswer
	end,
}

local Emulation = { summary = function() return nil end }

-- Just enough JSON for a list of names; anything else only has to be a string.
local function encode(value)
	if typeof(value) ~= "table" then
		return tostring(value)
	end
	local parts = {}
	for _, item in value do
		if typeof(item) ~= "string" then
			return "<json>"
		end
		table.insert(parts, '"' .. item .. '"')
	end
	return "[" .. table.concat(parts, ",") .. "]"
end

local services = {
	HttpService = { JSONEncode = function(_, value) return encode(value) end },
	RunService = { IsRunning = function() return true end },
}
local game = { GetService = function(_, name) return services[name] end }

local function names(prefix)
	return setmetatable({}, { __index = function(_, key) return prefix .. "." .. key end })
end
local Enum = { KeyCode = names("KeyCode"), UserInputType = names("UserInputType") }
