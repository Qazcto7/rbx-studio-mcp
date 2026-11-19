//! Answers "why is this not working" without anyone having to guess.
//! Every check ends in an instruction rather than a verdict.

use crate::bridge::{http_client, probe_owner};
use crate::plugin_dirs::{PluginDir, no_plugins_dir_message, plugin_dirs};
use crate::protocol::{
    CLIENT_HEADER, EMBEDDED_BUILD_ID, EMBEDDED_PLUGIN, PROTOCOL_VERSION, StudioSession, VERSION,
    expected_plugin_build_id,
};
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Status {
    Ok,
    Warn,
    Bad,
}

#[derive(Debug)]
pub struct Check {
    pub status: Status,
    pub title: String,
    pub detail: String,
}

fn check(status: Status, title: impl Into<String>, detail: impl Into<String>) -> Check {
    Check { status, title: title.into(), detail: detail.into() }
}

/// The build id stamped into an installed plugin file, if it carries one.
fn installed_build_id(contents: &str) -> Option<String> {
    let start = contents.find("Config.BUILD_ID = \"")? + "Config.BUILD_ID = \"".len();
    let len = contents[start..].find('"')?;
    Some(contents[start..start + len].to_string())
}

/// One discovered plugins folder and whatever build id is stamped on disk there.
#[derive(Debug, Clone)]
pub struct InstalledCopy {
    pub dir: PathBuf,
    pub label: String,
    pub file: PathBuf,
    pub exists: bool,
    pub id: Option<String>,
}

fn installed_copies() -> Vec<InstalledCopy> {
    plugin_dirs()
        .into_iter()
        .map(|PluginDir { dir, label }| {
            let file = dir.join("StudioMCP.rbxmx");
            let exists = file.exists();
            let id = if exists {
                std::fs::read_to_string(&file).ok().and_then(|s| installed_build_id(&s))
            } else {
                None
            };
            InstalledCopy { dir, label, file, exists, id }
        })
        .collect()
}

fn check_plugin_files(copies: &[InstalledCopy], expected: &str) -> Vec<Check> {
    if copies.is_empty() {
        return vec![check(
            Status::Warn,
            "Studio plugin",
            "No Roblox Studio plugins folder found on this machine.\n  \
             Run Studio once, or point at the folder with STUDIO_MCP_PLUGINS_DIR.",
        )];
    }

    copies
        .iter()
        .map(|copy| {
            let title = if copies.len() > 1 {
                format!("Studio plugin [{}]", copy.label)
            } else {
                "Studio plugin".to_string()
            };
            if !copy.exists {
                return check(
                    if copies.len() > 1 { Status::Warn } else { Status::Bad },
                    title,
                    format!(
                        "Not installed. No file at {}.\n  Fix: rbx-studio-mcp --install-plugin",
                        copy.file.display()
                    ),
                );
            }
            let Some(id) = copy.id.as_deref() else {
                return check(
                    Status::Bad,
                    title,
                    format!(
                        "{} carries no build id, so it is truncated or not a StudioMCP build.\n  \
                         Fix: rbx-studio-mcp --install-plugin, then QUIT Studio and start it again.",
                        copy.file.display()
                    ),
                );
            };
            if expected != "unknown" && id != expected {
                return check(
                    Status::Bad,
                    title,
                    format!(
                        "Stale: {} is build {id}, this server expects {expected}.\n  \
                         Fix: rbx-studio-mcp --install-plugin, then QUIT Studio completely and start \
                         it again. Focusing the window does not reload it.",
                        copy.file.display()
                    ),
                );
            }
            check(Status::Ok, title, format!("Installed at {} (build {id})", copy.file.display()))
        })
        .collect()
}

/// Which installed copy (or copies) a connected session's build id matches.
///
/// On a machine with several Wine/Vinegar prefixes, a buildId mismatch on the
/// session tells you *that* something is stale; this cross-reference tells you
/// *which folder* Studio loaded it from.
pub fn match_installs(build_id: &str, copies: &[InstalledCopy]) -> String {
    let matches: Vec<&InstalledCopy> = copies.iter().filter(|c| c.id.as_deref() == Some(build_id)).collect();
    if matches.is_empty() {
        if copies.is_empty() {
            return String::new();
        }
        return "\n  Loaded plugin matches none of the installed copies on this machine \
                (all of them are a different build, or it was installed somewhere \
                STUDIO_MCP_PLUGINS_DIR/the default search does not look)."
            .to_string();
    }
    if matches.len() == 1 {
        return format!("\n  Loaded from: {} ({})", matches[0].label, matches[0].dir.display());
    }
    let labels: Vec<&str> = matches.iter().map(|c| c.label.as_str()).collect();
    format!("\n  Loaded from one of: {} (same build id, cannot tell which)", labels.join(", "))
}

async fn check_port(port: u16) -> Check {
    match probe_owner(port).await {
        None => check(
            Status::Warn,
            format!("Bridge on 127.0.0.1:{port}"),
            "Nothing answering, or something that is not this server.\n  That is normal if no agent is \
             running: the server starts when your MCP client launches it.\n  If an agent IS running, \
             something else holds the port. Start with --port <other> and set the same port in the Studio panel.",
        ),
        Some(owner) => {
            let drift = if owner.protocol_version == PROTOCOL_VERSION {
                String::new()
            } else {
                format!("\n  Protocol {} vs this build's {PROTOCOL_VERSION}.", owner.protocol_version)
            };
            check(Status::Ok, format!("Bridge on 127.0.0.1:{port}"), format!("Answering, owned by pid {}.{drift}", owner.pid))
        }
    }
}

#[derive(Deserialize)]
struct Sessions {
    list: Vec<StudioSession>,
}

async fn check_studios(port: u16, expected: &str, copies: &[InstalledCopy]) -> Vec<Check> {
    let sessions = async {
        http_client()
            .get(format!("http://127.0.0.1:{port}/sessions"))
            .header(CLIENT_HEADER, "doctor")
            .timeout(Duration::from_secs(5))
            .send()
            .await
            .ok()?
            .json::<Sessions>()
            .await
            .ok()
    }
    .await;
    let Some(sessions) = sessions else { return vec![] };
    if sessions.list.is_empty() {
        return vec![check(
            Status::Bad,
            "Studio sessions",
            "The bridge is up but no Studio is connected.\n  Open Studio. If it is already open, click the \
             Studio MCP toolbar button and check the console panel; use its reconnect button.\n  If Studio \
             asked for permission to reach 127.0.0.1, it must be allowed.",
        )];
    }
    let locate = copies.len() > 1;
    sessions
        .list
        .into_iter()
        .map(|s| {
            let stale = expected != "unknown" && s.identity.build_id != expected;
            let base = if stale {
                format!(
                    "Plugin build {} does not match this server's {expected}.\n  \
                     Fix: rbx-studio-mcp --install-plugin, then QUIT Studio completely and start it again.",
                    s.identity.build_id
                )
            } else {
                format!(
                    "{}, over {}, plugin {}",
                    s.identity.context.as_deref().unwrap_or("edit"),
                    s.identity.transport,
                    s.identity.plugin_version
                )
            };
            let matched = if locate { match_installs(&s.identity.build_id, copies) } else { String::new() };
            check(
                if stale { Status::Warn } else { Status::Ok },
                format!("Studio: {}", s.identity.place_name),
                format!("{base}{matched}"),
            )
        })
        .collect()
}

pub async fn collect_checks(port: u16) -> Vec<Check> {
    let expected = expected_plugin_build_id();
    let copies = installed_copies();
    let mut checks = vec![check(
        Status::Ok,
        "Server",
        format!("rbx-studio-mcp {VERSION} (native), plugin build {}", EMBEDDED_BUILD_ID.trim()),
    )];
    checks.extend(check_plugin_files(&copies, &expected));
    checks.push(check_port(port).await);
    checks.extend(check_studios(port, &expected, &copies).await);
    checks
}

pub async fn run(port: u16) -> i32 {
    let checks = collect_checks(port).await;
    let mark = |s: Status| match s {
        Status::Ok => "PASS",
        Status::Warn => "WARN",
        Status::Bad => "FAIL",
    };
    let lines: Vec<String> = checks.iter().map(|c| format!("[{}] {}\n  {}", mark(c.status), c.title, c.detail)).collect();
    let bad = checks.iter().filter(|c| c.status == Status::Bad).count();
    let warn = checks.iter().filter(|c| c.status == Status::Warn).count();
    println!(
        "{}\n\n{} passed, {warn} warning(s), {bad} failure(s)",
        lines.join("\n\n"),
        checks.len() - bad - warn
    );
    if bad > 0 { 1 } else { 0 }
}

/// Writes `bytes` into `dir/StudioMCP.rbxmx` via a per-process staging file so
/// concurrent installs cannot collide and Studio never reads half a file.
fn install_one(dir: &Path, bytes: &[u8]) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let destination = dir.join("StudioMCP.rbxmx");
    let staged = dir.join(format!("StudioMCP.rbxmx.{}.incoming", std::process::id()));
    std::fs::write(&staged, bytes)
        .and_then(|_| std::fs::rename(&staged, &destination))
        .map_err(|e| {
            let _ = std::fs::remove_file(&staged);
            e.to_string()
        })?;
    let written = std::fs::read(&destination).map_err(|e| e.to_string())?;
    if written != bytes {
        return Err(format!("{} does not match the build that was just written there.", destination.display()));
    }
    Ok(destination)
}

pub struct InstallReport {
    pub installed: Vec<(PathBuf, String)>,
    pub failed: Vec<(PathBuf, String, String)>,
}

/// Writes the embedded plugin into every discovered Studio plugins folder.
pub fn install_plugin() -> Result<InstallReport, String> {
    if EMBEDDED_PLUGIN.is_empty() {
        return Err("This build has no embedded plugin.".into());
    }
    let targets = plugin_dirs();
    if targets.is_empty() {
        return Err(no_plugins_dir_message());
    }
    let mut report = InstallReport { installed: Vec::new(), failed: Vec::new() };
    for target in targets {
        match install_one(&target.dir, EMBEDDED_PLUGIN) {
            Ok(path) => report.installed.push((path, target.label)),
            Err(err) => report.failed.push((target.dir, target.label, err)),
        }
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn copy(label: &str, dir: &str, id: Option<&str>) -> InstalledCopy {
        InstalledCopy {
            dir: PathBuf::from(dir),
            label: label.into(),
            file: PathBuf::from(dir).join("StudioMCP.rbxmx"),
            exists: true,
            id: id.map(str::to_string),
        }
    }

    #[test]
    fn match_installs_identifies_exact_ambiguous_and_unknown_sources() {
        let copies = vec![copy("Vinegar", "/v/Plugins", Some("aaa")), copy("Flatpak", "/f/Plugins", Some("bbb"))];
        assert_eq!(match_installs("aaa", &copies), "\n  Loaded from: Vinegar (/v/Plugins)");
        assert_eq!(match_installs("bbb", &copies), "\n  Loaded from: Flatpak (/f/Plugins)");
        assert!(match_installs("ccc", &copies).contains("matches none of the installed copies"));

        let same = vec![copy("Vinegar", "/v/Plugins", Some("aaa")), copy("Flatpak", "/f/Plugins", Some("aaa"))];
        assert!(match_installs("aaa", &same).contains("Loaded from one of: Vinegar, Flatpak"));
        assert_eq!(match_installs("aaa", &[]), "");
    }

    #[test]
    fn check_plugin_files_flags_stale_and_truncated() {
        let copies = vec![
            copy("Vinegar", "/v", Some("old123")),
            copy("Flatpak", "/f", None),
            copy("Wine", "/w", Some("cur999")),
        ];
        let checks = check_plugin_files(&copies, "cur999");
        assert_eq!(checks[0].status, Status::Bad);
        assert!(checks[0].detail.contains("Stale:"));
        assert!(checks[0].detail.contains("Focusing the window does not reload it."));
        assert_eq!(checks[1].status, Status::Bad);
        assert!(checks[1].detail.contains("carries no build id"));
        assert_eq!(checks[2].status, Status::Ok);
    }

    #[test]
    fn install_one_writes_atomically_and_cleans_staging() {
        let dir = std::env::temp_dir().join(format!("rbx-mcp-install-{}", uuid::Uuid::new_v4()));
        let path = install_one(&dir, b"Config.BUILD_ID = \"abc123\"").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"Config.BUILD_ID = \"abc123\"");
        assert!(!dir.join(format!("StudioMCP.rbxmx.{}.incoming", std::process::id())).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
