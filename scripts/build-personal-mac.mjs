/**
 * Build a personal ARM64 DMG without touching Applications or Apple credentials.
 * Package the .app first, ad-hoc sign it locally, then wrap that exact bundle
 * in a DMG. An ad-hoc signature uses no certificate or timestamp service.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "darwin" || process.arch !== "arm64") {
	throw new Error("Build this personal ARM64 app on an Apple Silicon Mac.");
}
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const app = path.join(root, "dist", "personal", "mac-arm64", "LearnHarness.app");
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
	!/^(APPLE_|CSC_|WIN_CSC_|GH_TOKEN$|GITHUB_TOKEN$|GITLAB_TOKEN$|KEYGEN_TOKEN$|BITBUCKET_TOKEN$)/.test(key)));
env.CSC_IDENTITY_AUTO_DISCOVERY = "false";

function run(command, args) {
	const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal})`);
}
const node = (script, ...args) => run(process.execPath, [path.join(root, script), ...args]);
const builder = (...args) => run("npx", [
	"--no-install", "electron-builder", "--config", "electron-builder.personal.yml",
	"--publish", "never", "--arm64", ...args,
]);

// Clean only this build's generated paths, never user records or other outputs.
fs.rmSync(path.join(root, ".next", "standalone"), { recursive: true, force: true });
fs.rmSync(path.join(root, "dist", "personal"), { recursive: true, force: true });
run("npm", ["run", "build"]);
node("scripts/build-server.mjs");
node("scripts/smoke-server.mjs", "--electron");
builder("--mac", "--dir");
run("/usr/bin/codesign", [
	"--force", "--deep", "--sign", "-", "--timestamp=none",
	"--entitlements", path.join(root, "build", "entitlements.mac.plist"), app,
]);
run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
builder("--mac", "dmg", "--prepackaged", app);
console.log(`Personal DMG: ${path.join(root, "dist", "personal", `LearnHarness-${pkg.version}-personal-arm64.dmg`)}`);
