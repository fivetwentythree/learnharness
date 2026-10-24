import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import nextConfig from "../next.config.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(new URL("../electron/main.cjs", import.meta.url));

describe("personal Apple Silicon build", () => {
	it("keeps bundling and standalone tracing inside this checkout", () => {
		assert.equal(nextConfig.turbopack?.root, path.resolve(root));
		assert.equal(nextConfig.outputFileTracingRoot, path.resolve(root));
	});

	it("inherits packaging assets but disables signing, notarization, publishing, and update feeds", async () => {
		const { getConfig, validateConfiguration } = require("app-builder-lib/out/util/config/config.js");
		const config = await getConfig(root, path.join(root, "electron-builder.personal.yml"));
		await validateConfiguration(config, { isEnabled: false });
		assert.equal(config.publish, null);
		assert.equal(config.mac.identity, null);
		assert.equal(config.mac.notarize, false);
		assert.equal(config.mac.hardenedRuntime, false);
		assert.equal(config.dmg.sign, false);
		assert.equal(config.extraMetadata.lhPersonalBuild, true);
		assert.equal(config.appId, "com.learnharness.LearnHarness");
		assert.equal(config.productName, "LearnHarness");
		assert.deepEqual(config.mac.target, [{ target: "dmg", arch: ["arm64"] }, { target: "zip", arch: ["arm64"] }]);
		const script = readFileSync(path.join(root, "scripts/build-personal-mac.mjs"), "utf8");
		assert.ok(script.includes('builder("--mac", "--dir")'));
		assert.ok(script.includes('builder("--mac", "dmg", "--prepackaged", app)'));
		assert.equal(config.mac.icon, "build/icon.icon");
		assert.equal(config.directories.output, "dist/personal");
	});

	it("never loads the updater for a personal build, even with a feed override", () => {
		const file = path.join(root, "electron/main.cjs");
		const logs: string[] = [];
		let updaterLoaded = false;
		const context = {
			require: (id: string) => {
				if (id === "electron") return { app: { isPackaged: true, setName() {}, requestSingleInstanceLock: () => false, quit() {} } };
				if (id === "../package.json") return { lhPersonalBuild: true };
				if (id === "electron-updater") { updaterLoaded = true; throw new Error("must not load updater"); }
				return require(id);
			},
			process: { platform: "darwin", argv: [], env: { LH_UPDATE_FEED: "https://upstream.example" }, on() {} },
			__dirname: path.dirname(file),
			logs,
		};
		runInNewContext(`${readFileSync(file, "utf8")}\nlog = (text) => logs.push(text); setupAutoUpdater();`, context, { filename: file });
		assert.equal(updaterLoaded, false);
		assert.deepEqual(logs, ["auto-update: personal build — updater disabled"]);
	});
});
