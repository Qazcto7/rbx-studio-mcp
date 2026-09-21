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

print("anim build: padding, preview-only labelling and kept instances pass")
