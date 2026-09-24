local Playtest = ...
assert(Playtest.isAllowed(), "no setting defaults to ON")
setup(Playtest)
assert(Playtest.isAllowed() and writes == 0)
Playtest.control({op = "play"})
assert(launches[1] == "play")
Playtest.setAllowed(false)
Playtest.stopLocal()
assert(not running and ended == 1, "OFF stops a running MCP playtest")
for _, op in {"play", "run", "multiplayer"} do
 local ok, err = pcall(Playtest.control, {op = op})
 assert(not ok and err.code == "PLAYTEST_DISABLED", op .. " must be locked")
 assert(err.message == "Playtests are disabled by the user.")
 assert(err.hint == "Do not start or simulate a playtest. Continue using edit-mode tools and static inspection where possible.\nRun `playtests on` in the Studio MCP panel to re-enable playtesting.")
end
assert(#launches == 1)
assert(Playtest.control({op = "state"}).state.playtestsAllowed == false)
running, runMode = true, true
Playtest.control({op = "stop"})
assert(not running and stopped == 1, "stop remains allowed")

local restarted = loadModule()
setup(restarted)
assert(not restarted.isAllowed(), "saved OFF survives a fresh module")
restarted.setAllowed(true)
assert(#launches == 1, "ON never launches a test")
assert(Playtest.isAllowed(), "other contexts read the current saved setting")
for _, op in {"play", "run", "multiplayer"} do
 restarted.control({op = op})
 restarted.stopLocal()
end
assert(#launches == 4, "ON restores all three start modes")
local fresh = loadModule(); setup(fresh)
assert(fresh.isAllowed(), "saved ON survives restart")

-- A start queued before OFF must not reach Studio after OFF.
deferLaunch = true
fresh.control({op = "play"})
fresh.setAllowed(false)
queued[1]()
assert(#launches == 4 and string.find(fresh.control({op = "state"}).state.lastError, "PLAYTEST_DISABLED"))
-- No automatic state-change enforcement: a user's manual Play is not cancelled.
running = true
assert(fresh.control({op = "state"}).state.isRunning)
assert(running)
clientContext = true
fresh.stopLocal()
assert(left == 1 and not running, "client panel can stop without HTTP")

-- A start that never returns: refused as ALREADY_RUNNING while young, and only
-- `stop` clears it once it is old enough to be abandoned rather than slow.
local wedged = loadModule(); setup(wedged); wedged.setAllowed(true)
running, runMode, clientContext = false, false, false
deferLaunch = true
queued = {}
wedged.control({op = "play"})
assert(wedged.control({op = "state"}).state.testPending, "the start is pending")
local okEarly, early = pcall(wedged.control, {op = "play"})
assert(not okEarly and early.code == "ALREADY_RUNNING", "a second start is refused")
assert(string.find(early.hint, "poll op 'state'", 1, true), "a young pending start says to poll")
fakeNow += 60
local young = wedged.control({op = "stop"})
assert(young.state.testPending and not young.changed, "a 60s-old start is treated as slow, not stale")
fakeNow += 70
local okLate, late = pcall(wedged.control, {op = "play"})
assert(not okLate and string.find(late.hint, "Call op 'stop'", 1, true), "an old pending start says stop clears it")
local cleared = wedged.control({op = "stop"})
assert(cleared.changed and not cleared.state.testPending, "stop clears a start that never returned")
assert(string.find(cleared.reason, "never returned", 1, true))
local launchesBefore = #launches
wedged.control({op = "play"})
assert(#queued == 2 and #launches == launchesBefore, "a new start is accepted (queued) after the clear")
assert(wedged.control({op = "state"}).state.testPending, "and it is the new one that is pending")
-- The abandoned launch returning late must not clear the new one's flag.
queued[1]()
assert(wedged.control({op = "state"}).state.testPending, "a superseded launch cannot clear the current one")
deferLaunch = false

-- The reaper needs edit mode to be KNOWN. pending stays true through a whole
-- healthy test, so an unreadable EditModeActive must not turn a long-running
-- test into an "abandoned start".
local unknown = loadModule(); setup(unknown); unknown.setAllowed(true)
running, runMode, clientContext = false, false, false
deferLaunch = true
queued = {}
unknown.control({op = "play"})
StudioTestService.EditModeActive = nil
fakeNow += 200
local keptUnknown = unknown.control({op = "stop"})
assert(keptUnknown.state.testPending and not keptUnknown.changed, "unreadable edit mode: not reaped")
local okUnknown, stillUnknown = pcall(unknown.control, {op = "play"})
assert(not okUnknown and string.find(stillUnknown.hint, "poll op 'state'", 1, true), "and not told stop will clear it")
StudioTestService.EditModeActive = false
local keptRunning = unknown.control({op = "stop"})
assert(keptRunning.state.testPending, "a test that is running (edit mode false) is not reaped")
StudioTestService.EditModeActive = true

-- A reaped launch that comes back late does not write a result for a test
-- nobody is waiting on.
local lateOne = loadModule(); setup(lateOne); lateOne.setAllowed(true)
queued = {}
lateOne.control({op = "play"})
fakeNow += 200
assert(lateOne.control({op = "stop"}).changed, "reaped")
playResult = "stale result"
queued[1]()
playResult = nil
assert(lateOne.control({op = "state"}).state.lastResult == nil, "a reaped launch's late result is dropped")
deferLaunch = false
print("playtests: defaults, persistence, guards, stop and queued-start lock pass")
