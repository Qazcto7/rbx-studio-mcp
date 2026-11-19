//! Where Roblox Studio looks for plugins, on every platform this server runs on.
//!
//! Shared by `--install-plugin` (which writes to every discovered folder) and
//! `doctor` (which checks them and matches a connected Studio's build id back
//! to the folder it loaded from).
//!
//! On Linux, Studio runs under Wine — usually through Vinegar — and one machine
//! can hold several prefixes at once (native Vinegar, Flatpak Vinegar, plain
//! Wine, or a custom `$WINEPREFIX`), plus Vinegar's `user.reg` redirect of
//! `Local AppData` outside the prefix.

use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::LazyLock;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginDir {
    pub dir: PathBuf,
    pub label: String,
}

/// Lists sorted subdirectory names, or empty if unreadable.
fn child_dirs(dir: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|e| e.file_name().into_string().ok())
        .collect();
    names.sort();
    names
}

/// Decodes a Wine `.reg` string escape sequence the way Wine reads it back:
/// `\x` + 1..4 hex digits for non-ASCII, 1..3 octal digits, standard C control
/// escapes, and literal next-char for `\\`, `\"`, etc.
pub fn unescape_reg_string(raw: &str) -> String {
    let chars: Vec<char> = raw.chars().collect();
    let mut out = String::with_capacity(raw.len());
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if ch != '\\' || i + 1 >= chars.len() {
            out.push(ch);
            i += 1;
            continue;
        }
        let next = chars[i + 1];
        if next == 'x' {
            let mut hex = String::new();
            let mut j = i + 2;
            while j < chars.len() && hex.len() < 4 && chars[j].is_ascii_hexdigit() {
                hex.push(chars[j]);
                j += 1;
            }
            if !hex.is_empty()
                && let Ok(code) = u32::from_str_radix(&hex, 16)
                && let Some(decoded) = char::from_u32(code)
            {
                out.push(decoded);
                i = j;
                continue;
            }
        }
        if matches!(next, '0'..='7') {
            let mut oct = String::new();
            let mut j = i + 1;
            while j < chars.len() && oct.len() < 3 && matches!(chars[j], '0'..='7') {
                oct.push(chars[j]);
                j += 1;
            }
            if let Ok(code) = u32::from_str_radix(&oct, 8)
                && let Some(decoded) = char::from_u32(code)
            {
                out.push(decoded);
                i = j;
                continue;
            }
        }
        out.push(match next {
            'a' => '\x07',
            'b' => '\x08',
            'e' => '\x1b',
            'f' => '\x0c',
            'n' => '\n',
            'r' => '\r',
            't' => '\t',
            'v' => '\x0b',
            other => other,
        });
        i += 2;
    }
    out
}

/// Resolves a path's nearest existing ancestor through symlinks, plus the
/// remaining non-existent tail components (e.g. `Plugins` before first install).
pub fn canonical(dir: &Path) -> PathBuf {
    let abs = if dir.is_absolute() {
        dir.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(dir)
    };
    let mut norm = PathBuf::new();
    for comp in abs.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                norm.pop();
            }
            other => norm.push(other.as_os_str()),
        }
    }
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    let mut at = norm.as_path();
    loop {
        if let Ok(real) = std::fs::canonicalize(at) {
            let mut out = real;
            for part in tail.into_iter().rev() {
                out.push(part);
            }
            return out;
        }
        match (at.parent(), at.file_name()) {
            (Some(parent), Some(name)) if parent != at => {
                tail.push(name.to_os_string());
                at = parent;
            }
            _ => return norm,
        }
    }
}

/// Where a Wine prefix's `user.reg` says `Local AppData` lives, as a host path.
///
/// Vinegar writes `User Shell Folders\Local AppData = Z:\home\<user>\.local\share\vinegar\appdata`,
/// redirecting `%LOCALAPPDATA%` outside the prefix. Falls back to `Shell Folders`
/// when `User Shell Folders` still contains an unexpanded `%VAR%`.
fn registered_local_appdata(prefix: &Path) -> Option<PathBuf> {
    static VALUE_RE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r#"(?i)^"Local AppData"=(?:str\(\d+\):)?"((?:[^"\\]|\\.)*)"\s*$"#).expect("regex"));
    static DRIVE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([A-Za-z]):[\\/]?(.*)$").expect("regex"));

    let reg = std::fs::read_to_string(prefix.join("user.reg")).ok()?;
    let mut found: HashMap<&'static str, String> = HashMap::new();
    let mut section: Option<&'static str> = None;

    for line in reg.lines() {
        if let Some(rest) = line.strip_prefix('[') {
            if let Some(end) = rest.find(']') {
                let name = rest[..end].replace("\\\\", "\\").to_lowercase();
                section = if name.ends_with("\\explorer\\user shell folders") {
                    Some("user shell folders")
                } else if name.ends_with("\\explorer\\shell folders") {
                    Some("shell folders")
                } else {
                    None
                };
            }
            continue;
        }
        let Some(sec) = section else { continue };
        if let Some(caps) = VALUE_RE.captures(line) {
            found.insert(sec, unescape_reg_string(&caps[1]));
        }
    }

    let windows = ["user shell folders", "shell folders"]
        .into_iter()
        .filter_map(|k| found.get(k))
        .find(|v| !v.contains('%'))?;

    let caps = DRIVE_RE.captures(windows)?;
    let letter = caps[1].to_lowercase();
    let rest: Vec<&str> = caps[2].split(['\\', '/']).filter(|s| !s.is_empty()).collect();

    let root = if letter == "z" {
        PathBuf::from("/")
    } else {
        let link = prefix.join("dosdevices").join(format!("{letter}:"));
        match std::fs::read_link(&link) {
            Ok(target) => {
                if target.is_absolute() {
                    target
                } else {
                    prefix.join("dosdevices").join(target)
                }
            }
            Err(_) if letter == "c" => prefix.join("drive_c"),
            Err(_) => return None,
        }
    };

    let mut path = root;
    for part in rest {
        path.push(part);
    }
    Some(path)
}

fn in_prefix(prefix: &Path, label: &str) -> Vec<PluginDir> {
    let mut found = Vec::new();
    let users = prefix.join("drive_c").join("users");
    let user_names = child_dirs(&users);
    let profile_locals: Vec<PathBuf> = user_names
        .iter()
        .map(|u| canonical(&users.join(u).join("AppData").join("Local")))
        .collect();

    if let Some(redirected) = registered_local_appdata(prefix)
        && redirected.join("Roblox").exists()
        && !profile_locals.contains(&canonical(&redirected))
    {
        found.push(PluginDir {
            dir: redirected.join("Roblox").join("Plugins"),
            label: format!("{label}, Local AppData redirect"),
        });
    }

    for user in user_names {
        if user == "Public" {
            continue;
        }
        let local = users.join(&user).join("AppData").join("Local");
        if !local.join("Roblox").exists() {
            continue;
        }
        found.push(PluginDir {
            dir: local.join("Roblox").join("Plugins"),
            label: format!("{label} ({user})"),
        });
    }
    found
}

fn in_vinegar_data(data_dir: &Path, label: &str) -> Vec<PluginDir> {
    let mut found = Vec::new();
    let prefixes_dir = data_dir.join("prefixes");
    for name in child_dirs(&prefixes_dir) {
        found.extend(in_prefix(&prefixes_dir.join(&name), &format!("{label} {name} prefix")));
    }
    found.extend(in_prefix(&data_dir.join("prefix"), &format!("{label} prefix")));
    found
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Windows,
    MacOs,
    Linux,
}

impl Platform {
    pub fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            Self::MacOs
        } else {
            Self::Linux
        }
    }
}

/// Discovers every plugins folder Studio might read from on the current host.
pub fn plugin_dirs() -> Vec<PluginDir> {
    let env: HashMap<String, String> = std::env::vars().collect();
    let home = dirs::home_dir().unwrap_or_default();
    plugin_dirs_with(Platform::current(), &env, &home)
}

/// Testable core: takes platform, environment map, and home directory explicitly.
pub fn plugin_dirs_with(platform: Platform, env: &HashMap<String, String>, home: &Path) -> Vec<PluginDir> {
    if let Some(override_dirs) = env.get("STUDIO_MCP_PLUGINS_DIR").filter(|s| !s.is_empty()) {
        let sep = if platform == Platform::Windows { ';' } else { ':' };
        return override_dirs
            .split(sep)
            .filter(|s| !s.is_empty())
            .map(|dir| PluginDir { dir: PathBuf::from(dir), label: "STUDIO_MCP_PLUGINS_DIR".into() })
            .collect();
    }

    if platform == Platform::Windows {
        let local = env
            .get("LOCALAPPDATA")
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData").join("Local"));
        return vec![PluginDir { dir: local.join("Roblox").join("Plugins"), label: "Windows".into() }];
    }

    if platform == Platform::MacOs {
        return vec![PluginDir {
            dir: home.join("Documents").join("Roblox").join("Plugins"),
            label: "macOS".into(),
        }];
    }

    let mut found = Vec::new();
    let data_home = env
        .get("XDG_DATA_HOME")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".local").join("share"));
    found.extend(in_vinegar_data(&data_home.join("vinegar"), "Vinegar"));
    found.extend(in_vinegar_data(
        &home.join(".var").join("app").join("org.vinegarhq.Vinegar").join("data").join("vinegar"),
        "Vinegar (Flatpak)",
    ));
    if let Some(wine_prefix) = env.get("WINEPREFIX").filter(|s| !s.is_empty()) {
        found.extend(in_prefix(Path::new(wine_prefix), "WINEPREFIX"));
    }
    found.extend(in_prefix(&home.join(".wine"), "Wine default prefix"));

    let mut seen: HashSet<PathBuf> = HashSet::new();
    found.retain(|entry| seen.insert(canonical(&entry.dir)));
    found
}

pub fn no_plugins_dir_message() -> String {
    if cfg!(target_os = "linux") {
        "Could not find a Wine prefix with Roblox Studio in it. Looked under \
         ~/.local/share/vinegar, ~/.var/app/org.vinegarhq.Vinegar/data/vinegar, \
         $WINEPREFIX and ~/.wine.\n\
         Run Studio once so it creates its folders, or name the plugins folder yourself:\n  \
         STUDIO_MCP_PLUGINS_DIR=<prefix>/drive_c/users/<user>/AppData/Local/Roblox/Plugins \
         rbx-studio-mcp --install-plugin"
            .into()
    } else {
        "Roblox Studio's plugins folder is unknown on this platform. Set STUDIO_MCP_PLUGINS_DIR \
         to the folder and re-run --install-plugin."
            .into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_home(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rbx-mcp-plugindirs-{tag}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn decodes_wine_reg_escapes() {
        assert_eq!(unescape_reg_string(r"Z:\\home\\K\x00e2z\x131m\\.local"), r"Z:\home\Kâzım\.local");
        assert_eq!(unescape_reg_string(r"a\tb\nc\101"), "a\tb\ncA");
    }

    #[test]
    fn discovers_native_flatpak_wine_and_skips_public() {
        let home = temp_home("multi");
        let native_roblox = home.join(".local/share/vinegar/prefixes/studio/drive_c/users/kazim/AppData/Local/Roblox");
        let public_roblox = home.join(".local/share/vinegar/prefixes/studio/drive_c/users/Public/AppData/Local/Roblox");
        let flatpak_roblox = home.join(".var/app/org.vinegarhq.Vinegar/data/vinegar/prefixes/studio/drive_c/users/kazim/AppData/Local/Roblox");
        let wine_roblox = home.join(".wine/drive_c/users/kazim/AppData/Local/Roblox");
        for p in [&native_roblox, &public_roblox, &flatpak_roblox, &wine_roblox] {
            fs::create_dir_all(p).unwrap();
        }
        let dirs = plugin_dirs_with(Platform::Linux, &HashMap::new(), &home);
        assert_eq!(dirs.len(), 3);
        assert_eq!(dirs[0].dir, native_roblox.join("Plugins"));
        assert_eq!(dirs[1].dir, flatpak_roblox.join("Plugins"));
        assert_eq!(dirs[2].dir, wine_roblox.join("Plugins"));
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn honours_vinegar_redirect_and_ignores_default_shell_folder() {
        let home = temp_home("redirect");
        let prefix = home.join(".local/share/vinegar/prefixes/studio");
        let user_local = prefix.join("drive_c/users/kazim/AppData/Local");
        fs::create_dir_all(user_local.join("Roblox")).unwrap();

        // 1. Default Wine Shell Folders pointing to the user's own AppData/Local is NOT a redirect.
        fs::write(
            prefix.join("user.reg"),
            "[Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Explorer\\\\User Shell Folders]\n\
             \"Local AppData\"=str(2):\"%USERPROFILE%\\\\AppData\\\\Local\"\n\
             [Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Explorer\\\\Shell Folders]\n\
             \"Local AppData\"=\"C:\\\\users\\\\kazim\\\\AppData\\\\Local\"\n",
        )
        .unwrap();
        let plain = plugin_dirs_with(Platform::Linux, &HashMap::new(), &home);
        assert_eq!(plain.len(), 1);
        assert!(!plain[0].label.contains("redirect"), "default folder must not be labelled redirect: {}", plain[0].label);

        // 2. Real Vinegar redirect to non-ASCII host folder outside prefix with Roblox dir inside.
        let redirected = home.join("Kâzım-appdata");
        fs::create_dir_all(redirected.join("Roblox")).unwrap();
        let win_path = format!("Z:{}", redirected.to_string_lossy().replace('/', "\\\\"))
            .replace('â', "\\x00e2")
            .replace('ı', "\\x131");
        fs::write(
            prefix.join("user.reg"),
            format!(
                "[Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Explorer\\\\User Shell Folders]\n\
                 \"Local AppData\"=str(2):\"{win_path}\"\n"
            ),
        )
        .unwrap();
        let with_redirect = plugin_dirs_with(Platform::Linux, &HashMap::new(), &home);
        assert_eq!(with_redirect.len(), 2);
        assert_eq!(with_redirect[0].dir, redirected.join("Roblox/Plugins"));
        assert!(with_redirect[0].label.contains("Local AppData redirect"));
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn skips_redirect_without_roblox_folder() {
        let home = temp_home("noredirect");
        let prefix = home.join(".wine");
        fs::create_dir_all(&prefix).unwrap();
        let other = home.join("other-app");
        fs::create_dir_all(&other).unwrap();
        let win_path = format!("Z:{}", other.to_string_lossy().replace('/', "\\\\"));
        fs::write(
            prefix.join("user.reg"),
            format!(
                "[Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Explorer\\\\Shell Folders]\n\
                 \"Local AppData\"=\"{win_path}\"\n"
            ),
        )
        .unwrap();
        let dirs = plugin_dirs_with(Platform::Linux, &HashMap::new(), &home);
        assert!(dirs.is_empty());
        let _ = fs::remove_dir_all(&home);
    }

    #[cfg(unix)]
    #[test]
    fn deduplicates_symlinked_prefixes() {
        let home = temp_home("symlink");
        let real = home.join(".local/share/vinegar/prefixes/studio");
        fs::create_dir_all(real.join("drive_c/users/kazim/AppData/Local/Roblox")).unwrap();
        let link = home.join(".wine");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let dirs = plugin_dirs_with(Platform::Linux, &HashMap::new(), &home);
        assert_eq!(dirs.len(), 1, "symlinked prefix must dedupe to one entry");
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn override_and_windows_and_macos() {
        let home = Path::new("/tmp/fakehome");
        let mut env = HashMap::new();
        env.insert("STUDIO_MCP_PLUGINS_DIR".into(), "/a:/b".into());
        let dirs = plugin_dirs_with(Platform::Linux, &env, home);
        assert_eq!(dirs.len(), 2);
        assert_eq!(dirs[0].label, "STUDIO_MCP_PLUGINS_DIR");

        let mac = plugin_dirs_with(Platform::MacOs, &HashMap::new(), home);
        assert_eq!(mac[0].dir, home.join("Documents/Roblox/Plugins"));

        let mut wenv = HashMap::new();
        wenv.insert("LOCALAPPDATA".into(), "/win/local".into());
        let win = plugin_dirs_with(Platform::Windows, &wenv, home);
        assert_eq!(win[0].dir, PathBuf::from("/win/local/Roblox/Plugins"));
    }
}
