import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IncomingMessage, RequestListener, Server, ServerResponse } from "node:http";
import { describe, it } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createChatGPTStore } from "../src/store/chatgpt.ts";
import { createChatGPTAuth, verifyChatGPTIdentity, CHATGPT_SCOPES } from "../src/server/chatgpt-auth.ts";
import { chatGPTRequestAllowed, createChatGPTHandler } from "../src/server/chatgpt.ts";

const CLIENT = "oaiapp_test_registration";
const TOKEN = "synthetic-access-not-a-real-credential";
const REFRESH = "synthetic-refresh-not-a-real-credential";

/** In-memory callback transport: npm test opens no OAuth/network connections. */
class CallbackServer extends EventEmitter {
	closed = false;
	port = 14000;
	constructor(readonly handler: RequestListener) { super(); }
	listen(_port: number, host: string, ready: () => void) {
		assert.equal(host, "127.0.0.1");
		queueMicrotask(ready);
		return this;
	}
	address() { return { port: this.port }; }
	close() { this.closed = true; return this; }
	closeIdleConnections() {}
	closeAllConnections() {}
	async callback(url: URL, method = "GET") {
		return new Promise<{ status: number; body: string; headers: Record<string, string> }>((resolve) => {
			let status = 0, headers = {};
			const response = {
				once() {},
				writeHead(code: number, next: Record<string, string>) { status = code; headers = next; },
				end(body: string) { resolve({ status, body, headers }); },
			};
			this.handler({ url: `${url.pathname}${url.search}`, method, headers: { host: url.host } } as IncomingMessage, response as unknown as ServerResponse);
		});
	}
}

function fixture(loginTimeoutMs?: number) {
	const dir = mkdtempSync(path.join(tmpdir(), "lh-chatgpt-test-"));
	const file = path.join(dir, "chatgpt-auth.json");
	const store = createChatGPTStore(file);
	const calls: { url: string; body?: URLSearchParams; authorization?: string | null }[] = [];
	const state = {
		subject: "subject-a", email: "learner@example.test", scopes: CHATGPT_SCOPES,
		refreshFailure: "", offline: false, badIdentity: false, now: Date.now(),
		revocationEndpoint: "https://auth.openai.com/revoke-test",
		verifyGate: undefined as Promise<void> | undefined,
	};
	let listener: CallbackServer;
	const auth = createChatGPTAuth({
		store,
		loginTimeoutMs,
		now: () => state.now,
		createCallbackServer: (handler) => {
			listener = new CallbackServer(handler);
			return listener as unknown as Server;
		},
		verifyIdentity: async (_token, clientId, nonce) => {
			assert.ok(clientId.startsWith("oaiapp_"));
			if (nonce !== undefined) assert.ok(nonce.length >= 40);
			if (state.verifyGate) await state.verifyGate;
			if (state.badIdentity) throw new Error("synthetic invalid signature");
			return { sub: state.subject, email: state.email };
		},
		fetch: async (input, init) => {
			const url = String(input);
			assert.equal(init?.redirect, "error");
			const body = init?.body instanceof URLSearchParams ? init.body : undefined;
			const authorization = new Headers(init?.headers).get("authorization");
			calls.push({ url, body, authorization });
			if (state.offline) throw new Error("synthetic network failure");
			if (url.endsWith("/oauth/token")) {
				assert.equal(body?.get("resource"), "https://api.openai.com/v1");
				if (body?.get("grant_type") === "refresh_token" && state.refreshFailure) {
					return Response.json({ error: state.refreshFailure }, { status: 400 });
				}
				return Response.json({
					access_token: TOKEN, refresh_token: `${REFRESH}-${calls.length}`, id_token: "synthetic-id-token",
					token_type: "Bearer", expires_in: 3600, scope: state.scopes,
				});
			}
			if (url === "https://api.openai.com/v1/models") {
				assert.equal(authorization, `Bearer ${TOKEN}`);
				return Response.json({ models: [
					{ slug: "gpt-6-luna", display_name: "Account model", visibility: "list" },
					{ slug: "hidden", display_name: "Hidden", visibility: "hide" },
				] });
			}
			if (url.endsWith("/.well-known/openid-configuration")) return Response.json({
				issuer: "https://auth.openai.com", revocation_endpoint: state.revocationEndpoint,
			});
			if (url.endsWith("/revoke-test")) return new Response(null, { status: 200 });
			throw new Error(`CLOSED unexpected endpoint: ${url}`);
		},
	});
	const callbackUrl = (authorization: string, clientId = CLIENT) => {
		const start = new URL(authorization);
		const url = new URL(start.searchParams.get("redirect_uri")!);
		url.searchParams.set("state", start.searchParams.get("state")!);
		url.searchParams.set("code", "synthetic-one-use-code");
		url.searchParams.set("client_id", clientId);
		return url;
	};
	const login = async (id?: string, issued = CLIENT) => {
		const result = await auth.start(id);
		const response = await listener!.callback(callbackUrl(result.authorizationUrl, issued));
		assert.equal(response.status, 200, auth.status().error ?? response.body);
		return result.authorizationUrl;
	};
	return { auth, store, file, state, calls, login, callbackUrl, listener: () => listener!, dispose() { auth.cancel(); rmSync(dir, { recursive: true, force: true }); } };
}

describe("ChatGPT OAuth protocol and account lifecycle", () => {
	it("uses PKCE, stable host identity, an ephemeral loopback callback, and no client secret", async () => {
		const f = fixture();
		try {
			const url = new URL(await f.login());
			assert.equal(url.origin, "https://auth.openai.com");
			assert.equal(url.searchParams.get("client_id"), "dynamic_agent_client");
			assert.equal(url.searchParams.get("agent_name_hint"), "LearnHarness");
			assert.match(url.searchParams.get("ext_agent_host_id")!, /^urn:uuid:/);
			assert.equal(new URL(url.searchParams.get("redirect_uri")!).hostname, "127.0.0.1");
			assert.equal(url.searchParams.get("scope"), CHATGPT_SCOPES);
			const exchange = f.calls.find((c) => c.body?.get("grant_type") === "authorization_code")!;
			assert.equal(exchange.body!.get("client_id"), CLIENT);
			assert.equal(exchange.body!.get("redirect_uri"), url.searchParams.get("redirect_uri"));
			assert.equal(createHash("sha256").update(exchange.body!.get("code_verifier")!).digest("base64url"), url.searchParams.get("code_challenge"));
			assert.equal(exchange.body!.has("client_secret"), false);
			assert.equal(f.listener().closed, true);
			assert.deepEqual(f.auth.availableModels(), [{ id: "gpt-6-luna", name: "Account model" }]);
			assert.ok(f.auth.connected());
			assert.ok(f.auth.status().welcome);
		} finally { f.dispose(); }
	});

	it("rejects state mismatches before errors or token exchange, without cancelling a legitimate attempt", async () => {
		const f = fixture();
		try {
			const { authorizationUrl } = await f.auth.start();
			const bad = f.callbackUrl(authorizationUrl);
			bad.searchParams.set("state", "wrong-state");
			bad.searchParams.set("error", "access_denied");
			assert.equal((await f.listener().callback(bad)).status, 400);
			assert.equal(f.calls.length, 0);
			assert.ok(f.auth.status().pending);
			assert.equal((await f.listener().callback(f.callbackUrl(authorizationUrl))).status, 200);
		} finally { f.dispose(); }
	});

	it("validates identity before persisting or replacing an active account", async () => {
		const f = fixture();
		try {
			await f.login();
			const before = readFileSync(f.file, "utf8");
			f.state.badIdentity = true;
			const { authorizationUrl } = await f.auth.start(CLIENT);
			assert.equal((await f.listener().callback(f.callbackUrl(authorizationUrl))).status, 400);
			assert.equal(readFileSync(f.file, "utf8"), before);
			assert.ok(f.auth.connected());
		} finally { f.dispose(); }
	});

	it("rejects missing or mismatched issued client IDs before exchanging a code", async () => {
		const f = fixture();
		try {
			let start = await f.auth.start();
			const missing = f.callbackUrl(start.authorizationUrl);
			missing.searchParams.delete("client_id");
			assert.equal((await f.listener().callback(missing)).status, 400);
			assert.equal(f.calls.length, 0);
			await f.login();
			const exchanges = f.calls.length;
			start = await f.auth.start(CLIENT);
			assert.equal((await f.listener().callback(f.callbackUrl(start.authorizationUrl, "oaiapp_wrong"))).status, 400);
			assert.equal(f.calls.length, exchanges);
			assert.equal(f.auth.status().activeId, CLIENT);
		} finally { f.dispose(); }
	});

	it("cancels pending sign-in and refuses late identity verification without replacing credentials", async () => {
		const f = fixture();
		try {
			let release!: () => void;
			f.state.verifyGate = new Promise<void>((resolve) => { release = resolve; });
			const { authorizationUrl } = await f.auth.start();
			const callback = f.listener().callback(f.callbackUrl(authorizationUrl));
			await new Promise<void>((resolve) => setImmediate(resolve));
			f.auth.cancel();
			release();
			assert.equal((await callback).status, 400);
			assert.equal(f.auth.status().pending, false);
			assert.deepEqual(f.store.read().accounts, []);
			assert.ok(f.listener().closed);
		} finally { f.dispose(); }
	});

	it("allows only one pending attempt and closes its listener on timeout", async () => {
		const f = fixture(20);
		try {
			await f.auth.start();
			await assert.rejects(f.auth.start(), /already waiting/);
			await new Promise((resolve) => setTimeout(resolve, 30));
			assert.equal(f.auth.status().pending, false);
			assert.match(f.auth.status().error!, /timed out/);
			assert.ok(f.listener().closed);
			assert.equal(f.calls.length, 0);
		} finally { f.dispose(); }
	});

	it("reuses client/host IDs on reauthorization and keeps same-email registrations separate", async () => {
		const f = fixture();
		try {
			await f.login();
			const host = f.store.read().hostId;
			const returning = new URL(await f.login(CLIENT));
			assert.equal(returning.searchParams.get("client_id"), CLIENT);
			assert.equal(returning.searchParams.get("ext_agent_host_id"), host);
			assert.equal(returning.searchParams.has("agent_name_hint"), false);
			assert.equal(returning.searchParams.get("id_token_hint"), "synthetic-id-token");
			f.state.subject = "subject-b";
			await f.login(undefined, "oaiapp_other_registration");
			assert.equal(f.store.read().accounts.length, 2);
			assert.notEqual(f.auth.status().accounts[0]!.label, f.auth.status().accounts[1]!.label);
			await f.auth.select(CLIENT);
			assert.equal(f.auth.status().activeId, CLIENT);
		} finally { f.dispose(); }
	});

	it("retains a verified identity but disables inference when direct plan consent is absent", async () => {
		const f = fixture();
		try {
			f.state.scopes = "openid profile email offline_access resource.invoke";
			await f.login();
			assert.equal(f.auth.connected(), false);
			assert.equal(f.auth.status().accounts[0]!.connected, true);
			assert.equal(f.auth.status().accounts[0]!.planEnabled, false);
			assert.deepEqual(f.auth.availableModels(), []);
			await assert.rejects(f.auth.authorize("gpt-6-luna"), /Connect ChatGPT/);
			const consent = new URL((await f.auth.start(CLIENT, true)).authorizationUrl);
			assert.equal(consent.searchParams.get("prompt"), "consent");
			assert.equal(consent.searchParams.get("client_id"), CLIENT);
			assert.ok(consent.searchParams.get("scope")!.includes("chatgpt.tokens.use.direct"));
		} finally { f.dispose(); }
	});

	it("serializes rotating refresh tokens and preserves them on transient failures", async () => {
		const f = fixture();
		try {
			await f.login();
			f.state.now += 3_600_000;
			const sessions = await Promise.all(Array.from({ length: 5 }, () => f.auth.authorize("gpt-6-luna")));
			sessions.forEach((session) => session.release());
			assert.equal(f.calls.filter((c) => c.body?.get("grant_type") === "refresh_token").length, 1);
			const before = f.store.read().accounts[0]!.tokens!;
			f.state.now += 3_600_000; f.state.offline = true;
			await assert.rejects(f.auth.authorize("gpt-6-luna"), /Could not reach OpenAI/);
			assert.deepEqual(f.store.read().accounts[0]!.tokens, before);
		} finally { f.dispose(); }
	});

	it("clears terminally invalid tokens but retains the client mapping for reconnect", async () => {
		const f = fixture();
		try {
			await f.login();
			f.state.now += 3_600_000;
			f.state.refreshFailure = "invalid_grant";
			await assert.rejects(f.auth.authorize("gpt-6-luna"), /expired or was revoked/);
			const account = f.store.read().accounts[0]!;
			assert.equal(account.id, CLIENT);
			assert.equal(account.tokens, undefined);
			assert.equal(f.auth.connected(), false);
		} finally { f.dispose(); }
	});

	it("signs out, revokes the renewable session, aborts requests, and preserves registration identity", async () => {
		const f = fixture();
		try {
			await f.login();
			const request = await f.auth.authorize("gpt-6-luna");
			await f.auth.signOut(CLIENT);
			assert.ok(request.signal.aborted);
			request.release();
			const revoke = f.calls.find((c) => c.url.endsWith("/revoke-test"))!;
			assert.equal(revoke.body!.get("token_type_hint"), "refresh_token");
			assert.equal(revoke.body!.get("client_id"), CLIENT);
			assert.equal(f.store.read().accounts[0]!.tokens, undefined);
			assert.equal(f.store.read().accounts[0]!.id, CLIENT);
			assert.equal(f.auth.status().activeId, null);
		} finally { f.dispose(); }
	});

	it("reports unconfirmed remote revocation while clearing local tokens", async () => {
		const f = fixture();
		try {
			await f.login(); f.state.offline = true;
			await f.auth.signOut(CLIENT);
			assert.equal(f.auth.connected(), false);
			assert.match(f.auth.status().notice!, /revocation was not confirmed/);
		} finally { f.dispose(); }
	});

	it("never forwards refresh tokens to an off-origin revocation endpoint", async () => {
		const f = fixture();
		try {
			await f.login();
			f.state.revocationEndpoint = "https://malicious.example/revoke";
			await f.auth.signOut(CLIENT);
			assert.equal(f.auth.connected(), false);
			assert.match(f.auth.status().notice!, /revocation was not confirmed/);
			assert.equal(f.calls.some((call) => call.url.startsWith("https://malicious.example")), false);
		} finally { f.dispose(); }
	});

	it("welcome is shown only until acknowledged and survives later sign-ins", async () => {
		const f = fixture();
		try {
			await f.login(); assert.ok(f.auth.status().welcome);
			await f.auth.acknowledgeWelcome();
			await f.auth.signOut(CLIENT);
			await f.login(CLIENT);
			assert.equal(f.auth.status().welcome, false);
		} finally { f.dispose(); }
	});

	it("status never exposes credentials, nonce, verifier, or authorization URLs", async () => {
		const f = fixture();
		try {
			await f.login();
			const serialized = JSON.stringify(f.auth.status());
			for (const secret of [TOKEN, REFRESH, "synthetic-id-token", "code_verifier", "authorizationUrl"]) assert.ok(!serialized.includes(secret));
		} finally { f.dispose(); }
	});
});

describe("protected ChatGPT credential storage", () => {
	it("reads without writes, serializes independent store instances, and writes owner-only credentials", async () => {
		const f = fixture();
		try {
			assert.deepEqual(f.store.read(), { version: 1, accounts: [] });
			assert.equal(existsSync(f.file), false);
			await Promise.all(Array.from({ length: 6 }, (_, i) =>
				createChatGPTStore(f.file).modify((record) => { record.accounts.push({ id: `client-${i}`, subject: `subject-${i}`, models: [] }); })));
			assert.equal(f.store.read().accounts.length, 6);
			if (process.platform !== "win32") assert.equal(statSync(f.file).mode & 0o777, 0o600);
		} finally { f.dispose(); }
	});
	it("refuses corrupt or newer credentials rather than silently overwriting them", async () => {
		const f = fixture();
		try {
			writeFileSync(f.file, '{"version":2,"accounts":[]}');
			await assert.rejects(f.store.modify((record) => { record.accounts = []; }), /credentials were not changed/);
			assert.equal(readFileSync(f.file, "utf8"), '{"version":2,"accounts":[]}');
		} finally { f.dispose(); }
	});
});

describe("ChatGPT local API boundary", () => {
	it("validates the actual loopback Host when Next canonicalizes its request URL", () => {
		const request = (host: string, origin: string) => new Request("http://localhost:3000/api/chatgpt", {
			method: "POST",
			headers: { host, origin, "sec-fetch-site": "same-origin" },
		});
		assert.ok(chatGPTRequestAllowed(request("127.0.0.1:3000", "http://127.0.0.1:3000")));
		assert.equal(chatGPTRequestAllowed(request("127.0.0.1:3000", "http://localhost:3000")), false);
		assert.equal(chatGPTRequestAllowed(request("127.0.0.1:3000", "http://127.0.0.1:4000")), false);
		assert.equal(chatGPTRequestAllowed(request("malicious.example", "http://malicious.example")), false);
		assert.equal(chatGPTRequestAllowed(request("malicious.example@127.0.0.1:3000", "http://127.0.0.1:3000")), false);
	});

	it("rejects remote and cross-origin mutations and returns only safe status", async () => {
		const f = fixture();
		try {
			const handle = createChatGPTHandler(f.auth);
			for (const [url, origin] of [
				["http://127.0.0.1:3000/api/chatgpt", "https://malicious.example"],
				["http://127.0.0.1:3000/api/chatgpt", null],
				["https://remote.example/api/chatgpt", "https://remote.example"],
			] as const) {
				const headers: Record<string, string> = { "Content-Type": "application/json" };
				if (origin) headers.origin = origin;
				const response = await handle(new Request(url, { method: "POST", headers, body: '{"action":"start"}' }));
				assert.equal(response.status, 403);
			}
			assert.equal(f.auth.status().pending, false);
			const response = await handle(new Request("http://127.0.0.1:3000/api/chatgpt"));
			assert.equal(response.headers.get("cache-control"), "no-store");
			assert.equal((await response.json()).activeId, null);
		} finally { f.dispose(); }
	});
});

describe("OIDC signature and claims verification", () => {
	it("requires a trusted signature, issuer, audience, expiry, and transaction nonce", async () => {
		const { privateKey, publicKey } = await generateKeyPair("RS256");
		const jwk = await exportJWK(publicKey);
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (url) => {
			assert.equal(String(url), "https://auth.openai.com/.well-known/jwks.json");
			return Response.json({ keys: [{ ...jwk, kid: "chatgpt-test-key", alg: "RS256", use: "sig" }] });
		};
		try {
			const sign = (overrides: Record<string, unknown> = {}) => new SignJWT({ nonce: "transaction-nonce", ...overrides })
				.setProtectedHeader({ alg: "RS256", kid: "chatgpt-test-key" })
				.setSubject("verified-user").setIssuer("https://auth.openai.com").setAudience(CLIENT)
				.setIssuedAt().setExpirationTime("1h").sign(privateKey);
			const valid = await sign();
			assert.equal((await verifyChatGPTIdentity(valid, CLIENT, "transaction-nonce")).sub, "verified-user");
			await assert.rejects(verifyChatGPTIdentity(valid, "oaiapp_wrong", "transaction-nonce"));
			await assert.rejects(verifyChatGPTIdentity(valid, CLIENT, "wrong-nonce"));
			await assert.rejects(verifyChatGPTIdentity(await sign({ azp: "wrong-authorized-party" }), CLIENT, "transaction-nonce"));
			const expired = await new SignJWT({ nonce: "transaction-nonce" }).setProtectedHeader({ alg: "RS256", kid: "chatgpt-test-key" })
				.setSubject("verified-user").setIssuer("https://auth.openai.com").setAudience(CLIENT).setIssuedAt(1).setExpirationTime(2).sign(privateKey);
			await assert.rejects(verifyChatGPTIdentity(expired, CLIENT, "transaction-nonce"));
			const pieces = valid.split(".");
			pieces[2] = `${pieces[2]!.startsWith("a") ? "b" : "a"}${pieces[2]!.slice(1)}`;
			await assert.rejects(verifyChatGPTIdentity(pieces.join("."), CLIENT, "transaction-nonce"));
		} finally { globalThis.fetch = originalFetch; }
	});
});
