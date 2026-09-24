--!strict
--[[
	Animations, as data rather than as a timeline.

	An animation is the one part of a Roblox place this server could not see at
	all. `inspect` on an Animation instance returns an asset id and nothing else
	-- the poses live on Roblox's servers, and the only way to look at them was
	to open the Animation Editor and scrub, which an agent cannot do.

	`KeyframeSequenceProvider` hands the whole thing over as instances:
	`GetKeyframeSequenceAsync` downloads any animation as a KeyframeSequence, and
	`RegisterKeyframeSequence` goes the other way, turning one built in memory
	into a content id that plays. Measured against a live session: Roblox's own
	run animation came back as 16 keyframes, and a three-pose sequence built here
	registered and returned an id.

	What that makes possible is reading: "this animation is 0.8s long, it moves
	the right arm and nothing else, and the last keyframe does not return to the
	first" is a sentence nobody could get out of Studio without watching it
	frame by frame.

	Nothing here uploads. A registered sequence is local to the running Studio,
	which is the correct scope for a preview and useless as a way to publish --
	see the `publish` tool for that.
]]

local KeyframeSequenceProvider = game:GetService("KeyframeSequenceProvider")

local ClientRelay = require(script.Parent.Parent.ClientRelay)
local Dispatch = require(script.Parent.Parent.Dispatch)
local Paths = require(script.Parent.Parent.Paths)
local Serialize = require(script.Parent.Parent.Serialize)
local Undo = require(script.Parent.Parent.Undo)

local Anim = {}

--[[
	How far the second keyframe sits from the first when an animation would
	otherwise have no length.

	A KeyframeSequence whose keyframes are all at time 0 has `Length == 0`, and a
	track with no length cannot be previewed: `AnimationTrack.Length` never
	becomes non-zero, so `preview` waits out its full deadline and reports
	ANIMATION_TIMEOUT for an animation that loaded perfectly. Measured with a
	one-keyframe pose: every preview timed out; the same pose as two keyframes a
	tenth of a second apart previewed at once. A tenth is long enough to be
	unambiguously non-zero and short enough that a held pose looks like a held
	pose.
]]
local MIN_LENGTH = 0.1

--[[
	Keyframes returned in full detail before the listing thins out.

	A long animation is hundreds of keyframes and every one carries a pose per
	moving joint, so the honest full dump of a walk cycle is larger than the
	conversation it would appear in. Past this, times are still all reported --
	they are what the shape of an animation is made of -- and only the poses stop
	being expanded.
]]
local DETAIL_LIMIT = 40

--[[
	The asset id, however the caller wrote it.

	Ids reach this server as a number, as "rbxassetid://123", and as an
	Animation instance's path, because all three are what someone has in front
	of them at the time. Normalising here means the three do not each need their
	own branch further down.
]]
local function contentId(params: { [string]: any }): string
	local raw = params.assetId

	--[[
		A locally registered sequence, which looks like nothing else.

		`RegisterKeyframeSequence` returns a bare 32-character hash -- no scheme,
		no digits-only shape -- so the path branch below claimed it and reported
		"no instance at 37f2a7f5...". That made `build` and `read` unable to talk
		to each other, which is the first thing anyone would try.

		Checked before the path branch because a 32-character hex string is not a
		plausible instance path, and a path that happened to look like one would
		still be reachable by writing it with its parent.
	]]
	if typeof(raw) == "string" and #raw == 32 and string.match(raw, "^%x+$") ~= nil then
		return raw
	end

	if typeof(raw) == "string" and string.match(raw, "^%d+$") == nil and string.find(raw, "://") == nil then
		-- Not an id at all: a path to an Animation instance in the place.
		local instance = Paths.resolve(raw)
		if not instance:IsA("Animation") then
			Dispatch.fail(
				"BAD_PARAMS",
				string.format("%s is a %s, not an Animation.", raw, instance.ClassName),
				"Pass an animation asset id, or the path of an Animation instance."
			)
		end
		local id = (instance :: Animation).AnimationId
		if id == "" then
			Dispatch.fail("BAD_PARAMS", string.format("%s has no AnimationId set.", raw))
		end
		return id
	end

	local number = tonumber(raw)
	if number ~= nil then
		return string.format("rbxassetid://%d", math.floor(number))
	end

	if typeof(raw) == "string" and raw ~= "" then
		return raw
	end

	Dispatch.fail("BAD_PARAMS", "this needs an `assetId` -- a number, an rbxassetid:// string, or a path to an Animation.")
	return ""
end

--[[
	Every pose in a keyframe, flattened with its path through the rig.

	Poses nest the way the rig's joints do -- a Pose named "Left Arm" is a child
	of the Pose for the part it is jointed to -- and that structure is how the
	engine resolves them. It is not how a reader wants them: the question is
	"which joints does this animation move", and the answer is a flat list of
	names, with the nesting kept as a path so the rig is still legible.
]]
local function flatten(node: Instance, prefix: string, into: { { [string]: any } })
	for _, child in node:GetChildren() do
		if not child:IsA("Pose") then
			continue
		end
		local pose = child :: Pose
		local name = if prefix == "" then pose.Name else prefix .. "/" .. pose.Name
		table.insert(into, {
			joint = name,
			cframe = Serialize.value(pose.CFrame),
			weight = pose.Weight,
			easing = string.format(
				"%s %s",
				tostring(pose.EasingStyle):gsub("Enum%.PoseEasingStyle%.", ""),
				tostring(pose.EasingDirection):gsub("Enum%.PoseEasingDirection%.", "")
			),
		})
		flatten(pose, name, into)
	end
end

--[[
	Which joint hangs off which, for the two rigs Roblox ships.

	A KeyframeSequence is not a flat list of poses: the engine matches the POSE
	TREE against the rig's joint tree, and a pose whose parent does not join it
	in the rig is ignored -- silently, with no error and no movement. `build`
	used to parent every pose directly under the root, so an animation naming
	"Right Arm" produced an id that loaded, played, reported weight 1, and moved
	nothing at all. Measured on an R6 rig: Motor6D.Transform stayed identity
	through every frame.

	So poses have to be nested, and nesting needs to know the rig. Read off a
	real rig when one is named, and otherwise off these -- they are the standard
	characters and they do not change.
]]
local R6_PARENT: { [string]: string } = {
	Torso = "HumanoidRootPart",
	Head = "Torso",
	["Left Arm"] = "Torso",
	["Right Arm"] = "Torso",
	["Left Leg"] = "Torso",
	["Right Leg"] = "Torso",
}

local R15_PARENT: { [string]: string } = {
	LowerTorso = "HumanoidRootPart",
	UpperTorso = "LowerTorso",
	Head = "UpperTorso",
	LeftUpperArm = "UpperTorso",
	LeftLowerArm = "LeftUpperArm",
	LeftHand = "LeftLowerArm",
	RightUpperArm = "UpperTorso",
	RightLowerArm = "RightUpperArm",
	RightHand = "RightLowerArm",
	LeftUpperLeg = "LowerTorso",
	LeftLowerLeg = "LeftUpperLeg",
	LeftFoot = "LeftLowerLeg",
	RightUpperLeg = "LowerTorso",
	RightLowerLeg = "RightUpperLeg",
	RightFoot = "RightLowerLeg",
}

local R6_PARTS = {
	["Left Arm"] = true,
	["Right Arm"] = true,
	["Left Leg"] = true,
	["Right Leg"] = true,
	["Torso"] = true,
}

local R15_PARTS = {
	UpperTorso = true,
	LowerTorso = true,
	LeftUpperArm = true,
	RightUpperArm = true,
	LeftUpperLeg = true,
	RightUpperLeg = true,
	LeftLowerArm = true,
	RightLowerArm = true,
}

--[[
	Which rig an animation was made for, read off the joints it moves.

	This matters more than it sounds. An R15 animation played on an R6 character
	does nothing at all -- no error, no warning, no movement -- because the joint
	names it addresses ("LeftUpperArm") do not exist on that rig ("Left Arm").
	It is one of the quietest failures on the platform, and the asset id carries
	no hint of which kind it is.

	The two skeletons are told apart by naming rather than by counting. R6 uses
	six limbs with spaces in their names, unchanged since 2007. R15 splits each
	limb in two and writes them without spaces. Anything that matches neither is
	a custom rig, and is reported as such rather than guessed at -- a wrong
	confident answer here is worse than "unknown", because the whole point of
	the field is to be trusted.
]]
local function rigOf(joints: { [string]: boolean }): (string, string?)
	local r6, r15 = 0, 0
	for joint in joints do
		if R6_PARTS[joint] then
			r6 += 1
		elseif R15_PARTS[joint] then
			r15 += 1
		end
	end

	local rig = "custom"
	if r15 > 0 and r15 >= r6 then
		rig = "R15"
	elseif r6 > 0 then
		rig = "R6"
	end

	--[[
		A tool animation is not a third rig; it is an ordinary one that only
		moves the arm holding the tool. Roblox's own "toolnone" moves the right
		arm and the torso and nothing else, which is what this recognises --
		useful because such an animation looks broken when read as a character
		animation ("it only moves two joints") and is in fact complete.
	]]
	local arms = 0
	local others = 0
	for joint in joints do
		if string.find(joint, "Arm") ~= nil or string.find(joint, "Hand") ~= nil then
			arms += 1
		elseif joint ~= "HumanoidRootPart" and joint ~= "Torso" and joint ~= "UpperTorso" then
			others += 1
		end
	end
	local shape: string? = nil
	if arms > 0 and others == 0 then
		shape = "arm-only -- the shape of a tool or holding animation"
	end

	return rig, shape
end

--[[
	Downloads an animation and describes it.

	The summary is the point, not the dump. `duration`, which joints move at all,
	and whether the last keyframe matches the first are the three things that
	decide whether an animation is wrong, and none of them is visible from the
	asset id that `inspect` returns today.
]]
function Anim.read(params: { [string]: any }): { [string]: any }
	local id = contentId(params)

	local ok, sequence = pcall(function()
		return KeyframeSequenceProvider:GetKeyframeSequenceAsync(id)
	end)
	if not ok then
		Dispatch.fail(
			"ANIMATION_UNAVAILABLE",
			string.format("Could not read %s: %s", id, tostring(sequence)),
			"The animation must be public, or owned by the account signed into Studio."
		)
	end

	local sequenceInstance = sequence :: KeyframeSequence
	local keyframes = sequenceInstance:GetKeyframes()
	table.sort(keyframes, function(a, b)
		return (a :: Keyframe).Time < (b :: Keyframe).Time
	end)

	local joints: { [string]: boolean } = {}
	local rows: { { [string]: any } } = {}
	local duration = 0
	local firstValue: { [string]: string } = {}
	local lastValue: { [string]: string } = {}

	for index, frame in keyframes do
		local keyframe = frame :: Keyframe
		duration = math.max(duration, keyframe.Time)

		local poses: { { [string]: any } } = {}
		flatten(keyframe, "", poses)
		for _, pose in poses do
			--[[
				First and last value per joint, for the loop check below.

				Recorded as they are walked because keyframes are already in time
				order here, so "last seen" is the final value by the time the walk
				ends -- no second pass and no sorting.
			]]
			--[[
				Keyed by leaf name, never by the path it was found under.

				The same joint does not keep the same path across an animation.
				Measured on Roblox's own "toolnone": the right arm is nested under
				`HumanoidRootPart/Torso/Right Arm` in the first keyframe and under
				`Torso/Right Arm` in every keyframe after it -- same joint, same
				rig, two different strings. Keying on the path therefore split one
				joint into two, and each half looked like it had no matching end
				value, so a perfectly clean loop was reported as drifting on two
				joints. The values themselves were identical the whole time.
			]]
			local path = tostring(pose.joint)
			local key = string.match(path, "([^/]+)$") or path
			if firstValue[key] == nil then
				firstValue[key] = tostring(pose.cframe)
			end
			lastValue[key] = tostring(pose.cframe)
		end
		for _, pose in poses do
			--[[
				The leaf name, not the path it came down.

				A face-rigged R15 has 109 joints and their full paths run six
				segments deep, so the honest list of them is several thousand
				characters of "HumanoidRootPart/LowerTorso/UpperTorso/..." repeated
				with a different ending each time. That is the whole reply, for a
				summary line nobody can read. The paths are still on each pose,
				where the nesting is the point; here the question is only which
				joints move.
			]]
			local path = tostring(pose.joint)
			joints[string.match(path, "([^/]+)$") or path] = true
		end

		table.insert(rows, {
			index = index,
			time = math.round(keyframe.Time * 1000) / 1000,
			name = if keyframe.Name ~= "" then keyframe.Name else nil,
			poseCount = #poses,
			-- Poses only while the listing is small enough to be worth reading.
			poses = if index <= DETAIL_LIMIT then poses else nil,
		})
	end

	local rig, shape = rigOf(joints)

	local moved: { string } = {}
	for joint in joints do
		table.insert(moved, joint)
	end
	table.sort(moved)
	local count = #moved

	--[[
		Capped, with the count kept separate.

		`jointCount` is the number that answers "does this animate the whole body
		or one arm", and it stays exact. The names are a sample past this point,
		because a rigged face contributes eighty of them and nobody reading a
		summary needs to see `L_eyeD` spelled out.
	]]
	local JOINT_SAMPLE = 24
	local sampled = #moved > JOINT_SAMPLE
	if sampled then
		local short: { string } = {}
		table.move(moved, 1, JOINT_SAMPLE, 1, short)
		moved = short
	end

	--[[
		Whether the animation ends where it began.

		This is the most common fault in a looping animation and it is invisible
		in the editor until you watch the loop point twice.

		Compared on the VALUES each joint ends at against the values it started
		at. An earlier version compared how many poses the first and last
		keyframes carried, and that was wrong in a way worth recording: a
		keyframe that omits a joint is not moving it back to anywhere, it is
		leaving it where the previous keyframe put it. Roblox's own "toolnone"
		animation poses three joints at the start and two afterwards, and the
		count test called it broken -- a false alarm on the platform's own asset,
		which is about the clearest signal that the test was measuring the wrong
		thing.

		String comparison of the serialised CFrames, which is exact here: both
		values come from the same downloaded sequence, so there is no rounding
		between them to produce a phantom difference.
	]]
	local drifted: { string } = {}
	for joint, startValue in firstValue do
		if lastValue[joint] ~= startValue then
			if #drifted < 8 then
				table.insert(drifted, joint)
			end
		end
	end
	table.sort(drifted)
	local loops: boolean? = if #rows >= 2 then #drifted == 0 else nil

	return {
		assetId = id,
		name = if sequenceInstance.Name ~= "" then sequenceInstance.Name else nil,
		priority = tostring(sequenceInstance.Priority):gsub("Enum%.AnimationPriority%.", ""),
		looping = sequenceInstance.Loop,
		duration = math.round(duration * 1000) / 1000,
		keyframeCount = #keyframes,
		joints = moved,
		jointCount = count,
		jointsSampled = sampled,
		keyframes = rows,
		endsWhereItStarted = loops,
		-- Named, not just counted: "the right arm does not return" is actionable
		-- where "it does not loop cleanly" sends someone to look at all of it.
		driftingJoints = if #drifted > 0 then drifted else nil,
		rig = rig,
		rigNote = shape,
		truncated = #keyframes > DETAIL_LIMIT,
	}
end

--[[
	The joint tree to nest poses against.

	A named rig wins, because it is the truth: a custom rig, a tool, a door, a
	Blender import with its own bone names -- none of those are in the tables
	above, and all of them are ordinary things to animate. The rig's own Motor6Ds
	say exactly which part hangs off which.

	Without one, the pose names pick the map. Every R15 name is unique to R15, so
	one of them appearing settles it; "Head" alone is ambiguous and falls to R6,
	which is the older and likelier default for a hand-written animation.
]]
local function parentMap(params: { [string]: any }, joints: { [string]: boolean }): ({ [string]: string }, string)
	if typeof(params.rig) == "string" and params.rig ~= "" then
		local model = Paths.resolve(params.rig)
		local map: { [string]: string } = {}
		local found = 0
		for _, descendant in model:GetDescendants() do
			if descendant:IsA("Motor6D") then
				local zero, one = descendant.Part0, descendant.Part1
				if zero ~= nil and one ~= nil then
					map[one.Name] = zero.Name
					found += 1
				end
			end
		end
		if found == 0 then
			Dispatch.fail(
				"NO_RIG",
				string.format("%s has no Motor6D joints, so there is no hierarchy to build against.", params.rig),
				"Point `rig` at the model whose parts the poses name."
			)
		end
		return map, "rig"
	end

	for joint in joints do
		if R15_PARENT[joint] ~= nil and R6_PARENT[joint] == nil then
			return R15_PARENT, "R15"
		end
	end
	return R6_PARENT, "R6"
end

--[[
	Builds a KeyframeSequence in memory and registers it for playback.

	The registration is what makes this more than an instance tree: it returns a
	content id that an Animation can use immediately, in this Studio, with no
	upload and no moderation wait. That is the whole loop an agent needs to try
	an idea -- build, set AnimationId, look -- and it is entirely reversible,
	because nothing left the session.

	Poses arrive flat, named by joint, and are nested under one root pose here.
	Flat is what a caller can write and nesting is what the engine resolves, and
	the rig's own hierarchy is not knowable from a list of joint names -- so a
	single root is the honest structure: it animates the named joints and claims
	nothing about how they connect.
]]
function Anim.build(params: { [string]: any }): { [string]: any }
	local frames = params.keyframes
	if typeof(frames) ~= "table" or #(frames :: { any }) == 0 then
		Dispatch.fail(
			"BAD_PARAMS",
			"build needs a non-empty `keyframes` array.",
			'Each entry is { time = 0.5, poses = { ["Right Arm"] = "0, 1, 0 | 0, 45, 0" } }.'
		)
	end

	local sequence = Instance.new("KeyframeSequence")
	sequence.Name = if typeof(params.name) == "string" and params.name ~= "" then params.name else "MCPAnimation"
	sequence.Loop = params.loop == true
	if typeof(params.priority) == "string" and params.priority ~= "" then
		local okPriority = pcall(function()
			sequence.Priority = (Enum :: any).AnimationPriority[params.priority]
		end)
		if not okPriority then
			sequence:Destroy()
			Dispatch.fail(
				"BAD_PARAMS",
				string.format("%q is not an AnimationPriority.", tostring(params.priority)),
				'Use "Idle", "Movement", "Action" or "Core".'
			)
		end
	end

	local rootName = if typeof(params.root) == "string" and params.root ~= "" then params.root else "HumanoidRootPart"
	local count = 0
	-- For the zero-length check after the loop.
	local longest = 0
	local lastKeyframe: Keyframe? = nil

	-- Every joint the caller names, gathered before anything is built, because
	-- the rig guess reads the whole set rather than one keyframe's worth.
	local joints: { [string]: boolean } = {}
	for _, entry in frames :: { any } do
		if typeof(entry) == "table" and typeof((entry :: any).poses) == "table" then
			for joint in (entry :: any).poses :: { [string]: any } do
				joints[tostring(joint)] = true
			end
		end
	end

	local parentOf, hierarchy = parentMap(params, joints)

	local unmatched: { string } = {}
	for joint in joints do
		if joint ~= rootName and parentOf[joint] == nil then
			table.insert(unmatched, joint)
		end
	end
	table.sort(unmatched)

	for position, entry in frames :: { any } do
		if typeof(entry) ~= "table" then
			sequence:Destroy()
			Dispatch.fail("BAD_PARAMS", string.format("keyframe %d is not an object.", position))
		end
		local frame = entry :: { [string]: any }

		local keyframe = Instance.new("Keyframe")
		keyframe.Time = tonumber(frame.time) or 0
		longest = math.max(longest, keyframe.Time)
		if lastKeyframe == nil or keyframe.Time >= lastKeyframe.Time then
			lastKeyframe = keyframe
		end
		if typeof(frame.name) == "string" and frame.name ~= "" then
			keyframe.Name = frame.name
		end

		local root = Instance.new("Pose")
		root.Name = rootName
		root.Weight = 1
		root.Parent = keyframe

		--[[
			Poses placed where the rig says they belong, creating whatever links
			the chain needs along the way.

			A pose for "Right Arm" is only read if its parent pose is "Torso",
			because that is the joint that moves it -- so animating a hand means
			the whole arm appears in the tree whether or not the caller mentioned
			it. Those filler poses carry Weight 0: they exist to hold the
			hierarchy together, and a weight of 1 would pin the joint they name to
			its rest pose, quietly cancelling any movement the caller did ask for.
		]]
		local placed: { [string]: Pose } = {}
		local function poseFor(joint: string): Pose
			if joint == rootName then
				return root
			end
			local existing = placed[joint]
			if existing ~= nil then
				return existing
			end
			local pose = Instance.new("Pose")
			pose.Name = joint
			pose.CFrame = CFrame.new()
			pose.Weight = 0
			local above = parentOf[joint]
			-- An unknown joint hangs off the root, which is what this did for
			-- every joint before. It is reported rather than assumed correct.
			pose.Parent = if above ~= nil and above ~= joint then poseFor(above) else root
			placed[joint] = pose
			return pose
		end

		if typeof(frame.poses) == "table" then
			for joint, value in frame.poses :: { [string]: any } do
				local okValue, cframe, why = Serialize.parse(tostring(value), "CFrame")
				if not okValue then
					sequence:Destroy()
					Dispatch.fail(
						"BAD_PARAMS",
						string.format("keyframe %d, joint %q: %s", position, tostring(joint), tostring(why)),
						'A pose is written like a CFrame property: "0, 1, 0" or "0, 1, 0 | 0, 45, 0".'
					)
				end
				local name = tostring(joint)
				local pose = poseFor(name)
				pose.CFrame = cframe :: CFrame
				pose.Weight = 1
				count += 1
			end
		end

		keyframe.Parent = sequence
	end

	--[[
		Never left with zero length.

		Every keyframe at time 0 -- which is what one keyframe always is -- gives a
		sequence a `Length` of 0, and `preview` cannot seek a track like that: it
		waits out its deadline and reports ANIMATION_TIMEOUT. The fix is a second
		keyframe repeating the last one a moment later, which changes nothing about
		the pose and gives the animation a duration.
	]]
	local padded = false
	if longest <= 0 and lastKeyframe ~= nil then
		local copy = (lastKeyframe :: Keyframe):Clone()
		copy.Name = "Keyframe"
		copy.Time = MIN_LENGTH
		copy.Parent = sequence
		padded = true
	end

	local ok, id = pcall(function()
		return KeyframeSequenceProvider:RegisterKeyframeSequence(sequence)
	end)

	--[[
		Kept as a real instance when asked, destroyed otherwise.

		The registered hash is good for `preview` and for nothing that ships: put
		in an Animation that a real playtest loads, it takes the character's whole
		Animator down (a full T-pose, not just this animation). What does work in a
		game is a KeyframeSequence that exists as an instance -- parented in the
		place, say under the Tool that plays it -- which the CLIENT registers for
		itself at runtime. `parent` makes that instance here.
	]]
	local kept: string? = nil
	local keepFailure: string? = nil
	local keepsInstance = typeof(params.parent) == "string" and params.parent ~= ""
	if ok and keepsInstance then
		local okKeep, failure = pcall(function()
			local container = Paths.resolve(params.parent)
			Undo.record("StudioMCP.AnimBuild", "MCP build animation", function()
				sequence.Parent = container
			end)
			kept = Paths.of(sequence)
		end)
		if not okKeep then
			keepFailure = tostring(if typeof(failure) == "table" then (failure :: any).message else failure)
		end
	end
	-- Registration copies what it needs, so a sequence that was not kept is
	-- destroyed: it was never in the data model to begin with.
	if kept == nil then
		sequence:Destroy()
	end

	if not ok then
		Dispatch.fail("ANIMATION_FAILED", string.format("Could not register the sequence: %s", tostring(id)))
	end

	return {
		animationId = tostring(id),
		keyframeCount = #(frames :: { any }) + (if padded then 1 else 0),
		poseCount = count,
		hierarchy = hierarchy,
		-- Said so the caller is not surprised to find a keyframe they did not write.
		paddedToTwoKeyframes = if padded then MIN_LENGTH else nil,
		-- The instance to use in a real game, when `parent` was given.
		instance = kept,
		instanceNote = keepFailure,
		scope = "preview-only",
		-- Named, because a joint the rig does not have produces an animation that
		-- plays perfectly and moves nothing -- the one failure here with no
		-- symptom at all.
		unmatchedJoints = if #unmatched > 0 then unmatched else nil,
		--[[
			Used exactly as it comes back, with nothing added in front of it.

			`RegisterKeyframeSequence` returns a bare hash rather than anything
			that looks like a content id, which invites a caller to "fix" it into
			`rbxasset://<hash>`. Measured: the bare string sets on
			`Animation.AnimationId` and reads back through
			`GetKeyframeSequenceAsync`; the prefixed one fails both. So the shape
			is correct and the instinct to correct it is the bug.
		]]
		note = "PREVIEW ONLY. Use this id verbatim with `animation op=preview`/`read` -- do "
			.. "NOT put rbxassetid:// or rbxasset:// in front of it. It is valid only "
			.. "in this Studio's edit session: NEVER write it to a real Animation.AnimationId "
			.. "that a playtest loads -- LoadAnimation with it breaks the character's whole "
			.. "Animator (full T-pose). For gameplay, pass `parent` to keep a real "
			.. "KeyframeSequence in the place and register it on the client with "
			.. "KeyframeSequenceProvider:RegisterKeyframeSequence()."
			.. (if padded
				then " A second keyframe was added " .. tostring(MIN_LENGTH) .. "s after the first because a zero-length animation cannot be previewed."
				else ""),
	}
end

--[[
	Loads and plays a kept KeyframeSequence on a running playtest's client --
	the four lines of client Luau the `build` reply used to hand back for the
	agent to paste into `execute_luau target="client"` verbatim, now a call.

	That hand-off was real friction, not just extra typing: `KeyframeSequenceProvider`
	and `LoadAnimation` are both CLIENT-only, so shipping an animation that
	actually plays in a playtest was the one workflow this server could describe
	but not do -- every other tool acts directly, and this one made the agent be
	its own client. Getting the boilerplate exactly right (find the sequence,
	find the right Animator, register, load, play, and say what went wrong at
	each step) is exactly the kind of thing worth not re-deriving per call.

	Runs the same way `input` and the playtest screenshot do: a LocalScript
	parented into the player's PlayerGui, because `KeyframeSequenceProvider` and
	`Animator:LoadAnimation` both refuse outright when called from the server's
	session -- "Instance is not accessible" -- and pcall does nothing about
	that, only WRONG_CONTEXT would.
]]
local CLIENT_PLAY_SOURCE = [==[
local KeyframeSequenceProvider = game:GetService("KeyframeSequenceProvider")
local Players = game:GetService("Players")

local relay = script
local report = relay:WaitForChild("Report", 10)
if report == nil then
	return
end

local Paths = require(script:WaitForChild("Paths"))

-- Dispatch.fail (used inside Paths.resolve) raises a { code, message, hint }
-- table, not a string; this is the one place on the client that has to know that.
local function describe(err)
	if typeof(err) == "table" and err.message ~= nil then
		return tostring(err.message)
	end
	return tostring(err)
end

-- The name on every Animation this relay plays. Tracks outlive the relay (it
-- is destroyed the moment it reports), so this is how a later `play` or
-- `stop` finds exactly the tracks MCP started -- and leaves the game's own
-- walk, idle and tool animations alone.
local TAG = "MCPPlay"

-- How long to wait for things a playtest makes shortly AFTER it starts: the
-- character, its Humanoid (a character can be parented before its children
-- have all replicated), and the Animator the server normally creates.
local CHARACTER_WAIT = 8
local HUMANOID_WAIT = 5
local ANIMATOR_WAIT = 2

local function waitFor(find, seconds)
	local found = find()
	local deadline = os.clock() + seconds
	while found == nil and os.clock() < deadline do
		task.wait(0.1)
		found = find()
	end
	return found
end

-- "play" loads and plays `Sequence`; "stop" only stops what earlier plays left.
local mode = relay:GetAttribute("Mode") or "play"
local sequencePath = relay:GetAttribute("Sequence")
local rigPath = relay:GetAttribute("Rig")

local sequence
if mode == "play" then
	local okSequence, found = pcall(Paths.resolve, sequencePath)
	if not okSequence then
		report:FireServer({ ok = false, reason = "sequence " .. describe(found) })
		return
	end
	if not found:IsA("KeyframeSequence") then
		report:FireServer({
			ok = false,
			reason = tostring(sequencePath) .. " is a " .. found.ClassName .. ", not a KeyframeSequence.",
		})
		return
	end
	sequence = found
end

local target
local ownCharacter = false
if typeof(rigPath) == "string" and rigPath ~= "" then
	local okRig, rig = pcall(Paths.resolve, rigPath)
	if not okRig then
		report:FireServer({ ok = false, reason = "rig " .. describe(rig) })
		return
	end
	target = rig
else
	local character = waitFor(function()
		return Players.LocalPlayer.Character
	end, CHARACTER_WAIT)
	if character == nil then
		report:FireServer({
			ok = false,
			reason = string.format(
				"the local player has no character (waited %ds); wait for it to spawn, or pass `rig` to use something else.",
				CHARACTER_WAIT
			),
		})
		return
	end
	target = character
	ownCharacter = true
end

local function findController()
	return target:FindFirstChildOfClass("Humanoid") or target:FindFirstChildOfClass("AnimationController")
end
local controller = if ownCharacter then waitFor(findController, HUMANOID_WAIT) else findController()
if controller == nil then
	report:FireServer({
		ok = false,
		reason = target:GetFullName() .. " has no Humanoid or AnimationController to play an animation on.",
	})
	return
end

--[[
	Waited for before one is made. On a player's character the server creates
	the Animator, and it can arrive a moment after the Humanoid; a client that
	makes its own in that gap ends up with a second Animator, and animations
	played through a client-made one do not replicate to other players.
]]
local animator = waitFor(function()
	return controller:FindFirstChildOfClass("Animator")
end, ANIMATOR_WAIT)

-- Whatever an earlier `play` left on this rig. Stopped and destroyed before a
-- new one starts: nothing else ever stops them, so repeated plays of a
-- looping animation used to stack, each at full weight.
local stopped = 0
if animator ~= nil then
	local okTracks, tracks = pcall(function()
		return animator:GetPlayingAnimationTracks()
	end)
	if okTracks and typeof(tracks) == "table" then
		for _, track in tracks do
			local okName, name = pcall(function()
				return track.Animation and track.Animation.Name
			end)
			if okName and name == TAG then
				pcall(function()
					track:Stop(0)
				end)
				pcall(function()
					track:Destroy()
				end)
				stopped += 1
			end
		end
	end
end

if mode == "stop" then
	report:FireServer({ ok = true, stopped = stopped })
	return
end

if animator == nil then
	-- Ordinary for a rig that has never played anything yet; games create this
	-- the same way, on first use.
	local okNew, made = pcall(Instance.new, "Animator")
	if not okNew then
		report:FireServer({ ok = false, reason = "could not create an Animator: " .. describe(made) })
		return
	end
	made.Parent = controller
	animator = made
end

local okId, id = pcall(function()
	return KeyframeSequenceProvider:RegisterKeyframeSequence(sequence)
end)
if not okId then
	report:FireServer({ ok = false, reason = "could not register the sequence: " .. describe(id) })
	return
end

local anim = Instance.new("Animation")
anim.Name = TAG
anim.AnimationId = id

local okTrack, track = pcall(function()
	return animator:LoadAnimation(anim)
end)
if not okTrack then
	report:FireServer({ ok = false, reason = "could not load the animation: " .. describe(track) })
	return
end

track:Play(relay:GetAttribute("FadeTime"), relay:GetAttribute("Weight"), relay:GetAttribute("Speed"))

report:FireServer({
	ok = true,
	animationId = tostring(id),
	length = track.Length,
	looped = track.Looped,
	priority = tostring(track.Priority),
	replaced = stopped,
})
]==]

-- The relay's own waits (character 8s, Humanoid 5s, Animator 2s) plus the
-- relay's start-up and the register/load itself, with room to spare -- and
-- still well inside the server's 45s wait for this call.
local PLAY_TIMEOUT = 25

function Anim.play(params: { [string]: any }): { [string]: any }
	if typeof(params.sequence) ~= "string" or params.sequence == "" then
		Dispatch.fail(
			"BAD_PARAMS",
			"play needs `sequence` -- the path to a KeyframeSequence instance.",
			'This is the `instance` a prior `build` (called with `parent`) returned, e.g. '
				.. '"Workspace.Rig.Tool.MCPAnimation".'
		)
	end

	local player = ClientRelay.playerFor(params.player)
	local result = ClientRelay.run(player, "MCPAnimPlayRelay", CLIENT_PLAY_SOURCE, {
		Mode = "play",
		Sequence = params.sequence,
		Rig = if typeof(params.rig) == "string" then params.rig else nil,
		FadeTime = if typeof(params.fadeTime) == "number" then params.fadeTime else nil,
		Weight = if typeof(params.weight) == "number" then params.weight else nil,
		Speed = if typeof(params.speed) == "number" then params.speed else nil,
	}, PLAY_TIMEOUT, function(relay)
		-- Paths is the only dependency the client script itself requires, but
		-- Paths in turn requires Dispatch (as a sibling, `script.Parent.Dispatch`)
		-- for its own failure reporting, so both come along.
		for _, name in { "Paths", "Dispatch" } do
			local copy = script.Parent.Parent[name]:Clone()
			copy.Parent = relay
		end
	end)

	if result.ok ~= true then
		Dispatch.fail("ANIMATION_PLAY_FAILED", tostring(result.reason or "the client refused to play it"))
	end

	return {
		played = true,
		player = player.Name,
		-- Session-local, the same as `build`'s id: good for this playtest only.
		animationId = result.animationId,
		length = result.length,
		looped = result.looped,
		priority = result.priority,
		-- Tracks an earlier `play` had left on this rig, stopped first so they
		-- do not stack. `op="stop"` in the playtest stops this one the same way.
		replaced = result.replaced,
	}
end

--[[
	Stops what `play` started, on the client where it is playing.

	`preview`'s `stop` cannot: it runs in the session it is sent to, poses with
	edit-mode StepAnimations and resets the rig's joints -- none of which
	reaches a track playing on a playtest client's own Animator. Only the
	tracks `play` tagged are touched; the game's own animations carry on.
]]
function Anim.stopPlay(params: { [string]: any }): { [string]: any }
	local player = ClientRelay.playerFor(params.player)
	local result = ClientRelay.run(player, "MCPAnimStopRelay", CLIENT_PLAY_SOURCE, {
		Mode = "stop",
		Rig = if typeof(params.rig) == "string" then params.rig else nil,
	}, PLAY_TIMEOUT, function(relay)
		for _, name in { "Paths", "Dispatch" } do
			local copy = script.Parent.Parent[name]:Clone()
			copy.Parent = relay
		end
	end)

	if result.ok ~= true then
		Dispatch.fail("ANIMATION_STOP_FAILED", tostring(result.reason or "the client refused to stop it"))
	end

	return {
		stopped = result.stopped or 0,
		player = player.Name,
	}
end

--[[
	A registered or downloaded animation with no length, re-registered with one.

	`build` no longer produces these, but they still arrive: an id from an
	older build, a hand-made KeyframeSequence, or an uploaded animation that
	really is a single frame. All of them make `preview` time out, because a track
	of length 0 cannot be seeked, and none of them is broken.

	Returns the id of a copy with the last keyframe repeated MIN_LENGTH later, or
	nil when the sequence cannot be read or is not actually zero-length -- in which
	case the timeout has some other cause and padding would hide it.
]]
local function paddedCopy(id: string): string?
	local okRead, sequence = pcall(function()
		return KeyframeSequenceProvider:GetKeyframeSequenceAsync(id)
	end)
	if not okRead or sequence == nil then
		return nil
	end
	local source = sequence :: KeyframeSequence

	local last: Keyframe? = nil
	local longest = 0
	for _, frame in source:GetKeyframes() do
		local keyframe = frame :: Keyframe
		longest = math.max(longest, keyframe.Time)
		if last == nil or keyframe.Time >= last.Time then
			last = keyframe
		end
	end
	if last == nil or longest > 0 then
		source:Destroy()
		return nil
	end

	local copy = last:Clone()
	copy.Time = MIN_LENGTH
	copy.Parent = source
	local okRegister, newId = pcall(function()
		return KeyframeSequenceProvider:RegisterKeyframeSequence(source)
	end)
	source:Destroy()
	if not okRegister then
		return nil
	end
	return tostring(newId)
end

--[[
	Puts a rig back the way it was before anything was played on it.

	Four steps, and every one of them is load-bearing -- this took three wrong
	versions to get right, so the reasoning is written down rather than left to
	be rediscovered.

	1. Speed back to 1 before stopping. `preview` freezes a pose by setting speed
	   to 0, and a fade of length 0 at speed 0 never finishes.
	2. Step, so the stop is actually processed. Nothing steps an Animator in edit
	   mode, so `Stop` on its own leaves the track in
	   `GetPlayingAnimationTracks` and leaves the rig bent, while the call
	   reports it stopped.
	3. Clear every `Motor6D.Transform` by hand. Removing the track does NOT clear
	   the transforms it wrote -- with no track left there is nothing to write
	   anything, so the last animated pose simply stays. Measured: track count 0,
	   shoulder transform still (0, 0, 0.25).
	4. Step once more. Writing `Transform` changes nothing by itself in edit
	   mode; the step is what makes the engine rebuild the part CFrames from the
	   joints, and that is the frame the rig comes back on.

	The tempting shortcut -- compute each joint's rest CFrame and write it to the
	part -- is worse than doing nothing. Setting `CFrame` on a part jointed to
	others moves the WHOLE assembly, so placing the head shifted the body,
	placing the arm shifted it again, and the rig ended up floating and rotated
	with its anchored root dragged along. Measured: an R6 rig came out at
	(0.08, 3.86, 0.37) rotated 67 degrees after a "restore".
]]
local function restPose(model: Instance, animator: Animator)
	for _, track in animator:GetPlayingAnimationTracks() do
		track:AdjustSpeed(1)
		track:Stop(0)
	end

	--[[
		Stepped until the stop has actually finished, which takes longer than it
		sounds like it should.

		`Stop(0)` asks for no fade and does not get one: the track's weight comes
		down over frames regardless, and it stays in
		`GetPlayingAnimationTracks` the whole time -- with `IsPlaying` already
		false, so list membership is not a measure of anything. Measured on an R6
		rig: eleven steps, weight falling 1 -> 0.61 -> 0, and the track vanished
		on the eleventh.

		Guessing the number is how this went wrong twice. One step left the rig
		bent; six steps was worse than one, because the fade was still running
		when the transforms below were cleared and the next step wrote the
		half-faded pose straight back over them. So the loop watches for the
		answer, and the cap is a second of simulated time -- far past any fade,
		and still a bound rather than a spin.
	]]
	for _ = 1, 60 do
		if #animator:GetPlayingAnimationTracks() == 0 then
			break
		end
		animator:StepAnimations(1 / 60)
	end

	for _, descendant in model:GetDescendants() do
		if descendant:IsA("Motor6D") then
			descendant.Transform = CFrame.new()
		end
	end
	animator:StepAnimations(1 / 60)
end

--[[
	Plays an animation on a real rig, in edit mode, so it can be looked at.

	`read` says what an animation contains and `build` makes one; neither answers
	"does it look right", which for a piece of motion is most of the question.
	Measured: an `Animator` loads and plays a track in an ordinary edit session
	-- `Length` comes back populated and `IsPlaying` is true -- so the rig in the
	place can be posed without pressing Play.

	The frame is the point. Playing an animation and returning immediately shows
	whatever pose the rig happened to be in, so this seeks to a chosen moment and
	holds it there: play, jump to `at`, pause. Then `screenshot` sees that exact
	pose, and asking for three different moments gives three comparable frames.

	Deliberately leaves the rig posed rather than restoring it. The whole purpose
	is to leave something on screen to photograph, and a tool that tidied up
	before returning would always photograph the idle pose. `op="stop"` puts it
	back.
]]
function Anim.preview(params: { [string]: any }): { [string]: any }
	local rigPath = params.rig
	if typeof(rigPath) ~= "string" or rigPath == "" then
		Dispatch.fail(
			"BAD_PARAMS",
			"preview needs a `rig` -- the path of a model with a Humanoid or an AnimationController.",
			'Find one with `find selector="Humanoid"`.'
		)
	end

	local model = Paths.resolve(rigPath)
	local animator: Animator? = nil

	--[[
		The Animator, wherever it lives.

		A character rig keeps it under the Humanoid; a non-character rig keeps it
		under an AnimationController. Both are ordinary in a place, and a tool
		that only knew about one of them would refuse half the rigs it was
		pointed at. Created if missing, because a rig imported from Blender often
		has the controller and not the animator, and adding one is what Studio
		does too.
	]]
	local host = model:FindFirstChildWhichIsA("Humanoid") or model:FindFirstChildWhichIsA("AnimationController")
	if host == nil then
		Dispatch.fail(
			"NO_RIG",
			string.format("%s has no Humanoid or AnimationController, so nothing can play an animation on it.", rigPath)
		)
	end
	animator = (host :: Instance):FindFirstChildWhichIsA("Animator")
	if animator == nil then
		local created = Instance.new("Animator")
		created.Parent = host
		animator = created
	end

	if params.op == "stop" then
		local stopped = 0
		for _, track in (animator :: Animator):GetPlayingAnimationTracks() do
			track:Stop(0)
			stopped += 1
		end
		restPose(model, animator :: Animator)
		local left = #(animator :: Animator):GetPlayingAnimationTracks()
		return {
			rig = Paths.of(model),
			stopped = stopped,
			stillPlaying = if left > 0 then left else nil,
			note = if left > 0
				then "Some tracks are still playing, so the rig may still be posed."
				else "The rig is back in its rest pose.",
		}
	end

	local id = contentId(params)
	local animation = Instance.new("Animation")
	animation.AnimationId = id

	local okLoad, track = pcall(function()
		return (animator :: Animator):LoadAnimation(animation)
	end)
	if not okLoad then
		animation:Destroy()
		Dispatch.fail("ANIMATION_FAILED", string.format("Could not load %s: %s", id, tostring(track)))
	end

	local clip = track :: AnimationTrack
	local padNote: string? = nil

	--[[
		Waited for, because a freshly loaded track has no length yet.

		`LoadAnimation` returns before the asset has been fetched, and a track
		with `Length == 0` cannot be seeked -- an unwaited preview silently shows
		frame zero of everything. Measured: the length arrives within a frame or
		two of a warm cache and takes noticeably longer on a cold one.
	]]
	local waited = 0
	while clip.Length == 0 and waited < 1.5 do
		waited += task.wait()
	end

	--[[
		A length that has not arrived by now is usually a length that never will.

		A sequence whose keyframes all sit at time 0 loads fine and reports
		`Length == 0` forever, so waiting longer only delays the same timeout.
		Checked directly: if that is what this is, a copy with a real duration is
		previewed instead, and the reply says so.
	]]
	if clip.Length == 0 then
		local padded = paddedCopy(id)
		if padded ~= nil then
			clip:Destroy()
			animation.AnimationId = padded
			local okAgain, again = pcall(function()
				return (animator :: Animator):LoadAnimation(animation)
			end)
			if okAgain then
				clip = again :: AnimationTrack
				padNote = string.format(
					"This animation has only one moment (length 0), which cannot be seeked, so a copy "
						.. "with a second keyframe %gs later was previewed instead. The animation itself "
						.. "is unchanged.",
					MIN_LENGTH
				)
			end
		end
	end
	while clip.Length == 0 and waited < 5 do
		waited += task.wait()
	end
	if clip.Length == 0 then
		animation:Destroy()
		Dispatch.fail(
			"ANIMATION_TIMEOUT",
			string.format("%s did not load within 5s.", id),
			"The animation must be public, or owned by the account signed into Studio. "
				.. "A single-keyframe animation (length 0) is also handled, so a timeout here "
				.. "usually means the asset could not be downloaded."
		)
	end

	--[[
		Everything else on this rig stops first, or two animations blend and the
		picture is of neither.

		`Stop` leaves the track in the list for a moment, so a second preview used
		to show two entries for the same animation. Destroying the track object
		removes it outright, which keeps a repeated preview from accumulating one
		dead track per call.
	]]
	for _, other in (animator :: Animator):GetPlayingAnimationTracks() do
		if other ~= clip then
			other:Stop(0)
			other:Destroy()
		end
	end

	local at = math.clamp(tonumber(params.at) or 0, 0, clip.Length)

	--[[
		Stepped by hand, because nothing steps it in edit mode.

		This is the whole reason a first attempt at this reported perfect success
		and moved nothing. In a running game the engine advances every Animator
		each frame; in an edit session it advances none of them, so a track can be
		playing, at the right TimePosition, and contributing exactly nothing
		forever. Measured: `WeightCurrent` stayed 0 through any amount of
		`task.wait`, and every Motor6D transform stayed identity.

		`Animator:StepAnimations(delta)` is what Studio's own animation editor
		uses, and it is what actually moves the rig. A few steps at a sixtieth of
		a second let the weight blend reach 1; then the time is set and a
		zero-length step applies that exact pose without advancing it.
	]]
	clip.Priority = Enum.AnimationPriority.Action
	clip:Play(0, 1, 1)

	local function step(delta: number)
		pcall(function()
			(animator :: any):StepAnimations(delta)
		end)
	end

	for _ = 1, 5 do
		step(1 / 60)
	end

	if params.hold ~= false then
		clip:AdjustSpeed(0)
	end
	clip.TimePosition = at
	-- Zero advances nothing and still applies the pose at the time just set.
	step(0)

	local weight = clip.WeightCurrent
	animation:Destroy()

	return {
		rig = Paths.of(model),
		animationId = id,
		length = math.round(clip.Length * 1000) / 1000,
		at = math.round(at * 1000) / 1000,
		holding = params.hold ~= false,
		-- Reported because a weight of zero means the rig is NOT posed, however
		-- healthy everything else in this reply looks.
		weight = math.round(weight * 100) / 100,
		padded = padNote,
		note = if weight > 0
			then "The rig is posed at this moment now -- take a `screenshot` to see it. "
				.. 'Call again with a different `at` to compare, or op="stop" to clear it.'
			else "WARNING: the animation loaded but its weight is 0, so the rig is NOT "
				.. "posed. Something else is animating this rig, or it has no Motor6D "
				.. "joints for the animation to drive.",
	}
end

function Anim.register()
	Dispatch.registerAll("anim", {
		read = Anim.read,
		preview = Anim.preview,
		build = Anim.build,
		play = Anim.play,
		stopPlay = Anim.stopPlay,
	})
end

return Anim
