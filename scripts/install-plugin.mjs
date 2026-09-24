/**
 * Builds the plugin and drops it into every Roblox Studio plugins folder it can find.
 *
 * Usage: node scripts/install-plugin.mjs
 *
 * After it runs, RESTART STUDIO. Studio loads plugins at startup; clicking back
 * into the window does not reload them. (On Windows and macOS it sometimes
 * appears to, which is where the older advice came from -- under Wine it does
 * not, and a plugin installed while Studio was open kept running the old build.)
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { noPluginsDirMessage, pluginDirs } from "./plugin-dirs.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const built = join(root, "build", "StudioMCP.rbxmx");

const targets = pluginDirs();
if (targets.length === 0) {
  throw new Error(noPluginsDirMessage());
}

execFileSync(process.execPath, [join(root, "scripts", "build-plugin.mjs")], { stdio: "inherit" });

/*
 * Copied beside the target and renamed over it, never written in place.
 *
 * Studio watches this directory and reloads the moment the file changes, so an
 * in-place copy hands it whatever is on disk at that instant -- which, for a
 * file of this size, is regularly half of one build and none of the next. The
 * plugin then fails to parse and Studio drops it silently: no toolbar button,
 * nothing in the plugin list, and no error saying why. It reads as the plugin
 * randomly not being installed, and re-running the install "fixes" it, which is
 * exactly what you would expect from a race.
 *
 * Rename within one directory is atomic, so Studio sees the old file or the new
 * one and never the seam between them.
 */
function install(target) {
  if (!existsSync(target)) mkdirSync(target, { recursive: true });
  const destination = join(target, "StudioMCP.rbxmx");
  // Named per process: two installs running at once (a manual one alongside
  // `doctor`, two terminals) would otherwise share one staging file and could
  // rename each other's half-written copy into place. Still not a name Studio
  // loads -- it ends in `.incoming`, not `.rbxmx`.
  const staged = join(target, `StudioMCP.rbxmx.${process.pid}.incoming`);
  try {
    copyFileSync(built, staged);
    renameSync(staged, destination);
  } catch (cause) {
    rmSync(staged, { force: true });
    throw cause;
  }
  // Read back rather than trusted: this is the step that used to fail silently.
  if (!readFileSync(destination).equals(readFileSync(built))) {
    throw new Error(`${destination} does not match the build that was just copied there.`);
  }
}

const failed = [];
for (const { dir, label } of targets) {
  try {
    install(dir);
    process.stderr.write(`Installed StudioMCP.rbxmx -> ${dir}  [${label}]\n`);
  } catch (cause) {
    failed.push(dir);
    process.stderr.write(`FAILED  ${dir}  [${label}]: ${cause instanceof Error ? cause.message : cause}\n`);
  }
}

if (failed.length === targets.length) {
  process.exitCode = 1;
} else {
  process.stderr.write(
    "Now quit Roblox Studio completely and start it again. Focusing the window does not reload plugins.\n",
  );
  if (failed.length > 0) process.exitCode = 1;
}
