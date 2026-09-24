# Changelog

What changed in each release, written for people using the server rather than for people reading the diff.

## Unreleased

Fixes for running Studio under Wine/Vinegar on Linux, found while using the server there day to day.

This fork is merged with upstream 0.8.0 but **keeps the `animation` tool**, which upstream removed in 0.8.0 without a stated reason: `read`, `build`, `preview` and this fork's `play` are all still here.

### Fixed
- **Stale plugin on Linux.** `--install-plugin` now finds Studio's plugins folder under Vinegar (native and Flatpak) and Wine prefixes and installs into every one it finds, instead of exiting on Linux. `STUDIO_MCP_PLUGINS_DIR` overrides the search. `doctor` checks each folder against this package's build id and flags a stale or truncated file.
- The stale-plugin advice no longer says to click into the Studio window: that does not reload a plugin. It says to reinstall and quit Studio completely.
- `animation op="preview"` no longer times out on single-keyframe (zero-length) animations. `build` pads an animation whose keyframes are all at time 0 with a repeat of the last one 0.1s later (and says so), and `preview` does the same to a zero-length id it is handed.
- `input`: a `click` with `action="release"` used to press and then release the button; it now only releases. A press on a button that is already down (`duplicate button state`) is repaired instead of failing the step, and a tap is always released even if the relay is torn down mid-step.
- `execute_luau target="client"` with the new `settleSeconds` failed on every call: the variable was used without being declared. Fixed, and covered by a test that drives the client path.
- Bridge failover: `probeOwner` reused a keep-alive connection to a bridge that had just gone away and read the dead socket as "nobody home", so a takeover would sometimes not happen (the failover test failed about half the time). A refused or reset connection is now retried once; a timeout or an actual answer is judged as it stands.
- `FailoverBridge.close()` now waits for a takeover already in progress, so a bridge closed while promoting no longer ends up holding the port with nothing to close it.
- The panel's size-saving guard read an undeclared `unloading`, so it never guarded anything and a collapsing widget could overwrite the saved size. It is now declared and set when the plugin unloads.
- `doctor` compares installed plugins with the hash of the plugin sources, as `studio_status` does, instead of `build/plugin-build-id.txt`, which is stale after a pull that has not been rebuilt.
- `playtest`: a `play` whose start never returned left the plugin "pending" forever, so every later `play` was refused with ALREADY_RUNNING for a test that did not exist (and `list_studios` showed none). `stop` now clears a start that has been pending for 2+ minutes with Studio in edit mode, and the ALREADY_RUNNING error says how long it has been pending and whether to poll or `stop`. A launch that was cleared and returns late can no longer clear its replacement's state.
- `input`: a right (or middle) click was reported as "the client read no pointer event, so it did not register at all" even though it had been delivered and read. The watcher that reports where a click landed only listened for the left button and touch. It now reads every pointer button, and a plan that only releases buttons no longer gets the warning (a release produces nothing to read).
- Installing on a Vinegar prefix that redirects `Local AppData`: Vinegar writes `User Shell Folders\Local AppData` into the prefixes it creates, pointing Studio's `%LOCALAPPDATA%` at `~/.local/share/vinegar/appdata` (outside the prefix), so plugins are read from there and the folder inside the prefix is never used. The installer and `doctor` now read the prefix's `user.reg` and include that folder first, instead of finding nothing (or an unused folder) on such a prefix.
- `check:plugin` (and so `build:plugin` and `npm test`) now fails on any name that is neither declared nor a Roblox global; this is how the two undeclared-variable bugs above went unnoticed.
- `screenshot`: a `CaptureService:CaptureScreenshot` callback that never fires -- measured under Wine, an occasional one-off -- used to fail the call outright as `CAPTURE_REFUSED`/`CAPTURE_TIMEOUT` on the very first miss. Both the editor-side capture and the playtest-client relay now retry once (a short pause, then one more try) before giving up, and report both attempts' failures when they do. The client relay's own capture deadline is generated from the same `CAPTURE_TIMEOUT` constant the editor path uses, instead of a second hardcoded number that could drift from it, and `CLIENT_TIMEOUT` (the server's wait for the client's answer) is raised from 25s to 30s to comfortably fit two attempts.
- `doctor`: on a machine with more than one plugin install (native + Flatpak Vinegar, several prefixes), a connected Studio's report now says which installed copy its build id matches -- `Loaded from: <label> (<dir>)` -- instead of only saying whether it is current. Narrows to a list when several installs share the same build id, and says so plainly when none of them match.
- `input`: a button left down by an earlier call whose own cleanup never ran (Studio force-closed, the relay's process killed) used to stay stuck until the next plan happened to press it -- a stuck right button turns the camera on every pointer move. Every relay now releases the mouse buttons before its own plan runs, with three exceptions that the first version of this change got wrong: a button an earlier call deliberately left down with `press` is left alone (the server remembers holds per player and per playtest, so a drag or held fire split across two calls works again, and the reply lists them as `held`); a plan containing `release_all` is left to report what it finds itself, instead of every button reading "already up"; and a button is only reported as "left down from an earlier call" when `UserInputService:IsMouseButtonPressed` confirms it was down, so an engine that silently accepts releasing an up button does not produce three false warnings on every call.
- A tool call that times out while a `playtest` start or stop is already in flight on the same session (a genuinely slow transition under Wine, not a hang) now says so specifically -- "Studio is currently starting a playtest (that call has been waiting Ns)" -- and the hint says not to resend the call and to poll `playtest state` instead, rather than the previous generic "usually compiling, mid-playtest transition, or blocked on a modal" guess. That guess still applies, unchanged, when nothing more specific is known.
- `playtest`: a pending `play`/`run` start that has been slow for a while and one that is actually stuck read identically -- both just said "keep polling". Past 120s (the same threshold `stop` itself uses to recognize an abandoned launch) the note now says this is stuck, not slow, and that `stop` will clear it. Both notes apply only while Studio is still in edit mode: `testPending` stays true for the whole test, so without that check a healthy test running for 2+ minutes was told it was stuck and to `stop` it (introduced by the first version of this change, fixed before release). The "stuck" advice is only given when edit mode is positively confirmed, never when it cannot be read.
- `create` never showed the preview-only-id warning: it checked the request after property typing had rewritten `AnimationId` into `{ value, type }`, a shape the check did not recognise, so creating an Animation with a bare `build` hash -- the T-pose trap -- went through silently (`modify` was unaffected). It now checks the request as sent, and recognises the typed `{ type, value }` form a caller can also send directly.
- `screenshot`: a playtest-client capture's description now says that local-only rendering (a script hiding the character via `LocalTransparencyModifier`, a manually driven `CurrentCamera`) shows up in the picture too -- so an empty or unexpected shot from a playtest client is not automatically a capture failure.

- `input` `release_all`: a button whose release failed was reported as "Every button was already up" -- the agent was told nothing was stuck exactly when a release had not happened. Failures are now named ("COULD NOT RELEASE MouseButton2"). A `key` given to `release_all` was always reported as "sent" (so "something had it held"), even when it was up; keys now report "sent" / "already up" like buttons.
- `animation op="play"`: repeated plays stacked -- every call started a new track and nothing stopped the old ones, so five plays of a looping animation ran five tracks at full weight. Tracks `play` starts are now tagged, and each `play` stops and destroys the previous ones on that rig first (reported as `replaced`); the game's own animations are never touched.
- `animation op="stop"` could not stop what `play` started, although the reply said it could: it runs in the session it is sent to and resets the rig's joints, which never reaches a track playing on a client's Animator. Sent to a playtest's studioId it now stops the tagged tracks on the client (`rig` optional, defaults to the player's character); sent to the editor it clears a preview, as before.
- `animation op="play"` failed at once if the character had not spawned yet or its Humanoid had not replicated, despite a timeout sized "for a character that has not finished spawning". It now waits for them (8s / 5s), and waits briefly for the server's Animator before creating its own -- a second, client-made Animator stops the animation replicating to other players.
- `animation`: `parent` suggested `ServerStorage`, where `play` -- which runs on the client -- can never find the sequence. It now suggests `ReplicatedStorage` or the rig/Tool and says why. A `build` whose `parent` could not be kept now says NOTHING WAS KEPT and why, instead of "Pass `parent`". `assetId` is documented for `preview` too, and the panel shows `anim.read` as a read.
- `animation op="build"` with a custom `rig` (a Blender import whose root part is "Root", a weapon) nested every pose under a "HumanoidRootPart" pose the rig does not have, so the animation played and moved nothing, with no warning. The root is now read from the rig's own joints (the part that moves others and is moved by none; `HumanoidRootPart` or the `PrimaryPart` when there are several), `root` still overrides it, and the reply says which root was used. Joints whose chain never reaches that root are listed as `unrootedJoints`. A rig whose joints loop no longer crashes the build with a stack overflow.
- `animation op="preview"` added an Animator to a rig that had none outside any undo recording, so it stayed in the place (and was saved with it) with no Ctrl+Z; `stop` even created one on a rig that had never been previewed. The Animator is now added as an undoable step, marked as preview's own, and `stop` removes it again (a rig's own Animator is left alone); `stop` on a rig with no Animator changes nothing. A preview that timed out also left its track on the Animator; it is destroyed now. `stop` on a rig with no Animator still resets its joints, since a preview's pose outlives an Animator whose creation was undone.
- Finding Studio's plugins folder under Wine: a Vinegar `Local AppData` redirect to a path with any non-ASCII letter (a Turkish or accented home folder name) was silently lost, because Wine's `\x` escapes in `user.reg` were read as literal text; they are now decoded as Wine decodes them (hex, octal and control escapes). A `%USERPROFILE%` value in `User Shell Folders` now falls through to the resolved `Shell Folders` value instead of ending the search. A redirect only counts when Studio has run there (a `Roblox` folder inside), the same test the in-prefix folders already had, so an unrelated prefix is not installed into. One install reached through a symlink is listed once, not twice. The default, already-expanded `Shell Folders` value Wine writes in every prefix (the profile folder itself) is not mistaken for a redirect.
- `check:plugin` now also analyses the client relays -- the Luau inside `[==[ ... ]==]` strings in Input, Capture, animation play, exec and debug -- which it had never seen a line of, so a mistyped name in a branch their tests do not drive would have shipped (it found one shadowed local straight away, now renamed). It also requires every plugin file to be `--!strict`: in a non-strict file the analyser does not report a global that is written in one function and read in another, which is the exact shape of the two undeclared-variable bugs this check was added for. It also no longer passes in silence when it could not analyse anything: a missing `luau-analyze` is a loud warning locally and a failure in CI, and an analyser that cannot run fails the check.
- `playtest op="stop"`'s clearing of a start that never returned now needs Studio's edit mode to be confirmed, not merely not contradicted: when `EditModeActive` could not be read, a healthy test running for 2+ minutes looked like an abandoned start and was cleared, letting the next `play` start a second test on top of it. A cleared launch that returns late can no longer write its result into state.
- A timeout while a playtest start is in flight used to replace the "never reached Studio -- the window may have lost its connection" advice outright with "Studio is busy, poll `playtest state`". When the command was never delivered both are possible, and a `state` poll would sit in the same queue, so the busy advice now leads and the lost-connection one follows it.
- `--install-plugin` stages its copy under a per-process name, so two installs at once cannot move each other's half-written file into place. The package and README say 35 tools (this fork keeps `animation`).
### Added
- `animation op="play"`: loads and plays a kept KeyframeSequence (from a prior `build` called with `parent`) on a running playtest's client in one call -- registers it, finds the right Animator (creating one if the rig has never played anything), loads, and plays, with a specific reason on failure at each step. This replaces the four lines of client Luau the `build` reply used to hand back for the agent to paste into `execute_luau target="client"`, which was real friction: shipping an animation that actually plays in a playtest was the one thing this server could describe but not do.
- `input` step `kind="release_all"`: releases every mouse button (and an optional `key`) and reports what it found, as the way out of a stuck button.
- `animation op="build"` takes `parent`, which keeps the built KeyframeSequence in the place as a real instance so the client can register it with `KeyframeSequenceProvider:RegisterKeyframeSequence`. This is the way to ship an animation to a real playtest.
- `execute_luau target="client"` takes `settleSeconds`, which keeps the relay alive after the chunk returns so `task.spawn` threads can finish, and warns when code spawns threads without it.
- `create`/`modify` warn when a bare-hash id from `animation op="build"` is written to an `AnimationId`: those ids are preview-only, and loading one in a playtest breaks the character's whole Animator.
- `playtest op="multiplayer"` is refused on Linux unless `force: true` (or `STUDIO_MCP_ALLOW_MULTIPLAYER=1`); it is unreliable under Wine and has crashed Studio. A `play` that is slow to start now says to poll `state` rather than send it again.

## 0.8.0

### Added
- `screenshot` can zoom: `path` (a GUI, part or model) or `rect`, at full resolution.
- Colors can be written as hex, e.g. `"#FF8800"`.

### Changed
- `script_edit` and `script_create` are up to 50x faster.
- Sharper screenshots (better downscaling).
- Smaller tool replies (compact JSON), so agents use fewer tokens.
- Faster first `create` / `modify` / `inspect`.
- Removed the `animation` tool.
- Dependencies updated.

### Fixed
- `create` works with Gemini / Vertex AI, and nested children are validated again.
- `script_edit` no longer removes the script's final newline.
- Instances named like `x[1]` can be found by path.
- A 12-number `CFrame` gets the right rotation.
- Client logs survive a player respawn.
- Property checking recovers after a network error.
- Missing arguments are reported as errors.
- `api` and `inspect` no longer list deprecated or unusable members.
- The server can no longer crash on odd output from a panel agent.
## 0.7.8

### Added
- `console target="client"` reads continuously captured playtest client prints, warnings and errors, with player selection in multiplayer and stack/source details when available.
- `console` returns `nextCursor`; passing it as `since` reads only newer matching output and reports any lines lost to buffer eviction or the response limit. Cursors are tied to one session and player.
- `playtest op="play"` and `op="multiplayer"` return the connected playtest server `studioId` and available player names directly. If the server has not connected within the wait, the start still succeeds and explains how to find it later.

## 0.7.7

### Fixed
- Studio's 30-minute reconnect no longer drops calls in flight or the chosen Studio.
- Place name stays correct after a reconnect.
- Calls no longer hang when a result can't be sent as JSON.
- Long-poll no longer loses commands.
- Big scripts reach Studio much faster.
- Stopping an agent from the panel can't crash the server.
- Small fixes: network timeouts, safer credentials save, clearer errors.

## 0.7.6

### Fixed
- Fix #4: decimal `input` hold/after values now produce integer millisecond deadlines, retaining the existing timeout padding. Bridge boundaries also normalize and validate deadlines for other tools.
- Peer/proxy calls no longer report local timeout or AbortSignal setup errors as `OWNER_GONE`.
- Clarify that client execution connections/hooks do not persist after the temporary relay call returns.

## 0.7.5

### Fixed
- `input` no longer fails on key sequences longer than 20 seconds.

## 0.7.4

- Extend `execute_luau` with `target="client"` and optional `player`, running in the actual playtest client VM with bounded structured returns and captured output.
- Share temporary relay setup, player selection, acknowledgement deadlines and cleanup with `input`.
- Support client GUI paths on click/text input steps; resolve current geometry and focus TextBoxes before typing.
- Add passive `debug op="remotes"` captures for a selected playtest player: both RemoteEvent directions, counts/rates and bounded argument-shape samples. No RemoteFunction interception.
- Add persistent panel `playtests [on|off]` controls: default ON grants permission without overriding project/user instructions; OFF stops detected tests and blocks MCP starts while preserving state/stop, edit-mode execution and inspection, and manual Studio Play.
- Preserve existing Studio/live execution and coordinate input. No new top-level tools.

## 0.7.2

### Fixed
- Big scripts no longer time out in `script_create` or `script_edit`. Studio splits large messages, and the plugin was dropping them.
- `script_create` handles scripts of 200,000+ characters, which Roblox refused before.
- `script_read` cuts long scripts on a whole line and says which `startLine` to read next.

### Changed
- New `npm run test:live` checks big scripts against a real Studio.
- Tests no longer need a fixed free port.
- Dependencies updated.

## 0.7.1

### Fixed
- The panel stays where you dock it, instead of floating in the middle every time a place is opened.
- The panel no longer opens over the game during a playtest. Studio will not dock it there, so it stays shut; the toolbar button still opens it.
- `input` no longer dies on a key Roblox reserves (Escape, Tab, F9). It names the key and runs the rest of the steps.

## 0.7.0

### Fixed
- A crashed Studio no longer blocks every tool with `AMBIGUOUS_STUDIO`.
- The panel's `use` command now works for tool calls.
- Panel prompts with `&`, `"` or `%` no longer break on Windows.
- `geometry mesh` and `mirror` work without a `path`.
- `inf` and `nan` values read correctly.
- `execute_luau` keeps `nil` returns and flags errors.
- `tree` shows top-level items first.
- `script_edit` returns the new `rev`.

### Changed
- Dependencies updated.

## 0.6.9

### Fixed
- **The MCP server now reports the package version instead of a stale hardcoded `0.3.5`.** Future version bumps are picked up automatically from the package metadata.

## 0.6.8

### Fixed
- **Live calls can no longer hit the wrong game.** `cloud place` is sticky and Studio's place is not, so opening a different experience left every live call pointing at the old one — reading another game's player data, restarting its servers, with a plausible success message and no error. They now refuse when the target is not the place open in Studio. Pass `universeId` or `placeId` to override on purpose.

## 0.6.7

### Added
- **`collision` cast and overlap** — find what is physically there: a door clipping a wall, a blocked sightline.
- **`geometry mirror`** — flip things across a plane. Studio cannot do this.
- **`assets insert stripScripts`** — take a free model's geometry without its code.
- **`audio`** — build and read the modern audio graph, and find the broken wire that makes it silent.
- **Open Cloud**, via one key set with `cloud` in the panel: upload files, read and write the **live** game's player data, run scripts on the published place, restart servers, ban players.

### Fixed
- **Hinges and rigs work in one `create` call.** References to siblings resolve now; they needed two calls before.
- **`NumberRange`, `ColorSequence`, `NumberSequence` and `Rect` can be written**, not just read. Recolouring a ParticleEmitter or UIGradient works.
- **Asset properties can be set at all** — `SurfaceAppearance.ColorMap`, `AudioPlayer.AudioContent` and every other `ContentId`/`Content`.
- **A missing instance names the path** instead of blaming the type.

## 0.6.5

### Added
- **Animations**: read, build and preview them on a rig without leaving edit mode.
- **Data stores**: read and write saved player data, including old versions of a key.
- **UI audit** finds interface faults a phone shows and a monitor hides.
- **Tag list**, **asset audit**, **audio search**, **network simulation**, **pathfinding in playtests**.

### Fixed
- **Instance properties can be set at all** — `Part0`, `PrimaryPart`, `Adornee` and friends. Rigs and welds no longer need `execute_luau`.
- **`FontFace` works**, so UI can be built.
- **Built animations actually move the rig.** Poses were attached in the wrong order and the engine ignored them silently.
- **`animation stop` restores the rig** instead of leaving it bent.
- **Clicks land where you aim them.** The coordinate advice was backwards.
- **`performance audit` can no longer hang Studio.**
- **Centre of mass is the real one**, not always zero.
- **Collision groups list in words**, not bitmasks.
- **The Studio panel names every call.** 26 of 72 said nothing useful, and writes were labelled as reads.
- **Panel times are honest**: a median instead of an average one slow call could ruin, and `<1ms` instead of `0ms`.

## 0.6.1

### Added
- **`autoopen off`** stops the panel putting itself on screen — not when a place opens, not when you press Play. The toolbar button still opens it. `autoopen on` puts it back; `autoopen` says which it is.

## 0.6.0

- README: the dsh section now prints the plugin row itself, and names the file to paste it into. It pointed at a path inside `node_modules`, which is not there when the server is run through `npx`.

## 0.5.8

### Added
- **A command menu above the prompt.** Click the bar and every command is listed with what it does. Keep typing to filter, scroll for the rest, click one to fill it in.

### Fixed
- **The prompt no longer keeps the cursor after a command runs**, so the reply is not covered and clicking the bar always reopens the menu.
- **Using DeepSeek Harness?** `config/dsh.cordis.yml` now ships inside the npm package, so `dsh --patch` can point at it without cloning the repo.

## 0.5.6

### Fixed
- **CI was red since 0.5.0: a bridge reply kept its socket alive.** One-shot JSON responses now close the connection, so a client's `fetch` pool can't reuse a socket to a server that has since closed and fail with "other side closed".

## 0.5.5

### Fixed
- **A raw `TypeError: fetch failed` during a bridge handover.** When the server holding the port exits mid-reply, the borrower now reports `OWNER_GONE` and says to retry, instead of surfacing a Node socket error. Only the network call was guarded; reading the reply was not.

## 0.5.4

- README cut to half its length: install, tools, panel, done.

## 0.5.3

### Fixed
- **Every tool call was logged twice** — once by Studio with a readable name and a duration, once by the agent. The agent's copy is dropped for `rbx-studio` calls; tools Studio never sees still appear.
- **opencode's naming of our tools is recognised**, so a call reads `studio_status` rather than `rbx-studio_studio_status`.

## 0.5.2

### Added
- **Six more coding agents** the panel can run: Amp, Qwen Code, Factory Droid, goose, GitHub Copilot CLI and Aider. Thirteen in total, each built against its documented headless output rather than a guess.

### Fixed
- **Output nobody can parse is now shown instead of dropped.** Every adapter discarded lines it did not recognise, which is exactly how opencode managed to print a blank run.

## 0.5.1

### Fixed
- **opencode printed nothing.** Its adapter was built on event names opencode does not emit, so every line was discarded and a prompt logged a blank run. Rebuilt from a recorded run.
- **Codex never resumed a conversation**, and follow-up turns were refused outright: the session id was read from the wrong field, and global flags were placed after the `resume` subcommand, which codex rejects.
- **Crush was launched with a flag it rejects.** It takes `run <prompt>`, not `-p`.
- **Gemini and Cursor now stream properly** instead of being treated as plain-text unknowns.
- **The panel asks which agent should answer** when more than one is connected to the Studio, instead of picking whichever sorts first. Remembered after you answer once.

## 0.5.0

A command line in the console panel, and terrain.

### Added
- **A prompt row at the bottom of the panel.** Type a command, or type a sentence. History on the arrows, Tab completion, and it shows what you have selected.
- **Commands:** `help`, `doctor`, `status`, `version`, `place`, `clients`, `studios`, `use`, `theme`, `visuals`, `log`, `clear`, `copy`, `port`, `reconnect`, `agent`, `stop`.
- **Anything that is not a command goes to a coding agent.** The bridge starts whichever one is on PATH — Claude Code, Codex, opencode, Gemini, Cursor, dsh — and its work streams into the log. `stop` cancels it.
- **DeepSeek Harness (dsh) support**, both ways: this server registers as a dsh plugin, and dsh can run your prompts.
- **`terrain`** — `fill` (block, ball, cylinder, wedge, one undo step), `replace` a material in place, `clear`, `stats`. Fill with `Air` to carve caves.
- The activity cell keeps moving while an agent thinks.

### Fixed
- **Script edits could be lost silently.** A write to a just-opened editor tab reported success and was then overwritten by the editor finishing its load. Writes are read back now.
- **Screenshots said nothing when nothing was rendered** — a script tab in front of the 3D view returned a flat rectangle, reported as an ordinary picture.
- **An agent started from the panel is no longer counted as a stranger.** It logged "2 MCP clients connected" on every prompt and lingered after `stop`.
- **Panel prompts say they come from Studio**, so "create a script" no longer sends the agent to the filesystem.
- Log lines wrap under themselves, render markdown, and no longer chop a message to fit the note beside it.
- `copy` writes the log as comments. `stop` kills the agent's whole process tree.

### Changed
- Dependencies bumped; `hono` to 4.13.7, clearing a moderate advisory reached through the MCP SDK.

## 0.4.6

Same as 0.4.5, republished so the npm package matches. README rewritten and brought up to date.

## 0.4.5

3D generation, one tool for every mesh operation, and a panel that opens.

### Added
- **`generate`** - 3D models from a text prompt, through Roblox's Cube model. `Body1` for props, `Car5` for a body and four named wheels a script can drive, or your own part names.
- **`geometry`** now covers every mesh operation: the boolean ops plus `fragment`, `segment` (cut a mesh into parts you name) and `sweep` (the volume a part moves through, and what it would hit on the way).
- **`script_edit` can refuse a stale write.** `script_read` prints a `rev`; pass it back and an edit is refused if the script changed since you read it.
- **`npx rbx-studio-mcp doctor`** - a health check with a fix on every line.
- **The clients badge says who is connected**, by name, with process id and uptime. Hover it, or click for the full list.
- **`assets op="bake"`** converts editable mesh and image data to static content, and **`viewport op="textbounds"`** answers whether text fits its label.

### Fixed
- **The panel stopped opening on its own.** A close is now only remembered when the toolbar button did it, so Studio closing a place can no longer be recorded as you closing the panel. Closing with the X is not remembered, so the panel comes back next launch.
- Running `doctor` appeared as a second connected client for 90 seconds. Reading the roster no longer joins it.
- Segmenting a mesh lost its scale and its texture.
- Collision groups go through `Workspace` instead of the deprecated `PhysicsService`.

### Known limits
- Generated meshes are edit-mode only. Their content reads as empty inside a playtest, and `bake` cannot convert it.

## 0.4.2

### Fixed
- The panel stopped opening on its own. Studio disables the widget while closing a place, and that was recorded as the user having closed it. A close now has to last a second before it counts.
- The plugin sometimes did not load at all. The installer overwrote the file in place while Studio was reading it. It now writes beside it and renames over.

### Changed
- Dependency and GitHub Action versions bumped.

## 0.4.1

### Fixed
- The console showed DISCONNECTED while the agent was working. Reconnect backoff never reset after a good connection, so it waited the full 30s between attempts that were succeeding.
- Closing the server that held the port killed the connection for every other one. Another now takes the port over in a few seconds.

## 0.4.0

The connecting wave and the call history share one grid.

### Fixed
- **The wave overlapped the bars already in the trace.** It sat on its own spacing, so on a reconnect its columns landed between and behind the history at a different pitch. Both now use the same slots: history fills from the right, the wave fills only what is left of it.
- **The history stood still while the wave rolled past it.** The bars are now lifted by the same swell, against the height each one has left, so the strip moves as one surface. Hover still reports the recorded time.

## 0.3.9

The console shows what it is doing while it connects.

### Added
- **The activity trace waves while the plugin is connecting.** It used to sit as a bare baseline, which looks the same as a panel that has died.
- **A flourish when a session lands.** A bright front runs across the trace on connect, once per real connection.
- **The clear button switches the log off like a CRT.** The picture collapses to a bright line, flashes, and blinks out.

All three are drawn by whichever preset is active, so each of the eight has its own.

## 0.3.8

Screenshots say when they came back black.

### Changed
- **A screenshot that is entirely black now says so.** It used to look like a valid picture of a dark scene, so an agent would read it and carry on. Usually it means Studio was not rendering — minimised, covered, or on another virtual desktop.
- **Playtest screenshots wait for a rendered frame** before capturing, instead of shooting on the frame the capture script lands.

## 0.3.7

The console log survives a playtest in both directions.

### Fixed
- **The console emptied when a playtest started and again when it stopped.** Studio loads the plugin separately into the editor and into the playtest, each with its own blank log, and shows you whichever view is current — so the session you were watching appeared to be wiped, then the playtest's work vanished from the editor's log on Stop. The rows you had are now carried into the playtest, and calls made during it are carried back out.

## 0.3.6

A rolled-back edit can no longer be redone, typing into a text box actually types, and the console keeps working while you playtest.

### Fixed
- **A rolled-back batch could be brought back with one Ctrl+Y.** `modify` said "nothing was changed" and meant it, but Studio filed the cancelled edit on the redo stack — so a single redo re-applied the half-finished state the rollback existed to prevent.
- **`input` reported typing text that never arrived.** A synthetic click does not give a TextBox focus, and `text` steps go to the focused box, so they did nothing and still returned success. The box under the click is focused now, and a step with nowhere to type says so.
- **`device` blamed the device id during a playtest.** A valid id came back as `NO_SUCH_DEVICE` with advice to check the spelling. Studio simply refuses device changes while a test runs; it now says that, and points at the edit session, which works.
- **The console came back on the saved theme's shape but the default's colours.** The palette was read before the saved preset was restored.
- **The Void preset strobed after every command.** Its orbit multiplied elapsed time by a speed that changes, so a change in speed jumped the disc instead of accelerating it — worse the longer Studio had been open. Aurora had the same fault when a session went quiet.
- **The activity cell snapped and stalled instead of bouncing.** A reply's impulse drove it into its own size limit while still carrying speed, and long frames dropped motion rather than catching up.
- **The panel vanished on every playtest.** Studio loads the plugin again into the playtest and its widget starts closed; it now opens the way you left it.

### Changed
- **The console keeps working during a playtest.** The view Studio shows you is the client half, which Roblox forbids from making HTTP requests, so it sat on a standby notice while the agent worked. It now mirrors the playtest's server session — the log fills and the activity strip reacts live. One `RemoteEvent` carries it, in the running game only, one-way, never saved with the place.
- `input` no longer suggests reusing a measured click offset: it holds under portrait emulation and with no device, but not in landscape.

### Known issues
- **A playtest opens the panel at the wrong size.** Studio does not restore plugin widget geometry in play mode — `HostWidgetWasRestored` reads false there — and a widget's size cannot be set from code. Studio → Settings → Test → "Load All Built-In Plugins in Test Mode" works around it. [Reported since 2023.](https://devforum.roblox.com/t/widgets-reset-when-playtesting-and-opening-a-new-studio/2946725)

## 0.3.5

Search results stop reshuffling between calls, values written as text land as the right type, and the console panel gets eight colour presets.

### Fixed
- **`find` and `tree` returned rows in a different order every call.** The engine does not order `GetDescendants` stably, and pages are cut by position — so page two came from a different ordering than page one, skipping some instances and repeating others with counts that still looked right. Results are now sorted.
- **A bad cursor silently returned the first page.** Indistinguishable from a genuine first page, so paging could never reach the end. It is an error now.
- **Numbers in a composite value were misread.** `Position: "1e3, 0, .5"` became `1, 3, 0` and reported success. Scalars and composites now read numbers the same way.
- **Anything but exactly `"true"` became `false`.** `Anchored: "True"` silently set the opposite. Near misses are accepted; anything else is refused instead of guessed.
- **Attributes could not hold a Vector3, Color3 or UDim2.** The same text that types a property was stored as a string. Pass `{ type, value }` for any non-scalar.
- **`find` disagreed with `modify` about enum notation.** `"Plastic"` and `"FALSE"` matched nothing while `modify` accepted both. Matching is case-insensitive and takes a bare enum name.
- **A self-referencing table printed as three nested copies.** `execute_luau` now says `<circular reference>`.
- **A backwards line range blamed the file.** `script_read` now names the argument.
- **`api` gave no suggestion for a mistyped class.** It now answers like `create` does.

### Changed
- **The console panel has eight colour presets** — Lattice, Observatory, Orbit, Void, Nebula, Aurora, Phosphor, Blueprint. Hover the tab on its right edge. Each replaces the activity cell's contents, not just its colours, and the choice persists across Studio restarts.
- `debug` now states what breakpoints actually do: they fire once per run rather than once per pass, and a log expression cannot see a loop's control variable.
- `console` no longer claims Studio's own messages never reach the log. Some do, some do not; a quiet log is not an all-clear.

## 0.3.1

Paths with dots in them resolve properly, `script_create` catches a script that would run twice, and the stale-plugin warning stops blaming the wrong side.

### Fixed
- **A path with a dot in a name could not be read back.** 0.3.0 rejoined dotted names but never backtracked, so `Workspace.Dr. Who` failed whenever a sibling named `Dr` existed — a path the tools themselves emit. Resolution now backtracks; a short name that resolves the whole path still wins.
- **The server compared against the sources it started with.** Rebuilding the plugin mid-session left the freshly installed plugin reported as the stale one, with advice that could not help. The fingerprint is re-checked when a source file changes.
- **Two sessions of one Studio could run different plugin builds.** A playtest keeps the plugin it loaded when it started, so a rebuild part-way through splits the two. `list_studios` now says so, names each session's build, and tells you to restart the playtest.

### Changed
- **`script_create` warns about a script that would run twice.** A `Script` with a non-Legacy RunContext inside `StarterGui`, `StarterPack`, `StarterPlayerScripts` or `StarterCharacterScripts` runs once where it sits and again in every player's copy. Studio warns about this in its own Output, which `console` cannot read, so the warning now comes back in the response. Use `LocalScript` there.
- **Better `NOT_FOUND` messages.** An index past the end says how many siblings share the name instead of blaming the wrong segment, and repeated sibling names are counted — `Part (x73)` rather than "Part" 25 times.
- **`console` says what it cannot see.** Messages Studio itself emits, and anything printed on the client, never reach any session's log — a quiet log is not proof nothing was said.

## 0.3.0

`execute_luau` now warns when it is reading a copy of a module instead of the live one, instance names containing dots resolve, and `script_read` can take a different line range per script.

### Fixed
- **`execute_luau` could report a running system as doing nothing.** It runs in the plugin's own Luau VM, which keeps its own `require` cache, so `require(SomeModule)` against a running playtest returns a second, freshly-initialised copy of that module — its counters and caches read as their starting values while the real ones are fine. A zero read that way is indistinguishable from a genuine zero, and there is no API that would let a plugin reach the game's cache, so the result now says so: any call using `require` while the game is running comes back with a note explaining what it actually read and pointing at the DataModel, or the game's own prints via `console`, as the way to see live state. The tool description says it up front too.
- **Instance names containing dots could not be addressed.** Paths are dot-separated, so `Workspace.Dr. Simon.Head` split into a segment named `Dr` and failed. Segments are now rejoined greedily, longest first, when the plain lookup misses — a place holding both `Dr` and `Dr. Simon` still resolves the short name to itself.

### Changed
- **`script_read` takes a line range per script.** An entry may now be `{path, startLine, endLine}` instead of a bare path, so "line 40 of this one, line 300 of that one" is one call rather than one call each. A bare string still reads the whole file, and the top-level `startLine`/`endLine` remain the default for entries without their own.
- **`script_create` waits 60 seconds instead of 15.** A batch of full script sources is the largest payload any tool sends, and the default was timing out on around 12KB across three scripts — splitting the batch is the wrong answer when creating related scripts as one undo step is the point of the tool.

## 0.2.9

A property that exists is no longer reported as a typo, and the stale-plugin warning stops repeating itself.

### Fixed
- **Properties you cannot set were reported as properties that do not exist.** `Lighting.Technology` is real — it is gated behind the RobloxScript identity, which no plugin has — but the name check reads the API dump filtered to what a plugin can reach, so it was indistinguishable from a misspelling. `modify` and `create` now answer with `RESTRICTED_PROPERTY`: "Lighting.Technology exists but is restricted to RobloxScript identity, so no plugin can set it. Change it in Studio's Properties panel (or Game Settings) instead." True of every property at that security level, and of `NotScriptable` ones, not just this one. Real typos still get `UNKNOWN_PROPERTY` and the closest matching names.
- **`inspect` with detail `full` hid the same properties.** "Every readable property" quietly meant "every property a plugin is allowed to see", and the ones it skipped were absent exactly the way a nonexistent property would be. They are now listed by name at the end of the response, with the identity each one needs.
- **The stale-plugin warning repeated on every call, for the whole session.** Four sentences of instructions on every `studio_status`, and once per row in `list_studios` — the same paragraph twice in one response with two Studio windows open. It is now stated in full the first time a build is seen and reduced to a single line after that, and a plugin that genuinely reloads into a different build warns again.

## 0.2.8

Packaging only. No code changes from 0.2.7.

The npm keywords were missing the terms people actually search for — `mcp-server`, `claude-code`, `cursor`, `ai-agent`, `roblox-development` — and keywords only take effect when a version is published, so they needed a release of their own to reach the registry.

## 0.2.7

Four tools that reported something untrue, and the one from 0.2.6 that replaced a wrong answer with another wrong answer.

### Fixed
- **`input` clicks land at an offset, and it now tells you what the offset is.** 0.2.6 said coordinates were out by the ratio between the emulated device's resolution and the screenshot's. Measured against a live playtest, it is a constant translation, never a scale — and it changes with the device and orientation, fitting no formula over resolution, viewport and GUI inset. So the relay now watches what the client actually receives and reports where the click was read against where it was aimed: `off by (-59, -58). Add (59, 58)`. Aim once, read the delta, correct. The offset is present with no device emulated at all, which the old explanation could not account for.
- **A click the client never registers is now called out as such**, instead of being reported as delivered. Phone emulation switches the client to touch input, which is why one that registered nowhere still looked like a success.
- **`perf coverage` diagnosed a failure on its own happy path.** Enabling coverage and reading straight back is expected to be empty — instrumentation only records while code runs — but 0.2.6 answered that with "these compiled before instrumentation was switched on". It now says what it actually knows, and where two causes are genuinely indistinguishable it names both instead of picking one.
- **Coverage reported scripts that had been destroyed**, for the rest of the session, under a bare name rather than a path.
- **`perf coverage` explained the "0 lines" flag with a cause that does not produce it.** An already-compiled script gets no record at all rather than an empty one; the replacement cause could not be reproduced either, so none is claimed now.
- `perf coverage` with an empty `enable` said nothing about having stopped, so a request to stop looked like a call that did nothing.
- `input` printed "emulated at undefined" when the device was known but its resolution was not.
- **A server whose MCP client was killed rather than closed never exited.** It kept the bridge port bound and re-registered itself every 30 seconds, so nothing ever swept it and the Studio console truthfully reported an agent that had left hours ago. It now shuts down when the process that spawned it goes away.

## 0.2.6

Four places where a tool told you something that wasn't true.

### Fixed
- **`input` clicks miss while a device is emulated.** Pointer coordinates are read in the emulated device's resolution, but `screenshot` returns the viewport's own pixels — 780x360 against 689x318 on a Galaxy S25 Ultra — so coordinates taken from a screenshot land short of the target. `input` now reports the emulation and says how to scale, or use `device op="stop"`. Keys were never affected, which is what made it look like a GUI fault.
- **`perf coverage` reported "no coverage recorded yet" for code that demonstrably ran.** A script already compiled when instrumentation was switched on gets no record at all, so it never reaches the results. The scripts the session was asked to instrument are now named, with the reason.
- **`list_studios` told the agent to ask the user which place they mean when only one place was open.** Two sessions on one placeId is an editor and its playtest, and the next call would have said so; the listing that comes first said the opposite. Both now give the same answer: pass `studioId` explicitly, edit session for anything that must outlive the playtest.
- **The console announced "Agent finished task." for an agent that had simply been closed.** The bridge sees a client disconnect and nothing more — quitting, a crash and a restart all arrive identically. It now says "Agent disconnected."

## 0.2.5

The console panel reacts to what the session is doing, reports how many agents share it, and says what a latency bar was.

### Added
- The activity band moves with the work: the solid draws in as a command goes out, springs past its size when the answer lands, snaps and wobbles on failure, breathes while idle, and winds down once the session goes quiet.
- Hovering a latency bar names the call — `Run luau: 2 ms`, not `2 ms`.
- A badge when more than one MCP client shares the bridge. Nothing shown for the usual single client.
- `Agent finished task.` when a client disconnects, and `agent idle — N calls, avg Xms` when work stops.
- **clear** logs `cleared N logs`, timestamped like every other row, and empties the latency trace with it.

### Changed
- The plugin is now called **rbx-studio** — window title, toolbar, and footer. Your panel's saved position and size are unaffected.

### Fixed
- **Two SSE frames sent in the same tick were both dropped.** They arrive as one chunk, and the parser decoded the whole chunk as a single JSON document. Visible as a client badge that went up and never came down; the real risk was a command sharing a chunk with a keepalive and vanishing — a lost tool call with no error at either end.
- An MCP client disconnecting was never noticed: `StdioServerTransport` listens only for `data` and `error` on stdin, so EOF never closes it and `onclose` never fires. Taken from stdin's `end` event instead.
- The bridge swept away the process it runs inside. The owner registered once and nothing refreshed it, so the reaper dropped it after 90s while it was serving — the client count read short and the drop was reported as an agent finishing.
- The latency bars' hover highlight had never once been visible: anchored to its bottom edge but positioned at the top of a frame that clips, so it drew entirely off screen.
- A departing client left its chosen Studio in the bridge forever.
- Shutdown aborted on Windows (`UV_HANDLE_CLOSING`) by calling `process.exit` mid-teardown.
- `check-plugin` filtered the Luau analyser to `LocalShadow` only, so a field used on a `--!strict` table that does not declare it shipped and crashed the plugin on load. It now also reports missing table keys.

### Faster
- The reply goes back to the agent before the console draws it. Repainting the log sat in front of every result on its way out.
- Repaints coalesced to one per frame, so a failure writing three rows no longer redraws the console three times.
- `TCP_NODELAY` on the bridge sockets.

## 0.2.0

A pass on console accuracy and a few real bugs found while doing it.

### Fixed
- `geometry` (union/subtract/intersect) could return a path that didn't exist.
- `inspect` and `modify` logged an internal probe call as a bare, misleading "Inspect X".
- `debug clear` with just a `path` (no `line`) always failed instead of clearing that script.
- The console described ~10 ops (`input`, `device.*`, `api.*`, `perf.scene`, `studio.transport`, capture internals) by raw wire name only.
- `playtest stop`'s teardown poll logged as "Check the playtest" with no "stop" line anywhere.
- The plugin's protocol version was sent but never checked; a rejected handshake showed a generic error instead of the real reason.

### Added
- `collision` can now `remove` a group — previously created-only, permanent for the place.
- `create`, `modify`, `move` describe what actually changed (class, properties, rename), not just that something did.

## 0.1.8

Found by actually watching the console during a live QA pass, immediately after 0.1.7 shipped: `playtest op="stop"` polls the surviving session every 400ms while the test tears down, and every one of those polls logged as "Check the playtest" — indistinguishable from an agent asking again for no reason, with no "stop" line anywhere to explain it (the real stop went to the session that is by then gone, and its console went with it).

### Fixed
- The teardown poll now logs as "Wait for the playtest to stop", not "Check the playtest".

## 0.1.7

The Studio console is the only feedback channel the plugin has — this is about making it tell the truth.

### Fixed
- **The console showed the raw wire name for ten operations instead of a description.** `input.send` — the one that fires on every keypress and click during a live playtest — read as "Input send" instead of "Press E" or "Click (320, 480)". Also fixed: `device.*`, `api.*`, `perf.scene`, `capture.playtestId`/`decode`, `studio.transport`.
- **A rejected handshake showed a generic "handshake failed" instead of the server's actual reason.** The bridge already sends a real message on every refusal (`missing header`, `no Studio connected`, etc.); the plugin was discarding it and showing a fallback string for any HTTP response that wasn't a plain success.

### Added
- **The plugin now announces its wire-protocol version, and a mismatch is reported the same way a stale build already is** — through `studio_status` and `list_studios`, not a silent failure. Existing plugins are unaffected: the version has never moved, so nothing changes until it does.

## 0.1.6

Documentation and error-message corrections. No behaviour change.

### Fixed
- `NO_STUDIO` and `list_studios` errors pointed agents at a nonexistent "Plugins tab -> Studio MCP -> Connect" command. The plugin connects automatically on load; the messages now say so and point at the reconnect button in the console.
- README called the beta "API debugger Luau" in one place; its real name is "Debugger Luau API".

### Changed
- README and package description rewritten shorter. The tagline no longer implies every write is undoable — `execute_luau` writes are not recorded.

## 0.1.5

Corrects two things 0.1.4 got wrong about the Debugger Luau API beta.

### Fixed
- **`debug` no longer refuses breakpoints with a message naming nothing.** The engine says only `Failed to execute AddBreakpoint request`. When every breakpoint in a call is refused, the error now points at the beta as the usual cause — it is off by default and needs a Studio restart — and at the other likely cause, a line that never runs, such as a `return` or an `end`.

### Removed
- **`studio_status` no longer reports `debuggerBeta`.** 0.1.4 added it and it never worked. Two probes were tried and measured, and neither varies with the beta: with it OFF, `GetService("ScriptDebuggerService")`, `FindService`, assigning `OnStopped` and `Enum.DebuggerResumeType` all still succeed; with it ON, `ReflectionService` still does not list the class. The only reliable test is `AddBreakpoint` itself, which cannot be run speculatively on someone's script to answer a status question. A field that always reads "fine" is worse than no field, so it is gone rather than guessed at a third time.

### Changed
- Corrected a claim in the 0.1.4 notes. They said the plugin could fail to load entirely when the beta was off, assuming `GetService` throws for an unregistered service. It does not — that was written without being checked. The guard added in 0.1.4 stays as insurance on a call that runs before any tool is invoked, but it fixed no observed crash.

## 0.1.4

Makes the Debugger Luau API beta impossible to miss, and stops it from being able to break anything else.

### Fixed
- **The plugin could fail to load entirely when the Debugger beta was off.** `ScriptDebuggerService` is only registered when that beta is on, and the handler asked for it at plugin start with no guard. If `GetService` threw there, every tool went down with it, not just `debug` — and silently, since a plugin that never loads never connects. The lookup is now guarded and a missing service is just a missing feature.

### Added
- `studio_status` reports `debuggerBeta: "off"` when the beta is disabled, so an agent finds out before calling `debug` rather than by failing. Absent when it is on, so the usual answer costs nothing.
- `CHANGELOG.md`, and the release workflow now builds each release body from it. A tag whose version has no section fails the workflow instead of publishing an empty release.

## 0.1.3

Documentation only — no code changes from 0.1.2.

The 0.1.2 package was published before the multi-agent notes landed, so the npm page was missing the two things you need before wiring several agents to one Studio:

- how per-client targeting works, and that `studioId` can still be passed per call
- that **subagents share their parent's connection and its target**, so they need an explicit `studioId`

If you are already on 0.1.2 the behaviour is identical; upgrade only for the docs.

## 0.1.2

Fixes a multi-agent bug that could send your edits to the wrong place.

### Fixed
- **Each agent now keeps its own active Studio.** Agents sharing one bridge also shared one target, so an agent calling `set_active_studio` silently retargeted every other agent's next un-addressed call. Nothing errored — edits simply landed in a place nobody asked for, and if that place was a playtest they were discarded when it stopped. The target is now per client, verified across two real MCP processes.
- Disconnecting a chosen Studio no longer promotes whichever session happens to remain. The choice is dropped, so a remaining pair asks again rather than pointing somewhere nobody picked.

### Notes
- Isolation is per MCP connection. **Subagents share their parent's connection**, so give those an explicit `studioId` per call rather than relying on the default.
- The built-in Studio MCP server solves the same problem by making `studio_id` mandatory everywhere and removing `set_active_studio`. This keeps the default instead, so a single open Studio still needs no id at all.

## 0.1.1

Multi-agent support, playtest screenshots, and a visible pointer.

### Added
- **Several agents can share one Studio.** Register the server in as many MCP clients as you like — two Claude sessions, Claude plus Cursor. The first server to start owns the port and the rest proxy through it automatically. No second connection to Studio, nothing to configure.
- **`screenshot` now works during a playtest.** Address it at the playtest's studioId and you get the player's own view — the only way to check a GUI in front of a running game. The shot is taken on the client and read back through the editor session, so keep the editor window connected.
- **`input` draws an on-screen pointer** that travels to each target before the click and ripples where it lands, so you can see what the agent is aiming at. Turn it off with `cursor: false`.

### Fixed
- `execute_luau` and other calls no longer time out with a bare "it timed out". Timeouts now report whether the command ever reached Studio, how long the plugin has been silent, what else was in flight, and which transport was used.
- A playtest is no longer mistaken for a second place. Editor plus playtest used to trigger AMBIGUOUS_STUDIO, which has no sensible answer — there is one place in two states. It now says so and explains which to target.
- `api describe` no longer lists deprecated members as if they were usable. `Instance` had eight, including `clone` and `getChildren`. They are counted, not listed.
- Device emulation reported portrait resolutions backwards (852x393 for a 393x852 viewport).
- `character`'s description claimed synthetic input was impossible. It has not been since `input` shipped.

### Notes
- `debug` needs the **Debugger Luau API** beta enabled in File → Beta Features, then a Studio restart. The error now says so.

## 0.1.0

First public release. 29 tools over a push-based SSE bridge, editor-safe script editing through `ScriptEditorService:UpdateSourceAsync`, and every write batched into a single undo step.
