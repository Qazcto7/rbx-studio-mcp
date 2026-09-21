-- Enough of the engine and of ClientRelay to drive Exec.run's client path and see
-- exactly what it hands the relay. ClientRelay is not the subject here; what it is
-- CALLED with is, because this is where `settle` went missing once: the variable
-- was used in the call and never declared, so every target="client" run failed
-- before reaching the player.
local calls = {}
local ClientRelay = {
	playerFor = function(name)
		return { Name = name or "Player1" }
	end,
	run = function(player, name, source, attributes, timeout, prepare)
		table.insert(calls, {
			player = player,
			name = name,
			source = source,
			attributes = attributes,
			timeout = timeout,
			prepare = prepare,
		})
		return { ok = true }
	end,
}
local Runtime = { run = function() return { ok = true } end }

local game = { GetService = function() return {} end }
-- Setting `.Parent` on one of these appends it to the parent's `children`, which
-- is how the real engine makes `copy.Parent = relay` visible on the relay.
local function node(fields)
	return setmetatable({}, {
		__index = fields,
		__newindex = function(_, key, value)
			if key == "Parent" then
				table.insert(value.children, fields)
			end
			fields[key] = value
		end,
	})
end
local function clonable(label)
	return {
		Clone = function()
			return node({ label = label, ClassName = "Cloned" })
		end,
	}
end
local script = {
	Parent = {
		Parent = {
			ExecRuntime = clonable("ExecRuntime"),
			Serialize = clonable("Serialize"),
			Paths = clonable("Paths"),
			Dispatch = clonable("Dispatch"),
		},
	},
}
local Instance = {
	new = function(class)
		return node({ ClassName = class })
	end,
}
