import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import config from "../next.config.ts";

describe("ChatGPT packaging safeguards", () => {
	it("excludes OAuth credentials and transient files from the standalone trace", () => {
		const excludes = config.outputFileTracingExcludes?.["*"] ?? [];
		assert.ok(excludes.includes("chatgpt-auth.json"));
		assert.ok(excludes.includes("chatgpt-auth.json.*"));
	});
	for (const name of ["chatgpt-auth.json", "chatgpt-auth.json.tmp-fixture", "chatgpt-auth.json.lock"]) {
		it(`refuses a payload containing ${name}`, () => {
			const dir = mkdtempSync(path.join(tmpdir(), "lh-chatgpt-payload-"));
			try {
				mkdirSync(path.join(dir, "scripts"), { recursive: true });
				mkdirSync(path.join(dir, ".next", "standalone"), { recursive: true });
				mkdirSync(path.join(dir, ".next", "static"), { recursive: true });
				copyFileSync(path.join(import.meta.dirname, "../scripts/build-server.mjs"), path.join(dir, "scripts/build-server.mjs"));
				writeFileSync(path.join(dir, ".next", "standalone", "server.js"), "");
				writeFileSync(path.join(dir, ".next", "standalone", name), "synthetic-credential-must-not-be-printed");
				const result = spawnSync(process.execPath, [path.join(dir, "scripts/build-server.mjs")], { encoding: "utf8", timeout: 5000 });
				assert.equal(result.status, 1);
				assert.match(result.stderr, /REFUSING/);
				assert.ok(result.stderr.includes(name));
				assert.ok(!result.stderr.includes("synthetic-credential-must-not-be-printed"));
			} finally { rmSync(dir, { recursive: true, force: true }); }
		});
	}
});
