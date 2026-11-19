//! animation: read, build, preview, play and stop animations.

use super::{arr_of, call, str_of, u64_of};
use crate::errors::Result;
use crate::format::{PageMeta, ToolResult, json, table, text};
use crate::tool::{Ctx, Tool, define, spec};
use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::sync::Arc;

/// Downloads go to Roblox's asset servers, which are not always quick.
const TIMEOUT_MS: f64 = 45_000.0;

#[derive(Deserialize, Serialize, JsonSchema, Default, PartialEq, Clone, Copy)]
#[serde(rename_all = "lowercase")]
enum AnimOp {
    #[default]
    Read,
    Preview,
    Build,
    Play,
    Stop,
}

#[derive(Deserialize, Serialize, JsonSchema, Clone)]
#[serde(untagged)]
enum AssetId {
    Number(i64),
    String(String),
}

#[derive(Deserialize, Serialize, JsonSchema, Clone, Copy)]
enum AnimPriority {
    Idle,
    Movement,
    Action,
    Core,
}

fn pose_map(_: &mut SchemaGenerator) -> Schema {
    json_schema!({
        "type": "object",
        "additionalProperties": { "type": "string" },
        "description": "Joint name -> CFrame, e.g. { \"Right Arm\": \"0, 0.5, 0 | 0, 0, 45\" }. Joint names must match the rig's parts.",
    })
}

#[derive(Deserialize, Serialize, JsonSchema)]
struct KeyframeInput {
    /// Seconds from the start of the animation.
    #[schemars(range(min = 0))]
    time: f64,
    /// Keyframe name, e.g. "Start" or a marker name.
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "pose_map")]
    poses: Option<Map<String, Value>>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct AnimArgs {
    /// 'read' downloads an existing animation, 'preview' poses a rig at one moment of it so you can screenshot it, 'build' makes a new one playable here, 'play' loads and plays a kept KeyframeSequence on a running playtest's client, 'stop' clears a preview (edit) or stops what `play` started (when addressed to a playtest).
    #[serde(default)]
    op: AnimOp,
    /// read and preview: animation asset id (12345), "rbxassetid://12345", or the path of an Animation instance ("Workspace.Rig.Animate.run").
    asset_id: Option<AssetId>,
    /// build only: the keyframes, in any order — they are sorted by time.
    #[schemars(length(max = 200))]
    keyframes: Option<Vec<KeyframeInput>>,
    /// build only: name for the sequence.
    name: Option<String>,
    /// build only: path to keep the built KeyframeSequence under as a real instance (e.g. "Workspace.Rig.Tool" or "ReplicatedStorage"). This is how to make an animation that works in a real playtest: `play` (or the returned `instance`, for hand-written client code) loads and plays it there. `play` runs on the client, so put it somewhere the client can see — ServerStorage and ServerScriptService never replicate, and a Tool still in StarterPack is not at that path during a playtest. One undo step.
    parent: Option<String>,
    /// build only: the rig part every pose hangs from. Defaults to "HumanoidRootPart", which is right for an R15 or R6 character.
    root: Option<String>,
    /// build only: which animations this one plays over.
    priority: Option<AnimPriority>,
    /// build only: whether it repeats.
    #[serde(rename = "loop")]
    looping: Option<bool>,
    /// The model, e.g. "Workspace.Dummy". For preview/stop it is the rig to pose, and needs a Humanoid or an AnimationController inside it. For `build` it is optional and is read for its joint layout — pass it for anything that is not a standard R6 or R15 character (a custom rig, a weapon, a door, a Blender import), or the poses may be attached in the wrong order and the animation will move nothing. For `play` (and `stop` in a playtest), it is optional and defaults to the player's own character.
    rig: Option<String>,
    /// play only: path to the KeyframeSequence instance to play, e.g. "Workspace.Rig.Tool.MCPAnimation" — the `instance` a prior `build` (called with `parent`) returned.
    sequence: Option<String>,
    /// play (and stop in a playtest): which player, by name. Omit for the only one in the playtest.
    player: Option<String>,
    /// play only: blend-in time in seconds. Omit for the engine default.
    fade_time: Option<f64>,
    /// play only: blend weight against other playing animations.
    weight: Option<f64>,
    /// play only: playback speed multiplier. Omit for 1.
    speed: Option<f64>,
    /// preview only: the moment to freeze on, in seconds. Ask for several in turn to compare poses across the animation.
    #[schemars(range(min = 0))]
    at: Option<f64>,
    /// preview only: freeze on that frame. Turn off to let it play, but then a screenshot catches whatever pose it happens to be in.
    #[serde(default = "super::d::t")]
    hold: bool,
    /// Target Studio; omit for the active one.
    studio_id: Option<String>,
}

fn build_note(built: &Value, requested_parent: Option<&str>) -> String {
    let kept = str_of(built, "instance");
    let middle = match kept {
        Some(path) => format!(
            "For the real game, the KeyframeSequence is kept at {path}. During a \
             playtest, `animation op=\"play\" sequence=\"{path}\"` loads and plays it \
             on the player's character (or pass `rig` for anything else) — no \
             hand-written client code needed.\n\n"
        ),
        None if requested_parent.is_some() => format!(
            "`parent` was given but NOTHING WAS KEPT: {}. Fix that and build again before using this for gameplay.\n\n",
            str_of(built, "instanceNote").unwrap_or("the plugin did not say why")
        ),
        None => "Pass `parent` to keep a real KeyframeSequence in the place for gameplay use.\n\n".to_string(),
    };
    format!(
        "PREVIEW ONLY: use `animationId` with `animation op=preview` in this edit \
         session, exactly as it appears (a bare hash; rbxassetid:// in front of it \
         stops it working). Do NOT write it to an Animation that a playtest loads — \
         that breaks the character's whole Animator (T-pose). Not uploaded, gone on \
         restart.\n\n\
         {middle}\
         `hierarchy` says which joint layout the poses were nested against — the \
         rig you named, or the R6/R15 standard guessed from the joint names. \
         Anything in `unmatchedJoints` is a name that layout does not contain: \
         those poses were attached to the root and will almost certainly do \
         nothing. Pass `rig` to fix it. Anything in `unrootedJoints` is in the \
         layout but its chain never reaches `root` (the pose everything hangs \
         from, read from the rig when one is given) — pass `root` with the \
         rig's real root part."
    )
}

fn format_read(found: &Value) -> ToolResult {
    let name = str_of(found, "name")
        .or_else(|| str_of(found, "assetId"))
        .unwrap_or("Animation");
    let rig = str_of(found, "rig").unwrap_or("unknown");
    let duration = super::disp(found.get("duration"));
    let keyframe_count = u64_of(found, "keyframeCount");
    let joint_count = u64_of(found, "jointCount");
    let priority = str_of(found, "priority").unwrap_or("unknown");
    let looping = found.get("looping") == Some(&Value::Bool(true));
    let rig_note = str_of(found, "rigNote").map(|n| format!(" — {n}")).unwrap_or_default();

    let joints: Vec<&str> = arr_of(found, "joints").iter().filter_map(Value::as_str).collect();
    let joints_list = if joints.is_empty() { "none".to_string() } else { joints.join(", ") };
    let sampled_tail = if found.get("jointsSampled") == Some(&Value::Bool(true)) {
        format!(" … and {} more", joint_count.saturating_sub(joints.len() as u64))
    } else {
        String::new()
    };

    let mut lines = vec![
        format!("{name} — {rig} rig, {duration}s, {keyframe_count} keyframes, {joint_count} joints moved"),
        format!("Priority {priority}{}{rig_note}", if looping { ", loops" } else { ", does not loop" }),
        String::new(),
        format!("Joints: {joints_list}{sampled_tail}"),
    ];

    if rig == "R6" || rig == "R15" {
        let other = if rig == "R6" { "R15" } else { "R6" };
        lines.push(String::new());
        lines.push(format!(
            "This is an {rig} animation. It will do NOTHING on an {other} character — no error, \
             no movement, because the joint names do not exist on the other rig. Check the \
             character's rig type before using it."
        ));
    }

    if looping && found.get("endsWhereItStarted") == Some(&Value::Bool(false)) {
        let drifting: Vec<&str> = arr_of(found, "driftingJoints").iter().filter_map(Value::as_str).collect();
        lines.push(String::new());
        lines.push(format!(
            "WARNING: this animation loops, but these joints do not end where they started: {}. \
             That is what a visible jump at the loop point looks like.",
            drifting.join(", ")
        ));
    }

    let truncated = found.get("truncated") == Some(&Value::Bool(true));
    let keyframes_table = table(
        &["index", "time", "name", "poseCount"],
        arr_of(found, "keyframes"),
        PageMeta {
            more: truncated.then(|| "poses expanded for the first 40 keyframes only".to_string()),
            ..Default::default()
        },
    );
    lines.push(String::new());
    lines.push(keyframes_table.text_of());
    text(lines.join("\n"))
}

async fn animation(ctx: Arc<Ctx>, a: AnimArgs) -> Result<ToolResult> {
    let studio = a.studio_id.as_deref();

    if a.op == AnimOp::Play {
        let Some(sequence) = a.sequence.as_deref().filter(|s| !s.is_empty()) else {
            return Ok(text(
                "play needs `sequence` — the path to a KeyframeSequence instance \
                 (the `instance` a prior `build`, called with `parent`, returned).",
            ));
        };
        let played = call(
            &ctx,
            "anim.play",
            json!({
                "sequence": sequence,
                "rig": a.rig,
                "player": a.player,
                "fadeTime": a.fade_time,
                "weight": a.weight,
                "speed": a.speed,
            }),
            studio,
            Some(TIMEOUT_MS),
        )
        .await?;
        return Ok(json(&played, None));
    }

    // `stop` means two different things depending on the target session: in a
    // playtest it stops tracks started by `play` on the client; in edit mode it
    // clears a preview.
    if a.op == AnimOp::Stop {
        let view = ctx.bridge.sessions().await?;
        let wanted = studio
            .or(view.active_id.as_deref())
            .or_else(|| (view.list.len() == 1).then(|| view.list[0].identity.studio_id.as_str()));
        let target = wanted.and_then(|id| view.list.iter().find(|s| s.identity.studio_id == id));
        if target.and_then(|s| s.identity.context.as_deref()).is_some_and(|c| c.starts_with("playtest")) {
            let stopped = call(
                &ctx,
                "anim.stopPlay",
                json!({ "rig": a.rig, "player": a.player }),
                studio,
                Some(TIMEOUT_MS),
            )
            .await?;
            let note = (stopped.get("stopped").and_then(Value::as_u64) == Some(0))
                .then_some("Nothing to stop: no animation that `play` started is playing on that rig.");
            return Ok(json(&stopped, note));
        }
    }

    if matches!(a.op, AnimOp::Preview | AnimOp::Stop) {
        let Some(rig) = a.rig.as_deref().filter(|s| !s.is_empty()) else {
            return Ok(text(if a.op == AnimOp::Stop {
                "stop needs a `rig` in edit mode (the previewed model). To stop what \
                 `play` started, address `stop` to the playtest's studioId."
            } else {
                "preview needs a `rig` — the model to pose."
            }));
        };
        let posed = call(
            &ctx,
            "anim.preview",
            json!({ "op": a.op, "rig": rig, "assetId": a.asset_id, "at": a.at, "hold": a.hold }),
            studio,
            Some(TIMEOUT_MS),
        )
        .await?;
        return Ok(json(&posed, None));
    }

    if a.op == AnimOp::Build {
        let Some(keyframes) = a.keyframes.filter(|k| !k.is_empty()) else {
            return Ok(text("build needs a non-empty `keyframes` array."));
        };
        let built = call(
            &ctx,
            "anim.build",
            json!({
                "keyframes": keyframes,
                "name": a.name,
                "parent": a.parent,
                "root": a.root,
                "rig": a.rig,
                "priority": a.priority,
                "loop": a.looping,
            }),
            studio,
            Some(TIMEOUT_MS),
        )
        .await?;
        let note = build_note(&built, a.parent.as_deref());
        return Ok(json(&built, Some(&note)));
    }

    let Some(asset_id) = a.asset_id else {
        return Ok(text("read needs an `assetId` — a number, an rbxassetid:// string, or a path to an Animation."));
    };
    let found = call(&ctx, "anim.read", json!({ "assetId": asset_id }), studio, Some(TIMEOUT_MS)).await?;
    Ok(format_read(&found))
}

pub fn tools() -> Vec<Tool> {
    vec![define(
        spec("animation", "Read and build animations").destructive(false),
        "Reads an animation's actual keyframes, and builds new ones that play immediately in the open Studio.\n\n\
         Animations are the one part of a place no other tool can see. `inspect` on an Animation instance returns \
         an asset id and stops there — the poses live on Roblox's servers. `read` downloads them, so you can answer \
         'how long is it', 'which joints does it move', and 'does it end where it started' without opening the \
         Animation Editor and scrubbing.\n\n\
         `read` takes an asset id, an rbxassetid:// string, or the path of an Animation instance in the place — \
         whichever you already have. It reports which RIG the animation was made for, which is the thing most worth \
         knowing: an R15 animation on an R6 character does nothing at all — no error, no movement — and the asset \
         id gives no hint either way.\n\n\
         `build` goes the other way: give it keyframes and it returns a content id for `preview` and `read`. \
         Nothing is uploaded and nothing is moderated — the id works in this Studio's EDIT session and nowhere \
         else, which makes it the right way to try an idea and the wrong way to ship one.\n\n\
         NEVER put a `build` id in the AnimationId of an Animation that a real playtest will load. LoadAnimation \
         with it does not just fail — it breaks the character's whole Animator (full T-pose, every animation dead). \
         For an animation that must run in the game, pass `parent` (e.g. the Tool): `build` then leaves a real \
         KeyframeSequence instance there, and `play` loads and plays it on a running playtest's client in one call \
         — no hand-written execute_luau needed. The sequence must be somewhere the client can see (Workspace, \
         ReplicatedStorage, the rig or a Tool in the workspace — NOT ServerStorage). A new `play` replaces the one \
         before it on that rig instead of stacking, and `stop` addressed to the playtest's studioId stops it; the \
         game's own animations are left alone.\n\n\
         Give `build` at least two keyframes at different times. A single keyframe has zero length, and a \
         zero-length animation cannot be previewed (the preview times out). A single or all-at-time-0 animation is \
         padded automatically with a repeat of the last keyframe 0.1s later, and the reply says so — but writing \
         two yourself is clearer.\n\n\
         `preview` puts an animation ONTO a rig in the open place and freezes it at a chosen moment, so `screenshot` \
         can show you the pose. It works in edit mode — no playtest. Ask for several moments in turn to compare \
         poses across the animation; the rig stays posed until `stop`.\n\n\
         Poses are written the way a CFrame property is: \"0, 1, 0\" for a position, \"0, 1, 0 | 0, 45, 0\" to \
         rotate as well.\n\n\
         The id `build` returns is a bare hash, not an rbxassetid:// URL. Use it exactly as given — prefixing it \
         stops it working. It is preview-only.",
        animation,
    )]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_has_no_refs() {
        let list = tools();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "animation");
        let raw = serde_json::to_string(&list[0].schema).unwrap();
        assert!(!raw.contains("$ref"), "animation schema must not contain $ref: {raw}");
    }

    #[test]
    fn build_note_handles_kept_failed_and_omitted_parent() {
        let kept = build_note(&json!({ "instance": "ReplicatedStorage.Swing" }), Some("ReplicatedStorage"));
        assert!(kept.contains("PREVIEW ONLY"));
        assert!(kept.contains("animation op=\"play\" sequence=\"ReplicatedStorage.Swing\""));
        assert!(kept.contains("unrootedJoints"));

        let failed = build_note(&json!({ "instanceNote": "parent not found" }), Some("Workspace.Nope"));
        assert!(failed.contains("NOTHING WAS KEPT: parent not found"));

        let bare = build_note(&json!({}), None);
        assert!(bare.contains("Pass `parent` to keep a real KeyframeSequence"));
    }

    #[test]
    fn format_read_warns_on_rig_mismatch_and_loop_drift() {
        let rendered = format_read(&json!({
            "name": "Walk",
            "assetId": "rbxassetid://123",
            "rig": "R15",
            "duration": 1.2,
            "keyframeCount": 2,
            "jointCount": 1,
            "priority": "Movement",
            "looping": true,
            "endsWhereItStarted": false,
            "driftingJoints": ["LeftUpperLeg"],
            "joints": ["LeftUpperLeg"],
            "keyframes": [{ "index": 1, "time": 0, "name": "Start", "poseCount": 1 }],
            "truncated": false
        }))
        .text_of();
        assert!(rendered.contains("This is an R15 animation. It will do NOTHING on an R6 character"));
        assert!(rendered.contains("do not end where they started: LeftUpperLeg"));
    }
}
