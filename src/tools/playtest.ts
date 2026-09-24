import { z } from "zod";
import { ToolError } from "../lib/errors.js";
import { json, type ToolResult } from "../lib/format.js";
import { defineTool, type ToolContext } from "../lib/tool.js";

interface PlaytestResponse {
  changed: boolean;
  reason?: string;
  state: {
    playtestsAllowed?: boolean;
    isEdit: boolean;
    isRunning: boolean;
    isRunMode: boolean;
    editModeActive?: boolean;
    playerCount: number;
    players?: Array<{ name: string; userId: number }>;
    testPending: boolean;
    lastResult?: unknown;
    lastError?: string;
    runningForSeconds?: number;
  };
}

/**
 * The studioId of the running playtest's server session, or null.
 *
 * Prefers the cached context so the common case costs nothing, and asks the
 * sessions directly when nothing is cached -- which is the situation right
 * after this tool started a test, since the new session has never been queried
 * and its context is exactly what the caller needs.
 */
async function findPlaytestSession(bridge: ToolContext["bridge"], exclude: ReadonlySet<string> = new Set()): Promise<string | null> {
  const sessions = (await bridge.sessions()).list;
  const cached = sessions.find((session) => !exclude.has(session.studioId) && session.context?.includes("playtest") && !session.context?.includes("client"));
  if (cached) return cached.studioId;

  const unknown = sessions.filter((session) => !exclude.has(session.studioId) && session.context === undefined);
  const probed = await Promise.all(
    unknown.map(async (session) => {
      try {
        const status = await bridge.call<{ placeName: string; context?: string }>(
          "studio.status",
          {},
          { studioId: session.studioId, timeoutMs: 3_000 },
        );
        await bridge.notePlaceName(session.studioId, status.placeName, status.context);
        return status.context?.includes("playtest") && !status.context?.includes("client") ? session.studioId : null;
      } catch {
        return null;
      }
    }),
  );
  return probed.find((id): id is string => id !== null) ?? null;
}

export function registerPlaytestTools(context: ToolContext): void {
  const { bridge } = context;

  defineTool(
    context,
    {
      name: "playtest",
      title: "Run, pause and stop the simulation",
      description:
        "Starts and stops playtests, so scripts can be made to run and then " +
        "observed without asking the user to press anything.\n\n" +
        "`play` is the Play button: a character spawns and `Players.PlayerAdded` " +
        "fires. `run` is Run mode, which executes scripts with no player at all. " +
        "`multiplayer` starts a test with several players for testing " +
        "replication. `state` reports without changing anything.\n\n" +
        "Play and multiplayer return the playtest server's studioId once it connects. " +
        "Use that ID directly for `console`, `performance` and `execute_luau`; " +
        "the editor session has a separate log. If connection takes too long, " +
        "the reply says so and `list_studios` can find it later.\n\n" +
        "A test does not block this call: it starts and the reply reports the " +
        "state reached. Studio only ends it when something inside calls " +
        "`StudioTestService:EndTest(value)` or when `stop` is used here; whatever " +
        "EndTest passed comes back as `lastResult` on a later `state`. That makes " +
        "a scripted check possible end to end: `args` is readable inside the test " +
        "via `StudioTestService:GetTestArgs()`, so a test can be told what to do " +
        "and report back what happened.\n\n" +
        "On Linux (Studio under Wine/Vinegar) `multiplayer` is refused unless " +
        "`force: true` is passed: it does not work reliably there and has crashed " +
        "Studio outright. Use `play` with one player instead. `play`/`stop` can also " +
        "sit in `testPending` for 30–90s on that setup — that is Studio being " +
        "slow, not a failed call, so poll `state` rather than sending it again. " +
        "If `play` is refused with ALREADY_RUNNING although no playtest exists and " +
        "the start has been pending for 2+ minutes, the start never returned: " +
        "`stop` clears it.\n\n" +
        "Stopping discards everything the playtest changed, exactly as pressing " +
        "Stop does. Build in edit mode, then play — not the other way round.\n\n" +
        "The reply says whether the mode actually moved, not merely that Studio " +
        "accepted the request.\n\n" +
        "The panel's `playtests on` grants permission, never a requirement: obey " +
        "AGENTS.md, CLAUDE.md, user instructions and project guidance that prohibit " +
        "playtesting even when ON. `playtests off` is a hard MCP lock: play, run and " +
        "multiplayer are refused regardless of instructions to test; state and stop " +
        "remain available. The lock only blocks starting simulation: screenshots, tree, " +
        "inspect, script reads, edit-mode execute_luau and UI inspection stay available. " +
        "Continue using edit-mode tools and static inspection where possible. " +
        "Only the user can re-enable it with `playtests on` in " +
        "the panel. Do not bypass the lock through execute_luau, Studio APIs or " +
        "another operation. Manual Studio Play is unaffected.",
      inputSchema: {
        op: z
          .enum(["play", "run", "multiplayer", "stop", "state"])
          .describe(
            "'play' starts a playtest with a character, 'run' runs scripts with " +
              "no player, 'multiplayer' starts a several-player test, 'stop' ends " +
              "it and discards its changes, 'state' only reports.",
          ),
        players: z
          .number()
          .int()
          .min(1)
          .max(8)
          .default(2)
          .describe("multiplayer only: how many players to start."),
        args: z
          .string()
          .optional()
          .describe(
            "Value handed to the test, readable inside it with " +
              "`StudioTestService:GetTestArgs()`. Use it to tell a test which " +
              "case to exercise.",
          ),
        force: z
          .boolean()
          .optional()
          .describe(
            "multiplayer only: start it even on Linux/Wine, where it is refused by " +
              "default because it can crash Studio.",
          ),
        studioId: z.string().optional().describe("Target Studio; omit for the active one."),
      },
      readOnly: false,
      destructive: true,
    },
    async (args): Promise<ToolResult> => {
      //[[
      // Stopping is routed rather than sent where it was asked.
      //
      // Starting a playtest creates a second session, which immediately makes
      // every later call ambiguous -- including the stop for the test just
      // started, so the tool could begin something it could not end. And the
      // stop cannot be served by the editor session anyway: `LeaveTest` is
      // client-DataModel only and a playtest client can never reach this
      // bridge, so only `EndTest`, from the playtest's server session, ends a
      // test. Both problems have the same answer: find that session.
      //]]
      if (args.op === "stop") {
        const playtest = await findPlaytestSession(bridge);
        if (playtest) {
          //[[
          // The stop is sent to the session it will destroy, so its reply is
          // expected to go missing and a transport failure here says nothing
          // about whether the test ended. The answer comes from the editor
          // session, which survives — and which is also the only session that
          // holds the value EndTest passed back.
          //]]
          await bridge
            .call("playtest.control", { op: "endTest", value: args.args }, {
              studioId: playtest,
              timeoutMs: 10_000,
            })
            .catch(() => null);

          const survivor = (await bridge.sessions()).list.find(
            (session) => session.studioId !== playtest,
          );
          if (survivor) {
            //[[
            // Waited for, not sampled. The teardown is deliberately deferred so
            // the reply can leave first, and tearing a DataModel down is not
            // instant either — so a single read taken straight afterwards
            // reports a test still running that is already on its way out. That
            // is the same false report as before, just pointing the other way.
            //]]
            const deadline = Date.now() + 10_000;
            let after: PlaytestResponse;
            for (;;) {
              after = await bridge.call<PlaytestResponse>(
                "playtest.control",
                // `waitingForStop` is inert on the plugin side -- Playtest.control
                // reads only `op`. It rides along so the console can tell this
                // poll apart from an agent's own `state` check: without it, five
                // identical "Check the playtest" lines in two seconds read as
                // unexplained noise rather than what they are, which is this
                // call waiting for the teardown it just started.
                { op: "state", waitingForStop: true },
                { studioId: survivor.studioId, timeoutMs: 10_000 },
              );
              const settled = after.state.editModeActive !== false && !after.state.testPending;
              if (settled || Date.now() >= deadline) break;
              await new Promise((resolve) => setTimeout(resolve, 400));
            }

            const stopped = after.state.editModeActive !== false && !after.state.testPending;
            return json(
              after.state,
              stopped
                ? undefined
                : "The stop was sent but Studio is still in a test. Check whether " +
                    "something inside it is holding the session open.",
            );
          }
        }
      }

      /*
       * Refused before anything is sent. Under Wine, ExecuteMultiplayerTestAsync
       * either never comes back or takes Studio down with it -- measured once
       * as a full crash -- and there is no recovering the session afterwards, so
       * the guard sits ahead of the call rather than reporting after it.
       */
      if (
        args.op === "multiplayer" &&
        process.platform === "linux" &&
        args.force !== true &&
        process.env["STUDIO_MCP_ALLOW_MULTIPLAYER"] !== "1"
      ) {
        throw new ToolError(
          "MULTIPLAYER_UNSAFE",
          "Multiplayer tests are disabled on Linux: Studio runs under Wine here, where " +
            "this call is unreliable and has crashed Studio.",
          'Use op="play" for a single-player test. To try it anyway, pass force: true ' +
            "(or set STUDIO_MCP_ALLOW_MULTIPLAYER=1).",
        );
      }

      const starting = args.op === "play" || args.op === "multiplayer";
      const before = starting ? new Set((await bridge.sessions()).list.map((session) => session.studioId)) : new Set<string>();
      const response = await bridge.call<PlaytestResponse>(
        "playtest.control",
        { op: args.op, players: args.players, args: args.args },
        { studioId: args.studioId, timeoutMs: 30_000 },
      );

      const notes: string[] = [];
      if (args.op !== "state" && !response.changed) {
        notes.push(response.reason ?? "Studio accepted the call but nothing changed.");
      } else if (response.reason) {
        notes.push(response.reason);
      }

      // The running game is a different session from the one just asked to start
      // it, and every subsequent read has to go to that one instead. Said here
      // because the alternative is an agent reading the editor's empty log and
      // concluding the playtest did nothing.
      let runtime: { studioId: string; players?: Array<{ name: string; userId: number }> } | undefined;
      if (starting && response.changed && response.state.testPending) {
        const deadline = Date.now() + 6_000;
        do {
          const id = runtime?.studioId ?? await findPlaytestSession(bridge, before);
          if (id) {
            runtime ??= { studioId: id };
            try {
              const state = await bridge.call<PlaytestResponse>("playtest.control", { op: "state" }, { studioId: id, timeoutMs: 2_000 });
              runtime.players = state.state.players;
            } catch { /* A connecting session can already be listed before it answers. */ }
            if ((runtime.players?.length ?? 0) >= (args.op === "multiplayer" ? args.players : 1)) break;
          }
          if (Date.now() >= deadline) break;
          await new Promise((resolve) => setTimeout(resolve, 300));
        } while (true);
        if (!runtime) notes.push("The playtest server has not connected yet. Use list_studios later to find its studioId.");
        else if (!runtime.players?.length) notes.push("The playtest server connected, but players are still joining. Query playtest state later for names.");
      }

      /*
       * A test that has been "starting" for this long is almost certainly not
       * failing, just slow -- under Wine the transition can hold for a minute or
       * more and then complete on its own. Retrying `play` on top of it is what
       * makes it worse (ALREADY_RUNNING at best, a wedged Studio at worst).
       *
       * Past STALE_AFTER_SECONDS this stops being "probably slow": that is the
       * same threshold Playtest.luau's `stop` uses to decide a launch never
       * came back, so from here the honest advice changes from "wait" to "stop
       * will actually clear this now" -- the two numbers must stay in sync.
       *
       * `testPending` is NOT "still starting": it stays true for the whole test,
       * because ExecutePlayModeAsync only returns when the test ends, and the
       * editor session's `isRunning` is false throughout a Play test too. So
       * those two alone cannot tell a start that never came back from a
       * healthy test that has simply been running for minutes -- and telling
       * an agent to `stop` the latter kills a working test. `editModeActive`
       * is what separates them (the plugin's own reaper uses it the same way):
       * false means the test is running, so neither note applies. The "stuck"
       * escalation also requires it to be positively true, not merely
       * unreadable, since a wrong "stop it" costs far more than a missing one.
       */
      const STALE_AFTER_SECONDS = 120;
      const waited = response.state.runningForSeconds ?? 0;
      const editMode = response.state.editModeActive;
      const startPending = response.state.testPending && !response.state.isRunning && editMode !== false;
      if (startPending && editMode === true && waited >= STALE_AFTER_SECONDS) {
        notes.push(
          `The test has been starting for ${waited}s without entering play mode — past the ` +
            "point where this is merely slow. This now looks stuck, not slow: `stop` will " +
            "recognize it as an abandoned launch and clear it (Studio is left in edit mode, " +
            "nothing was running to lose). Do not send `play` again on top of it.",
        );
      } else if (startPending && waited >= 20) {
        /*
         * What `stop` can do about it depends on edit mode being readable: the
         * plugin only reaps a start when it knows Studio is in edit mode. With
         * that unknown, promising "`stop` will clear it" would be false.
         */
        const wayOut =
          editMode === true
            ? `past ${STALE_AFTER_SECONDS}s, \`stop\` will treat it as abandoned instead. `
            : waited >= STALE_AFTER_SECONDS
              ? "Studio's edit mode cannot be read here, so `stop` will not clear this on its " +
                "own; if it never resolves, restart Studio. "
              : "";
        notes.push(
          `The test has been starting for ${waited}s without entering play mode. ` +
            "Do not send `play` again; poll `state`" +
            (process.platform === "linux"
              ? ` — under Wine this can take 30–90s and usually resolves by itself; ${wayOut}` +
                "If list_studios shows sessions as unreachable, wait a few minutes; " +
                "restart Studio only if it never recovers."
              : "."),
        );
      }

      return json(runtime ? { ...response.state, ...runtime } : response.state, notes.length > 0 ? notes.join("\n") : undefined);
    },
  );
}
