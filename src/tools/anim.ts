import { z } from "zod";
import { json, table, text, textOf, type ToolResult } from "../lib/format.js";
import { defineTool, type ToolContext } from "../lib/tool.js";

interface Pose {
  joint: string;
  cframe: string;
  weight: number;
  easing: string;
}

interface ReadResponse {
  assetId: string;
  name?: string;
  priority: string;
  looping: boolean;
  duration: number;
  keyframeCount: number;
  joints: string[];
  jointCount: number;
  jointsSampled?: boolean;
  keyframes: Array<{ index: number; time: number; name?: string; poseCount: number; poses?: Pose[] }>;
  endsWhereItStarted?: boolean;
  driftingJoints?: string[];
  rig: string;
  rigNote?: string;
  truncated: boolean;
}

/** Downloads go to Roblox's asset servers, which are not always quick. */
const TIMEOUT_MS = 45_000;

export function registerAnimTools(context: ToolContext): void {
  const { bridge } = context;

  defineTool(
    context,
    {
      name: "animation",
      title: "Read and build animations",
      description:
        "Reads an animation's actual keyframes, and builds new ones that play " +
        "immediately in the open Studio.\n\n" +
        "Animations are the one part of a place no other tool can see. " +
        "`inspect` on an Animation instance returns an asset id and stops there " +
        "— the poses live on Roblox's servers. `read` downloads them, so you can " +
        "answer 'how long is it', 'which joints does it move', and 'does it end " +
        "where it started' without opening the Animation Editor and scrubbing.\n\n" +
        "`read` takes an asset id, an rbxassetid:// string, or the path of an " +
        "Animation instance in the place — whichever you already have. It reports " +
        "which RIG the animation was made for, which is the thing most worth " +
        "knowing: an R15 animation on an R6 character does nothing at all — no " +
        "error, no movement — and the asset id gives no hint either way.\n\n" +
        "`build` goes the other way: give it keyframes and it returns a content " +
        "id for `preview` and `read`. Nothing is uploaded and nothing is " +
        "moderated — the id works in this Studio's EDIT session and nowhere " +
        "else, which makes it the right way to try an idea and the wrong way to " +
        "ship one.\n\n" +
        "NEVER put a `build` id in the AnimationId of an Animation that a real " +
        "playtest will load. LoadAnimation with it does not just fail — it " +
        "breaks the character's whole Animator (full T-pose, every animation " +
        "dead). For an animation that must run in the game, pass `parent` (e.g. " +
        "the Tool): `build` then leaves a real KeyframeSequence instance there, " +
        "and `play` loads and plays it on a running playtest's client in one " +
        "call — no hand-written execute_luau needed. The sequence must be " +
        "somewhere the client can see (Workspace, ReplicatedStorage, the rig or " +
        "a Tool in the workspace — NOT ServerStorage). A new `play` replaces the " +
        "one before it on that rig instead of stacking, and `stop` addressed to " +
        "the playtest's studioId stops it; the game's own animations are left " +
        "alone.\n\n" +
        "Give `build` at least two keyframes at different times. A single " +
        "keyframe has zero length, and a zero-length animation cannot be " +
        "previewed (the preview times out). A single or all-at-time-0 animation is " +
        "padded automatically with a repeat of the last keyframe 0.1s later, and " +
        "the reply says so — but writing two yourself is clearer.\n\n" +
        "`preview` puts an animation ONTO a rig in the open place and freezes it " +
        "at a chosen moment, so `screenshot` can show you the pose. It works in " +
        "edit mode — no playtest. Ask for several moments in turn to compare " +
        "poses across the animation; the rig stays posed until `stop`.\n\n" +
        "Poses are written the way a CFrame property is: \"0, 1, 0\" for a " +
        "position, \"0, 1, 0 | 0, 45, 0\" to rotate as well.\n\n" +
        "The id `build` returns is a bare hash, not an rbxassetid:// URL. Use it " +
        "exactly as given — prefixing it stops it working. It is preview-only.",
      inputSchema: {
        op: z
          .enum(["read", "preview", "build", "play", "stop"])
          .default("read")
          .describe(
            "'read' downloads an existing animation, 'preview' poses a rig at one " +
              "moment of it so you can screenshot it, 'build' makes a new one " +
              "playable here, 'play' loads and plays a kept KeyframeSequence on a " +
              "running playtest's client, 'stop' clears a preview (edit) or stops " +
              "what `play` started (when addressed to a playtest).",
          ),
        assetId: z
          .union([z.number(), z.string()])
          .optional()
          .describe(
            'read and preview: animation asset id (12345), "rbxassetid://12345", or the ' +
              'path of an Animation instance ("Workspace.Rig.Animate.run").',
          ),
        keyframes: z
          .array(
            z.object({
              time: z.number().min(0).describe("Seconds from the start of the animation."),
              name: z.string().optional().describe('Keyframe name, e.g. "Start" or a marker name.'),
              poses: z
                .record(z.string(), z.string())
                .optional()
                .describe(
                  'Joint name → CFrame, e.g. { "Right Arm": "0, 0.5, 0 | 0, 0, 45" }. ' +
                    "Joint names must match the rig's parts.",
                ),
            }),
          )
          .max(200)
          .optional()
          .describe("build only: the keyframes, in any order — they are sorted by time."),
        name: z.string().optional().describe("build only: name for the sequence."),
        parent: z
          .string()
          .optional()
          .describe(
            "build only: path to keep the built KeyframeSequence under as a real " +
              'instance (e.g. "Workspace.Rig.Tool" or "ReplicatedStorage"). This is ' +
              "how to make an animation that works in a real playtest: `play` (or " +
              "the returned `instance`, for hand-written client code) loads and " +
              "plays it there. `play` runs on the client, so put it somewhere the " +
              "client can see — ServerStorage and ServerScriptService never " +
              "replicate, and a Tool still in StarterPack is not at that path " +
              "during a playtest. One undo step.",
          ),
        root: z
          .string()
          .optional()
          .describe(
            'build only: the rig part every pose hangs from. Defaults to "HumanoidRootPart", ' +
              "which is right for an R15 or R6 character.",
          ),
        priority: z
          .enum(["Idle", "Movement", "Action", "Core"])
          .optional()
          .describe("build only: which animations this one plays over."),
        loop: z.boolean().optional().describe("build only: whether it repeats."),
        rig: z
          .string()
          .optional()
          .describe(
            'The model, e.g. "Workspace.Dummy". For preview/stop it is the rig to ' +
              "pose, and needs a Humanoid or an AnimationController inside it. For " +
              "`build` it is optional and is read for its joint layout — pass it for " +
              "anything that is not a standard R6 or R15 character (a custom rig, a " +
              "weapon, a door, a Blender import), or the poses may be attached in the " +
              "wrong order and the animation will move nothing. For `play` (and `stop` " +
              "in a playtest), it is optional and defaults to the player's own character.",
          ),
        sequence: z
          .string()
          .optional()
          .describe(
            'play only: path to the KeyframeSequence instance to play, e.g. ' +
              '"Workspace.Rig.Tool.MCPAnimation" — the `instance` a prior `build` ' +
              "(called with `parent`) returned.",
          ),
        player: z
          .string()
          .optional()
          .describe("play (and stop in a playtest): which player, by name. Omit for the only one in the playtest."),
        fadeTime: z
          .number()
          .optional()
          .describe("play only: blend-in time in seconds. Omit for the engine default."),
        weight: z.number().optional().describe("play only: blend weight against other playing animations."),
        speed: z.number().optional().describe("play only: playback speed multiplier. Omit for 1."),
        at: z
          .number()
          .min(0)
          .optional()
          .describe(
            "preview only: the moment to freeze on, in seconds. Ask for several " +
              "in turn to compare poses across the animation.",
          ),
        hold: z
          .boolean()
          .default(true)
          .describe(
            "preview only: freeze on that frame. Turn off to let it play, but then " +
              "a screenshot catches whatever pose it happens to be in.",
          ),
        studioId: z.string().optional().describe("Target Studio; omit for the active one."),
      },
      readOnly: false,
      destructive: false,
    },
    async (args): Promise<ToolResult> => {
      if (args.op === "play") {
        if (!args.sequence) {
          return text(
            "play needs `sequence` — the path to a KeyframeSequence instance " +
              "(the `instance` a prior `build`, called with `parent`, returned).",
          );
        }
        const played = await bridge.call<Record<string, unknown>>(
          "anim.play",
          {
            sequence: args.sequence,
            rig: args.rig,
            player: args.player,
            fadeTime: args.fadeTime,
            weight: args.weight,
            speed: args.speed,
          },
          { studioId: args.studioId, timeoutMs: TIMEOUT_MS },
        );
        return json(played);
      }

      /*
       * `stop` means two different things, told apart by where it is sent.
       * In a playtest it stops what `play` started -- on the client, where it is
       * playing; `preview`'s stop runs in the session it is sent to and resets
       * the rig's joints, which never reaches a track on a client's Animator.
       * In edit mode it clears a preview, as it always has.
       */
      if (args.op === "stop") {
        const { list, activeId } = await bridge.sessions();
        const wanted = args.studioId ?? activeId ?? (list.length === 1 ? list[0]?.studioId : undefined);
        const target = list.find((session) => session.studioId === wanted);
        if ((target?.context ?? "").startsWith("playtest")) {
          const stopped = await bridge.call<Record<string, unknown>>(
            "anim.stopPlay",
            { rig: args.rig, player: args.player },
            { studioId: args.studioId, timeoutMs: TIMEOUT_MS },
          );
          return json(
            stopped,
            stopped["stopped"] === 0
              ? "Nothing to stop: no animation that `play` started is playing on that rig."
              : undefined,
          );
        }
      }

      if (args.op === "preview" || args.op === "stop") {
        if (!args.rig) {
          return text(
            args.op === "stop"
              ? "stop needs a `rig` in edit mode (the previewed model). To stop what " +
                  "`play` started, address `stop` to the playtest's studioId."
              : "preview needs a `rig` — the model to pose.",
          );
        }
        const posed = await bridge.call<Record<string, unknown>>(
          "anim.preview",
          { op: args.op, rig: args.rig, assetId: args.assetId, at: args.at, hold: args.hold },
          { studioId: args.studioId, timeoutMs: TIMEOUT_MS },
        );
        return json(posed);
      }

      if (args.op === "build") {
        if (!args.keyframes || args.keyframes.length === 0) {
          return text("build needs a non-empty `keyframes` array.");
        }
        const built = await bridge.call<Record<string, unknown>>(
          "anim.build",
          {
            keyframes: args.keyframes,
            name: args.name,
            parent: args.parent,
            root: args.root,
            rig: args.rig,
            priority: args.priority,
            loop: args.loop,
          },
          { studioId: args.studioId, timeoutMs: TIMEOUT_MS },
        );
        const kept = typeof built["instance"] === "string" ? built["instance"] : undefined;
        return json(
          built,
          "PREVIEW ONLY: use `animationId` with `animation op=preview` in this edit " +
            "session, exactly as it appears (a bare hash; rbxassetid:// in front of it " +
            "stops it working). Do NOT write it to an Animation that a playtest loads — " +
            "that breaks the character's whole Animator (T-pose). Not uploaded, gone on " +
            "restart.\n\n" +
            (kept
              ? `For the real game, the KeyframeSequence is kept at ${kept}. During a ` +
                `playtest, \`animation op="play" sequence="${kept}"\` loads and plays it ` +
                "on the player's character (or pass `rig` for anything else) — no " +
                "hand-written client code needed.\n\n"
              : args.parent !== undefined
                ? `\`parent\` was given but NOTHING WAS KEPT: ${
                    typeof built["instanceNote"] === "string" ? built["instanceNote"] : "the plugin did not say why"
                  }. Fix that and build again before using this for gameplay.\n\n`
                : "Pass `parent` to keep a real KeyframeSequence in the place for gameplay use.\n\n") +
            "`hierarchy` says which joint layout the poses were nested against — the " +
            "rig you named, or the R6/R15 standard guessed from the joint names. " +
            "Anything in `unmatchedJoints` is a name that layout does not contain: " +
            "those poses were attached to the root and will almost certainly do " +
            "nothing. Pass `rig` to fix it.",
        );
      }

      if (args.assetId === undefined) {
        return text("read needs an `assetId` — a number, an rbxassetid:// string, or a path to an Animation.");
      }

      const found = await bridge.call<ReadResponse>(
        "anim.read",
        { assetId: args.assetId },
        { studioId: args.studioId, timeoutMs: TIMEOUT_MS },
      );

      /*
       * A summary first, then the timeline. The three facts at the top are what
       * the question was, and burying them under forty rows of keyframes would
       * make the tool technically complete and practically unreadable.
       */
      const lines = [
        `${found.name ?? found.assetId} — ${found.rig} rig, ${found.duration}s, ` +
          `${found.keyframeCount} keyframes, ${found.jointCount} joints moved`,
        `Priority ${found.priority}${found.looping ? ", loops" : ", does not loop"}` +
          (found.rigNote !== undefined ? ` — ${found.rigNote}` : ""),
        "",
        `Joints: ${found.joints.join(", ") || "none"}` +
          (found.jointsSampled ? ` … and ${found.jointCount - found.joints.length} more` : ""),
      ];

      if (found.rig === "R6" || found.rig === "R15") {
        lines.push(
          "",
          `This is an ${found.rig} animation. It will do NOTHING on an ${
            found.rig === "R6" ? "R15" : "R6"
          } character — no error, no movement, because the joint names do not exist ` +
            "on the other rig. Check the character's rig type before using it.",
        );
      }

      if (found.looping && found.endsWhereItStarted === false) {
        lines.push(
          "",
          "WARNING: this animation loops, but these joints do not end where they " +
            `started: ${(found.driftingJoints ?? []).join(", ")}. That is what a ` +
            "visible jump at the loop point looks like.",
        );
      }

      lines.push(
        "",
        textOf(
          table(
            ["index", "time", "name", "poseCount"],
            found.keyframes as unknown as Array<Record<string, unknown>>,
            {
              more: found.truncated
                ? `poses expanded for the first 40 keyframes only`
                : undefined,
            },
          ),
        ),
      );

      return text(lines.join("\n"));
    },
  );
}
