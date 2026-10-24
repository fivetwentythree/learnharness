import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type RequestListener, type Server, type ServerResponse } from "node:http";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { ChatGPTAccount, ChatGPTRecord, ChatGPTStatus, ChatGPTStore, ChatGPTTokens } from "../core/chatgpt.ts";

export const OPENAI_ISSUER = "https://auth.openai.com";
export const CHATGPT_RESOURCE = "https://api.openai.com/v1";
export const CHATGPT_SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const DIRECT_SCOPE = "chatgpt.tokens.use.direct";
const TOKEN_ENDPOINT = `${OPENAI_ISSUER}/api/accounts/oauth/token`;
const DYNAMIC_CLIENT = "dynamic_agent_client";
const TERMINAL_REFRESH_ERRORS = new Set([
	"invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired",
	"refresh_token_invalidated", "refresh_token_reused",
]);
const jwks = createRemoteJWKSet(new URL(`${OPENAI_ISSUER}/.well-known/jwks.json`));

export class ChatGPTAuthError extends Error {
	constructor(message: string, readonly status = 400, readonly code?: string) { super(message); }
}

export function sameSecret(a: string, b: string): boolean {
	const aa = Buffer.from(a), bb = Buffer.from(b);
	return aa.length === bb.length && timingSafeEqual(aa, bb);
}

/** OIDC identity must be verified, not merely decoded from a JWT. */
export async function verifyChatGPTIdentity(token: string, clientId: string, nonce?: string): Promise<JWTPayload> {
	const { payload } = await jwtVerify(token, jwks, {
		issuer: OPENAI_ISSUER,
		audience: clientId,
		algorithms: ["RS256", "ES256"],
		requiredClaims: ["sub", "exp", "iat", ...(nonce === undefined ? [] : ["nonce"])],
	});
	if ((nonce !== undefined && (typeof payload.nonce !== "string" || !sameSecret(payload.nonce, nonce))) ||
		(payload.azp !== undefined && payload.azp !== clientId)) {
		throw new ChatGPTAuthError("ChatGPT sign-in could not be verified. Please try again.");
	}
	return payload;
}

interface Attempt {
	server: Server;
	controller: AbortController;
	timer: ReturnType<typeof setTimeout>;
	state: string;
	nonce: string;
	verifier: string;
	redirectUri: string;
	account?: ChatGPTAccount;
	claimed: boolean;
}

export interface ChatGPTAuthOptions {
	store: ChatGPTStore;
	fetch?: typeof fetch;
	verifyIdentity?: typeof verifyChatGPTIdentity;
	changed?: () => void;
	now?: () => number;
	loginTimeoutMs?: number;
	modelSupported?: (id: string) => boolean;
	/** Tests exercise callbacks without opening sockets or external services. */
	createCallbackServer?: (handler: RequestListener) => Server;
}

function activeAccount(record: ChatGPTRecord) {
	return record.accounts.find((a) => a.id === record.activeId);
}
export function accountCanUsePlan(account: ChatGPTAccount | undefined): boolean {
	return !!account?.tokens?.scopes.includes(DIRECT_SCOPE);
}

/** A local host owns OAuth; tokens never enter process.env or browser storage.
 * All mutations, including rotating refresh tokens, use the store's lock.
 * The callback listener is loopback-only and exists only during an attempt. */
export function createChatGPTAuth(options: ChatGPTAuthOptions) {
	const store = options.store;
	const fetchFn = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
	const verify = options.verifyIdentity ?? verifyChatGPTIdentity;
	const now = options.now ?? Date.now;
	const changed = options.changed ?? (() => {});
	let pending: Attempt | undefined;
	let starting = false;
	let epoch = 0;
	let error: string | null = null;
	let notice: string | null = null;
	let catalogFresh: { accountId: string; at: number } | undefined;
	let catalogLoad: Promise<void> | undefined;
	const requests = new Map<AbortController, string>();
	const signingOut = new Set<string>();
	let switching = false;

	function status(): ChatGPTStatus {
		const record = store.read();
		return {
			accounts: record.accounts.map((a, i) => ({
				id: a.id,
				label: `${a.email ?? "ChatGPT account"} · ${i + 1}`,
				...(a.email ? { email: a.email } : {}),
				connected: !!a.tokens,
				planEnabled: accountCanUsePlan(a),
			})),
			activeId: record.activeId ?? null,
			pending: starting || !!pending,
			error,
			notice,
			welcome: accountCanUsePlan(activeAccount(record)) && !record.welcomed,
		};
	}
	function connected() { return accountCanUsePlan(activeAccount(store.read())); }
	function availableModels() {
		const account = activeAccount(store.read());
		return accountCanUsePlan(account) ? account!.models : [];
	}
	function stopRequests(id?: string) {
		for (const [controller, accountId] of requests) {
			if (id === undefined || id === accountId) controller.abort();
		}
	}
	function closeAttempt(attempt: Attempt) {
		clearTimeout(attempt.timer);
		attempt.controller.abort();
		attempt.server.close();
		// A spare browser keep-alive connection must not retain an old callback.
		attempt.server.closeIdleConnections();
	}
	function cancel() {
		epoch++;
		if (pending) {
			closeAttempt(pending);
			pending.server.closeAllConnections();
		}
		pending = undefined;
		changed();
	}
	function html(res: ServerResponse, code: number, message: string) {
		if (res.destroyed || res.writableEnded) return;
		res.writeHead(code, {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-store",
			"Referrer-Policy": "no-referrer",
			"Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
		});
		res.end(`<!doctype html><html><head><title>ChatGPT connection</title></head><body><p>${message}</p><p>You can close this tab and return to the app.</p></body></html>`);
	}
	async function requestJson(url: string, init: RequestInit, signal?: AbortSignal): Promise<Record<string, unknown>> {
		let response: Response;
		try {
			response = await fetchFn(url, {
				...init,
				redirect: "error",
				signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]),
			});
		} catch {
			throw new ChatGPTAuthError("Could not reach OpenAI. Your saved connection was kept; try again.", 503);
		}
		const body = await response.json().catch(() => null) as Record<string, unknown> | null;
		if (!response.ok) {
			const nested = body?.error;
			const rawCode = typeof nested === "string" ? nested : nested && typeof nested === "object" ? (nested as Record<string, unknown>).code : undefined;
			const code = typeof rawCode === "string" && /^[\w.-]{1,120}$/.test(rawCode) ? rawCode : undefined;
			const requestId = response.headers.get("x-request-id");
			// Never reflect token endpoint bodies, authorization codes, or tokens.
			throw new ChatGPTAuthError(`OpenAI refused the request (${response.status}${code ? `, ${code}` : ""}).${requestId && /^[\w-]{1,150}$/.test(requestId) ? ` Request ID: ${requestId}.` : ""}`, response.status, code);
		}
		if (!body || typeof body !== "object" || Array.isArray(body)) throw new ChatGPTAuthError("OpenAI returned an invalid response.", 502);
		return body;
	}
	async function tokenRequest(fields: Record<string, string>, signal?: AbortSignal) {
		return requestJson(TOKEN_ENDPOINT, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
			body: new URLSearchParams({ ...fields, resource: CHATGPT_RESOURCE }),
		}, signal);
	}
	function tokensFrom(body: Record<string, unknown>, previous?: ChatGPTTokens): ChatGPTTokens {
		const text = (key: string) => {
			const value = body[key];
			if (typeof value !== "string" || !value.trim()) throw new ChatGPTAuthError("OpenAI returned incomplete credentials.", 502);
			return value;
		};
		if (typeof body.token_type !== "string" || body.token_type.toLowerCase() !== "bearer" ||
			typeof body.expires_in !== "number" || !Number.isFinite(body.expires_in) || body.expires_in <= 0) {
			throw new ChatGPTAuthError("OpenAI returned invalid token metadata.", 502);
		}
		const scope = typeof body.scope === "string" ? body.scope : previous?.scopes.join(" ");
		if (scope === undefined) throw new ChatGPTAuthError("OpenAI did not confirm the granted permissions.", 502);
		return {
			access: text("access_token"), refresh: text("refresh_token"),
			idToken: typeof body.id_token === "string" && body.id_token ? body.id_token : previous?.idToken ?? text("id_token"),
			expiresAt: now() + body.expires_in * 1000,
			scopes: scope.split(/\s+/).filter(Boolean),
		};
	}
	async function accessToken(id: string, signal?: AbortSignal): Promise<string> {
		const result = await store.modify(async (record) => {
			signal?.throwIfAborted();
			const account = record.accounts.find((a) => a.id === id);
			if (!accountCanUsePlan(account)) throw new ChatGPTAuthError("Connect a ChatGPT account and enable plan usage in Settings → Keys.", 401);
			const old = account!.tokens!;
			if (old.expiresAt > now() + 60_000) return { token: old.access };
			try {
				const response = await tokenRequest({ grant_type: "refresh_token", client_id: id, refresh_token: old.refresh }, signal);
				const replacement = tokensFrom(response, old);
				if (response.id_token) {
					const identity = await verify(replacement.idToken, id);
					if (identity.sub !== account!.subject) throw new ChatGPTAuthError("ChatGPT account identity changed. Sign in again.", 401);
				}
				signal?.throwIfAborted();
				account!.tokens = replacement;
				if (!accountCanUsePlan(account)) {
					account!.models = [];
					return { error: "ChatGPT plan permission is disabled. Enable it in Settings → Keys." };
				}
				return { token: replacement.access };
			} catch (failure) {
				if (failure instanceof ChatGPTAuthError && failure.code && TERMINAL_REFRESH_ERRORS.has(failure.code)) {
					delete account!.tokens;
					account!.models = [];
					return { error: "Your ChatGPT session has expired or was revoked. Sign in again in Settings → Keys." };
				}
				throw failure;
			}
		});
		if (result.error) { changed(); throw new ChatGPTAuthError(result.error, 401); }
		return result.token!;
	}
	async function authorize(modelId: string | undefined, parentSignal?: AbortSignal) {
		const record = store.read();
		const account = activeAccount(record);
		if (switching || (account && signingOut.has(account.id))) throw new ChatGPTAuthError("The ChatGPT account connection is changing. Try again.", 409);
		if (!accountCanUsePlan(account)) throw new ChatGPTAuthError("Connect ChatGPT in Settings → Keys to use your plan.", 401);
		if (modelId && !account!.models.some((m) => m.id === modelId)) {
			throw new ChatGPTAuthError("This model is not available to the active ChatGPT account. Pick a model again.", 403);
		}
		const controller = new AbortController();
		requests.set(controller, account!.id);
		const signal = AbortSignal.any([controller.signal, ...(parentSignal ? [parentSignal] : [])]);
		const release = () => requests.delete(controller);
		try {
			const token = await accessToken(account!.id, signal);
			signal.throwIfAborted();
			if (store.read().activeId !== account!.id) throw new ChatGPTAuthError("The active ChatGPT account changed. Try again.", 409);
			return { token, signal, release };
		} catch (failure) { release(); throw failure; }
	}
	async function refreshModels(force = false): Promise<void> {
		const id = store.read().activeId;
		if (!connected() || (!force && catalogFresh && catalogFresh.accountId === id && now() - catalogFresh.at < 120_000)) return;
		if (catalogLoad) {
			await catalogLoad;
			if (catalogFresh?.accountId !== store.read().activeId) return refreshModels(force);
			return;
		}
		catalogLoad = (async () => {
			const auth = await authorize(undefined);
			try {
				const body = await requestJson(`${CHATGPT_RESOURCE}/models`, { headers: { Authorization: `Bearer ${auth.token}` } }, auth.signal);
				if (!Array.isArray(body.models)) throw new ChatGPTAuthError("OpenAI did not return a ChatGPT model catalog.", 502);
				const models: ChatGPTAccount["models"] = [];
				for (const raw of body.models) {
					if (!raw || typeof raw !== "object" || raw.visibility !== "list") continue;
					if (typeof raw.slug !== "string" || !raw.slug || typeof raw.display_name !== "string") {
						throw new ChatGPTAuthError("OpenAI returned an invalid model catalog.", 502);
					}
					if (!models.some((m) => m.id === raw.slug)) models.push({ id: raw.slug, name: raw.display_name });
				}
				await store.modify((record) => {
					auth.signal.throwIfAborted();
					if (record.activeId !== id) return;
					const account = activeAccount(record);
					if (accountCanUsePlan(account)) account!.models = models;
				});
				catalogFresh = { accountId: id!, at: now() };
				notice = models.length === 0 ? "No models are currently available to this ChatGPT account." :
					models.some((model) => options.modelSupported && !options.modelSupported(model.id))
						? "Some account models need a newer model engine. The picker shows only models this app supports."
						: null;
				changed();
			} finally { auth.release(); }
		})().finally(() => { catalogLoad = undefined; });
		return catalogLoad;
	}
	async function finish(attempt: Attempt, code: string, clientId: string) {
		const response = await tokenRequest({
			grant_type: "authorization_code", client_id: clientId, code,
			code_verifier: attempt.verifier, redirect_uri: attempt.redirectUri,
		}, attempt.controller.signal);
		const tokens = tokensFrom(response);
		const identity = await verify(tokens.idToken, clientId, attempt.nonce);
		if (!identity.sub || (attempt.account && identity.sub !== attempt.account.subject)) throw new ChatGPTAuthError("ChatGPT returned a different account. Your saved connection was not replaced.", 401);
		await store.modify((record) => {
			if (pending !== attempt || attempt.controller.signal.aborted) throw new ChatGPTAuthError("Sign-in was cancelled.", 409);
			const previous = record.accounts.find((a) => a.id === clientId);
			if (previous && previous.subject !== identity.sub) throw new ChatGPTAuthError("ChatGPT account identity does not match this registration.", 401);
			const account: ChatGPTAccount = {
				id: clientId, subject: identity.sub!,
				...(typeof identity.email === "string" ? { email: identity.email } : {}),
				tokens, models: [],
			};
			if (previous) record.accounts[record.accounts.indexOf(previous)] = account;
			else record.accounts.push(account);
			record.activeId = clientId;
		});
		stopRequests();
		catalogFresh = undefined;
		error = null;
		pending = undefined;
		closeAttempt(attempt);
		changed();
		if (tokens.scopes.includes(DIRECT_SCOPE)) {
			try { await refreshModels(true); }
			catch { notice = "Connected, but the model list could not be loaded. Refresh models in Settings → Keys."; changed(); }
		} else {
			notice = "Signed in, but ChatGPT plan usage was not enabled. Enable it before choosing a ChatGPT model.";
			changed();
		}
	}
	async function start(accountId?: string, consent = false) {
		if (pending || starting) throw new ChatGPTAuthError("A ChatGPT sign-in is already waiting in your browser.", 409);
		starting = true;
		const generation = ++epoch;
		error = null; notice = null;
		try {
			const record = await store.modify((record) => {
				record.hostId ??= `urn:uuid:${randomUUID()}`;
				return structuredClone(record);
			});
			const account = accountId ? record.accounts.find((a) => a.id === accountId) : undefined;
			if (accountId && !account) throw new ChatGPTAuthError("Unknown ChatGPT account.", 404);
			const verifier = randomBytes(32).toString("base64url");
			const state = randomBytes(32).toString("base64url");
			const nonce = randomBytes(32).toString("base64url");
			const server = (options.createCallbackServer ?? createServer)((req, res) => {
				void (async () => {
					const attempt = pending;
					if (!attempt || attempt.server !== server) { html(res, 410, "This sign-in attempt is no longer active."); return; }
					res.once("finish", () => {
						if (pending !== attempt) server.closeAllConnections();
					});
					const url = new URL(req.url ?? "/", attempt.redirectUri);
					if (req.method !== "GET" || url.pathname !== "/auth/callback" || req.headers.host !== new URL(attempt.redirectUri).host) {
						html(res, 404, "Callback not found."); return;
					}
					const returnedState = url.searchParams.getAll("state");
					if (returnedState.length !== 1 || !sameSecret(returnedState[0]!, state)) { html(res, 400, "Invalid sign-in state."); return; }
					if (attempt.claimed) { html(res, 409, "This callback was already used."); return; }
					attempt.claimed = true;
					try {
						if (url.searchParams.has("error")) throw new ChatGPTAuthError("ChatGPT sign-in was declined or cancelled.");
						const ids = url.searchParams.getAll("client_id");
						const clientId = ids[0] ?? account?.id;
						const codes = url.searchParams.getAll("code");
						if (ids.length > 1 || !clientId || clientId === DYNAMIC_CLIENT || (account && account.id !== clientId) ||
							codes.length !== 1 || !codes[0]) throw new ChatGPTAuthError("ChatGPT returned an incomplete or mismatched registration.");
						await finish(attempt, codes[0], clientId);
						html(res, 200, "ChatGPT sign-in completed.");
					} catch (failure) {
						if (pending === attempt) {
							error = failure instanceof ChatGPTAuthError ? failure.message : "ChatGPT sign-in could not be verified. Please try again.";
							pending = undefined; closeAttempt(attempt); changed();
						}
						html(res, 400, "ChatGPT could not be connected. Return to the app for details.");
					}
				})().catch(() => { html(res, 500, "ChatGPT sign-in could not be completed."); });
			});
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
			});
			if (epoch !== generation) { server.close(); throw new ChatGPTAuthError("Sign-in was cancelled.", 409); }
			const port = (server.address() as { port: number }).port;
			const redirectUri = `http://127.0.0.1:${port}/auth/callback`;
			const controller = new AbortController();
			const attempt: Attempt = {
				server, controller, state, nonce, verifier, redirectUri, account, claimed: false,
				timer: setTimeout(() => {
					if (pending !== attempt) return;
					error = "ChatGPT sign-in timed out. Try again.";
					cancel();
				}, options.loginTimeoutMs ?? 10 * 60_000),
			};
			attempt.timer.unref();
			pending = attempt;
			server.on("error", () => { if (pending === attempt) { error = "The ChatGPT callback listener stopped. Try again."; cancel(); } });
			const url = new URL(`${OPENAI_ISSUER}/api/accounts/authorize`);
			url.search = new URLSearchParams({
				client_id: account?.id ?? DYNAMIC_CLIENT,
				...(account ? {} : { agent_name_hint: "LearnHarness" }),
				ext_agent_host_id: record.hostId!,
				response_type: "code", redirect_uri: redirectUri, resource: CHATGPT_RESOURCE,
				scope: CHATGPT_SCOPES, state, nonce, code_challenge_method: "S256",
				code_challenge: createHash("sha256").update(verifier).digest("base64url"),
				...(account?.tokens?.idToken ? { id_token_hint: account.tokens.idToken } : {}),
				...(account?.email ? { login_hint: account.email } : {}),
				...(consent ? { prompt: "consent" } : {}),
			}).toString();
			return { authorizationUrl: url.toString() };
		} finally { starting = false; changed(); }
	}
	async function select(accountId: string) {
		cancel(); switching = true; stopRequests();
		try {
			await store.modify((record) => {
				const account = record.accounts.find((a) => a.id === accountId);
				if (!account?.tokens) throw new ChatGPTAuthError("Sign in to this saved ChatGPT account first.", 401);
				record.activeId = accountId;
			});
		} finally { switching = false; }
		error = null; notice = null; catalogFresh = undefined; changed();
		try { await refreshModels(true); }
		catch { notice = "The ChatGPT model list could not be refreshed. Try again."; changed(); }
	}
	async function signOut(accountId: string) {
		cancel(); signingOut.add(accountId); stopRequests(accountId);
		notice = null; error = null;
		try {
			await store.modify(async (record) => {
				const account = record.accounts.find((a) => a.id === accountId);
				if (!account) throw new ChatGPTAuthError("Unknown ChatGPT account.", 404);
				if (account.tokens && !await revokeSession(account)) {
					notice = "Signed out locally. Remote revocation was not confirmed; disconnect the app in ChatGPT settings.";
				}
				delete account.tokens;
				account.models = [];
				if (record.activeId === accountId) delete record.activeId;
			});
		} finally {
			signingOut.delete(accountId);
			stopRequests(accountId);
		}
		catalogFresh = undefined;
		changed();
	}
	async function revokeSession(account: ChatGPTAccount): Promise<boolean> {
		// Retry transient failures while the renewable credential is still
		// available. Local sign-out still completes if revocation stays offline.
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const discovery = await requestJson(`${OPENAI_ISSUER}/.well-known/openid-configuration`, {});
				const endpoint = typeof discovery.revocation_endpoint === "string" ? new URL(discovery.revocation_endpoint) : undefined;
				if (discovery.issuer !== OPENAI_ISSUER || endpoint?.origin !== OPENAI_ISSUER) return false;
				const response = await fetchFn(endpoint.href, {
					method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
					headers: { "Content-Type": "application/x-www-form-urlencoded" },
					body: new URLSearchParams({ token: account.tokens!.refresh, token_type_hint: "refresh_token", client_id: account.id }),
				});
				if (response.status === 200) return true;
				if (response.status < 500) return false;
			} catch (failure) {
				if (failure instanceof ChatGPTAuthError && failure.status < 500) return false;
			}
			if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 150));
		}
		return false;
	}
	async function acknowledgeWelcome() {
		await store.modify((record) => { record.welcomed = true; });
		changed();
	}
	return { status, connected, availableModels, start, cancel, select, signOut, authorize, refreshModels, acknowledgeWelcome };
}

export type ChatGPTAuth = ReturnType<typeof createChatGPTAuth>;
