local Anim = ...

local function poses(joint, value)
	return { [joint] = value }
end

-- One keyframe has zero length, which cannot be previewed: it is padded.
local single = Anim.build({ keyframes = { { time = 0, poses = poses("Right Arm", "0, 1, 0") } } })
assert(single.paddedToTwoKeyframes == 0.1, "a single keyframe is padded")
assert(single.keyframeCount == 2, "the reply counts the added keyframe")
local times = registered[#registered].times
assert(#times == 2 and times[1] == 0 and times[2] == 0.1, "the registered sequence has keyframes at 0 and 0.1")
assert(single.scope == "preview-only")
assert(string.find(single.note, "PREVIEW ONLY", 1, true), "the id is labelled preview-only")
assert(string.find(single.note, "T-pose", 1, true), "the T-pose consequence is stated")
assert(string.find(single.note, "zero-length", 1, true), "the padding is explained")

-- Several keyframes all at time 0 are the same problem.
Anim.build({ keyframes = {
	{ time = 0, poses = poses("Right Arm", "0, 1, 0") },
	{ time = 0, poses = poses("Left Arm", "0, 1, 0") },
} })
times = registered[#registered].times
assert(#times == 3 and times[3] == 0.1, "all-at-zero keyframes are padded too")

-- A real animation is left exactly as written.
local real = Anim.build({ keyframes = {
	{ time = 0, poses = poses("Right Arm", "0, 1, 0") },
	{ time = 0.5, poses = poses("Right Arm", "0, 2, 0") },
} })
assert(real.paddedToTwoKeyframes == nil and real.keyframeCount == 2, "a non-zero length is not padded")
times = registered[#registered].times
assert(#times == 2 and times[2] == 0.5)

-- A single keyframe that is not at time 0 already has a length.
local late = Anim.build({ keyframes = { { time = 1, poses = poses("Right Arm", "0, 1, 0") } } })
assert(late.paddedToTwoKeyframes == nil, "a keyframe at 1s is not zero-length")

-- `parent` keeps a real KeyframeSequence for gameplay use; without it nothing is kept.
assert(real.instance == nil and real.instanceNote == nil)
local kept = Anim.build({ parent = "Workspace.Rig.Tool", keyframes = {
	{ time = 0, poses = poses("Right Arm", "0, 1, 0") },
	{ time = 1, poses = poses("Right Arm", "0, 2, 0") },
} })
assert(kept.instance == "Workspace.Rig.MCPAnimation", "the kept instance's path is returned: " .. tostring(kept.instanceNote))
assert(kept.instanceNote == nil)
local keptSequence = registered[#registered].sequence
assert(keptSequence.Parent ~= nil and not keptSequence.destroyed, "the kept sequence is parented, not destroyed")
assert(registered[#registered - 1].sequence.destroyed, "an unkept sequence is destroyed")

-- `play` needs a sequence path; nothing else is optional enough to guess.
local okMissing, missingErr = pcall(Anim.play, {})
assert(not okMissing and missingErr.code == "BAD_PARAMS", "play refuses without `sequence`")

-- The common case: no `rig` given, so the relay is left to fall back to the
-- local player's own character. Paths and Dispatch are cloned onto the relay
-- for the embedded client script to require.
local played = Anim.play({ sequence = "Workspace.Rig.Tool.MCPAnimation" })
local call = relayCalls[#relayCalls]
assert(call.name == "MCPAnimPlayRelay")
assert(call.attributes.Mode == "play", "the relay is told to play")
assert(call.attributes.Sequence == "Workspace.Rig.Tool.MCPAnimation")
assert(call.attributes.Rig == nil, "no rig means no Rig attribute at all -- the client falls back to the character")
local clonedNames = {}
for _, kid in call.relay:GetChildren() do
	table.insert(clonedNames, kid.Name or kid.ClassName)
end
table.sort(clonedNames)
assert(#clonedNames == 2, "Paths and Dispatch, nothing else, are cloned onto the relay")
assert(played.played == true and played.animationId == "session-hash" and played.length == 1)

-- A rig path, when given, becomes the Rig attribute verbatim.
Anim.play({ sequence = "Workspace.Seq", rig = "Workspace.OtherRig" })
call = relayCalls[#relayCalls]
assert(call.attributes.Rig == "Workspace.OtherRig")

-- The client refusing (no character, sequence not found, wrong class, no
-- Humanoid/AnimationController...) surfaces as ANIMATION_PLAY_FAILED, not a
-- raw client-side string the agent has no code to branch on.
nextRelayAnswer = { ok = false, reason = "sequence not found: Workspace.Nope" }
local okFail, failErr = pcall(Anim.play, { sequence = "Workspace.Nope" })
nextRelayAnswer = nil
assert(not okFail and failErr.code == "ANIMATION_PLAY_FAILED", "a client refusal becomes ANIMATION_PLAY_FAILED")
assert(string.find(failErr.message, "sequence not found", 1, true), "the client's reason survives")

-- A replaced earlier track is passed through, so the reply can say so.
nextRelayAnswer = { ok = true, animationId = "session-hash", length = 1, replaced = 1 }
assert(Anim.play({ sequence = "Workspace.Seq" }).replaced == 1, "`replaced` reaches the reply")
nextRelayAnswer = nil

-- `stopPlay` runs the same relay in stop mode: no sequence, the rig passed on,
-- the same modules cloned, and a refusal mapped to its own code.
nextRelayAnswer = { ok = true, stopped = 2 }
local stoppedReply = Anim.stopPlay({ rig = "Workspace.OtherRig", player = "P2" })
call = relayCalls[#relayCalls]
assert(call.name == "MCPAnimStopRelay")
assert(call.attributes.Mode == "stop", "the relay is told to stop")
assert(call.attributes.Sequence == nil, "stop needs no sequence")
assert(call.attributes.Rig == "Workspace.OtherRig")
local stopCloned = 0
for _ in call.relay:GetChildren() do
	stopCloned += 1
end
assert(stopCloned == 2, "Paths and Dispatch go with the stop relay too")
assert(stoppedReply.stopped == 2)
nextRelayAnswer = { ok = true }
assert(Anim.stopPlay({}).stopped == 0, "an answer without a count means none stopped")
nextRelayAnswer = { ok = false, reason = "the local player has no character" }
local okStop, stopErr = pcall(Anim.stopPlay, {})
nextRelayAnswer = nil
assert(not okStop and stopErr.code == "ANIMATION_STOP_FAILED")

-- The root pose comes from the rig when one is given. A Blender import's root
-- is not called HumanoidRootPart, and nesting everything under a pose of that
-- name made an animation that played and moved nothing.
local function chainTo(joint)
	local sequence = registered[#registered].sequence
	local keyframe = sequence:GetKeyframes()[1]
	local function find(pose, trail)
		table.insert(trail, pose.Name)
		if pose.Name == joint then
			return table.concat(trail, "/")
		end
		for _, kid in pose:GetChildren() do
			local hit = find(kid, table.clone(trail))
			if hit then
				return hit
			end
		end
		return nil
	end
	return find(keyframe:GetChildren()[1], {})
end
local twoFrames = function(poses)
	return { { time = 0, poses = poses }, { time = 0.5, poses = poses } }
end

defineRig("Workspace.Blender", { { "Root", "Hips" }, { "Hips", "Spine" }, { "Spine", "Arm" } })
local blender = Anim.build({ rig = "Workspace.Blender", keyframes = twoFrames({ Arm = "0, 1, 0" }) })
assert(blender.root == "Root", "the rig's own root part is used, got " .. tostring(blender.root))
assert(chainTo("Arm") == "Root/Hips/Spine/Arm", "posed along the rig's real chain, got " .. tostring(chainTo("Arm")))
assert(blender.unmatchedJoints == nil and blender.unrootedJoints == nil)

-- An explicit `root` still wins.
assert(Anim.build({ rig = "Workspace.Blender", root = "Hips", keyframes = twoFrames({ Arm = "0, 1, 0" }) }).root == "Hips")

-- A character rig lands on HumanoidRootPart, exactly as before.
defineRig("Workspace.R15", { { "HumanoidRootPart", "LowerTorso" }, { "LowerTorso", "UpperTorso" } })
assert(Anim.build({ rig = "Workspace.R15", keyframes = twoFrames({ UpperTorso = "0, 1, 0" }) }).root == "HumanoidRootPart")

-- Several roots (a `rig` holding two models): the PrimaryPart settles it, and
-- a joint on the other model is reported as never reaching it.
defineRig("Workspace.Pair", { { "A", "B" }, { "C", "D" } }, "C")
local pair = Anim.build({ rig = "Workspace.Pair", keyframes = twoFrames({ B = "0, 1, 0", D = "0, 1, 0" }) })
assert(pair.root == "C", "PrimaryPart settles several candidates, got " .. tostring(pair.root))
assert(pair.unrootedJoints ~= nil and #pair.unrootedJoints == 1 and pair.unrootedJoints[1] == "B", "B's chain never reaches C")

-- Joints that loop (same-named parts jointed both ways) no longer overflow
-- the stack; the loop is reported instead.
defineRig("Workspace.Loop", { { "X", "Y" }, { "Y", "X" }, { "Root", "Z" } })
local okLoop, loop = pcall(Anim.build, { rig = "Workspace.Loop", keyframes = twoFrames({ X = "0, 1, 0", Y = "0, 1, 0", Z = "0, 1, 0" }) })
assert(okLoop, "a joint loop is survived, got " .. tostring(if typeof(loop) == "table" then loop.message else loop))
assert(loop.root == "Root")
assert(loop.unrootedJoints ~= nil and #loop.unrootedJoints == 2, "both looping joints are reported")

print("anim build: padding, preview-only labelling and kept instances pass")
print("anim play: relay wiring, rig fallback and failure mapping pass")
