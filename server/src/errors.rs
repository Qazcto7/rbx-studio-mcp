//! Errors written for an agent: what failed and what to try next.

use std::fmt;

#[derive(Debug, Clone)]
pub struct ToolError {
    pub code: String,
    pub message: String,
    pub hint: Option<String>,
}

pub type Result<T, E = ToolError> = std::result::Result<T, E>;

impl ToolError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into(), hint: None }
    }

    pub fn hint(code: impl Into<String>, message: impl Into<String>, hint: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into(), hint: Some(hint.into()) }
    }

    pub fn internal(message: impl fmt::Display) -> Self {
        Self::new("INTERNAL", message.to_string())
    }

    pub fn bad_params(message: impl Into<String>) -> Self {
        Self::new("BAD_PARAMS", message)
    }

    /// Message plus hint, the way the agent reads it.
    pub fn full_message(&self) -> String {
        match &self.hint {
            Some(hint) => format!("{}\n{}", self.message, hint),
            None => self.message.clone(),
        }
    }

    pub fn render(&self) -> String {
        format!("[{}] {}", self.code, self.full_message())
    }
}

impl fmt::Display for ToolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.full_message())
    }
}

impl std::error::Error for ToolError {}

impl From<serde_json::Error> for ToolError {
    fn from(value: serde_json::Error) -> Self {
        ToolError::internal(value)
    }
}

impl From<std::io::Error> for ToolError {
    fn from(value: std::io::Error) -> Self {
        ToolError::internal(value)
    }
}

pub fn no_studio() -> ToolError {
    ToolError::hint(
        "NO_STUDIO",
        "No Roblox Studio instance is connected to this MCP server.",
        "Open Roblox Studio with the companion plugin installed — it connects \
         automatically on load. If it asks for permission to reach 127.0.0.1, \
         accept it. Check connection status under the Studio MCP toolbar button, \
         and use the reconnect button in that console if it is disconnected. \
         Then retry.",
    )
}

/// A playtest server that went away: the test ended, or teleported elsewhere.
pub fn playtest_moved(id: &str, servers: &[String]) -> ToolError {
    match servers {
        [] => ToolError::hint(
            "PLAYTEST_GONE",
            format!("The playtest server \"{id}\" has ended."),
            "Either the test stopped, or it teleported and the destination server has not connected yet \
             (that can take up to a minute). Check `playtest op=state` on the edit session, then `list_studios`.",
        ),
        [only] => ToolError::hint(
            "PLAYTEST_MOVED",
            format!("The playtest server \"{id}\" has ended; the test is now running on {only}."),
            "A teleport inside the test moves it to a new server with a new studioId. Use that id from here on.",
        ),
        many => ToolError::hint(
            "PLAYTEST_MOVED",
            format!("The playtest server \"{id}\" has ended; the test now has these servers: {}.", many.join(", ")),
            "A teleport inside the test moves players to another server with a new studioId. Pick the one for \
             the place you mean, or call `list_studios`.",
        ),
    }
}

pub fn unknown_studio(id: &str, closed_hint: bool) -> ToolError {
    ToolError::hint(
        "UNKNOWN_STUDIO",
        format!("No connected Studio has id \"{id}\"."),
        if closed_hint {
            "It may have closed or reconnected. Call list_studios to see the connected instances and their ids."
        } else {
            "Call list_studios to see the connected instances and their ids."
        },
    )
}

pub fn ambiguous_studio(rows: &[String]) -> ToolError {
    ToolError::hint(
        "AMBIGUOUS_STUDIO",
        format!(
            "{} Studio instances are connected and the user has not said which one to work in.",
            rows.len()
        ),
        format!(
            "Ask the user which place they mean, then call set_active_studio with its \
             studioId. Connected now: {}. To act on one place without changing the default, \
             pass `studioId` to the tool directly.",
            rows.join("; ")
        ),
    )
}

/// One place, two sessions: a running playtest. The choice follows from the call.
pub fn same_place_studio(rows: &[String]) -> ToolError {
    ToolError::hint(
        "AMBIGUOUS_STUDIO",
        "One place is open with a playtest running, so two sessions are connected \
         and neither is the default.",
        format!(
            "Pass `studioId` explicitly — do not ask the user, this is not two places. \
             Use the *edit* session for anything that must survive the playtest: \
             creating or modifying instances, script edits, geometry. Use the \
             *playtest* session for anything about the running game: character, input, \
             console, debug, performance. Edits made against the playtest are \
             discarded when it stops. Connected now: {}.",
            rows.join("; ")
        ),
    )
}

/// Another in-flight call on the same session that is itself known to make
/// Studio unresponsive (a playtest starting or stopping).
pub struct BusyWith {
    pub description: &'static str,
    pub for_ms: u64,
}

/// What the bridge knew when a call timed out.
pub struct TimeoutState {
    pub delivered: bool,
    pub silent_for_ms: u64,
    pub also_in_flight: usize,
    pub transport: &'static str,
    pub busy_with: Option<BusyWith>,
}

pub fn timeout(op: &str, ms: u64, state: Option<TimeoutState>) -> ToolError {
    let Some(state) = state else {
        return ToolError::hint(
            "TIMEOUT",
            format!("Studio did not answer \"{op}\" within {ms}ms."),
            "Call studio_status to check, then retry.",
        );
    };
    let silence = (state.silent_for_ms as f64 / 1000.0).round() as u64;
    let mut facts = vec![
        if state.delivered {
            "The command reached Studio and Studio did not finish it.".to_string()
        } else {
            "The command never reached Studio — it was still queued when the deadline passed.".to_string()
        },
        format!("Last heard from the plugin {silence}s ago, over {}.", state.transport),
        match state.also_in_flight {
            0 => "Nothing else was in flight.".to_string(),
            1 => "1 other call is still outstanding on this session.".to_string(),
            n => format!("{n} other calls are still outstanding on this session."),
        },
    ];
    let mut hint = if state.delivered {
        "The outcome is unknown: delivered work may still finish. Do not blindly \
         retry a mutation. Inspect the affected instances or read the edited scripts \
         first; retry only after verifying what actually changed."
            .to_string()
    } else {
        "The plugin has stopped collecting commands, which normally means Studio is \
         starting or stopping a playtest, or the window lost its connection. Call \
         list_studios to see which sessions are live, and address the call at one of them."
            .to_string()
    };
    if let Some(busy) = state.busy_with {
        let waited = (busy.for_ms as f64 / 1000.0).round() as u64;
        facts.push(format!(
            "Studio is currently {} (that call has been waiting {waited}s) — \
             almost certainly why this one has not returned either.",
            busy.description
        ));
        hint = "This is not a hang to retry: it is Studio busy with a playtest transition it is \
             already mid-way through. Do not resend this call. Poll `playtest` with \
             op=\"state\" instead, and only issue new requests once that settles (or call \
             op=\"stop\" if it has been stuck long enough to be offered as stale)."
            .to_string();
        // Never delivered is also what a window that lost its connection looks
        // like -- and there a `state` poll gets stuck in the same queue. The busy
        // reading stays the likelier one, so it leads; the other is not dropped.
        if !state.delivered {
            hint.push_str(
                " This command never even reached Studio, though, so if `list_studios` shows \
                 this session silent for minutes, the window may have lost its connection \
                 instead: address a live session, or restart Studio if none answers.",
            );
        }
    }
    ToolError::hint("TIMEOUT", format!("Studio did not answer \"{op}\" within {ms}ms. {}", facts.join(" ")), hint)
}

pub fn disconnected() -> ToolError {
    ToolError::hint(
        "DISCONNECTED",
        "The Studio connection dropped while the request was in flight.",
        "Studio was closed, the place was switched, or the plugin was disabled. \
         Call studio_status to confirm a live connection. Delivered mutations may have \
         completed: inspect the affected state before retrying.",
    )
}

/// Largest timeout a caller may ask for, matching the old Node timer range.
pub const MAX_TIMER_MS: u64 = (1 << 31) - 1;

/// Rounds up so normalisation never shortens a caller's budget or its padding.
pub fn normalize_timeout_ms(value: f64, padding_ms: u64) -> Result<u64> {
    if !value.is_finite() || value <= 0.0 || value.ceil() as u64 > MAX_TIMER_MS.saturating_sub(padding_ms) {
        return Err(ToolError::new(
            "BAD_TIMEOUT",
            "timeoutMs must be a finite positive number within the timer range.",
        ));
    }
    Ok(value.ceil() as u64 + padding_ms)
}

/// Delay before poll number `attempt` of a usually-quick task, growing to a ceiling.
pub fn poll_delay_ms(attempt: u32, ceiling_ms: u64, first_ms: u64) -> u64 {
    let grown = (first_ms as f64 * 1.6f64.powi(attempt as i32)).round() as u64;
    grown.min(ceiling_ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn busy_playtest_timeout_delivered_replaces_hint() {
        let err = timeout(
            "discover.tree",
            15_000,
            Some(TimeoutState {
                delivered: true,
                silent_for_ms: 4_000,
                also_in_flight: 1,
                transport: "sse",
                busy_with: Some(BusyWith { description: "starting a playtest", for_ms: 32_000 }),
            }),
        );
        assert!(err.message.contains("Studio is currently starting a playtest (that call has been waiting 32s)"));
        let hint = err.hint.as_deref().unwrap_or("");
        assert!(hint.contains("Poll `playtest`"));
        assert!(!hint.contains("lost its connection"));
    }

    #[test]
    fn busy_playtest_timeout_undelivered_keeps_lost_connection_advice() {
        let err = timeout(
            "discover.tree",
            15_000,
            Some(TimeoutState {
                delivered: false,
                silent_for_ms: 4_000,
                also_in_flight: 1,
                transport: "poll",
                busy_with: Some(BusyWith { description: "starting a playtest", for_ms: 45_000 }),
            }),
        );
        assert!(err.message.contains("Studio is currently starting a playtest (that call has been waiting 45s)"));
        let hint = err.hint.as_deref().unwrap_or("");
        assert!(hint.contains("Poll `playtest`"));
        assert!(hint.contains("never even reached Studio"));
        assert!(hint.contains("lost its connection"));
    }
}
