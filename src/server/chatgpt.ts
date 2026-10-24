import type { Model } from "@earendil-works/pi-ai";
import { piModels } from "../agent/models.ts";
import { createChatGPTPlanProvider } from "../agent/chatgpt-plan.ts";
import { CHATGPT_PROVIDER } from "../core/chatgpt.ts";
import { emit } from "../core/events.ts";
import { chatGPTStore } from "../store/chatgpt.ts";
import { ChatGPTAuthError, createChatGPTAuth, type ChatGPTAuth } from "./chatgpt-auth.ts";

// One callback listener/request registry across Next route entries and HMR.
const key = Symbol.for("lh.chatgptAuth");
const global = globalThis as typeof globalThis & { [key]?: ChatGPTAuth };
export const chatGPTAuth = global[key] ??= createChatGPTAuth({
	store: chatGPTStore,
	changed: () => emit("chatgpt-changed", {}),
	modelSupported: (id) => piModels().getModel("openai", id)?.api === "openai-responses",
});

/** Account catalog grants availability; pi-ai supplies known capabilities.
 * Unknown model capabilities are never guessed. They need an engine upgrade. */
export function chatGPTModels(): Model<"openai-responses">[] {
	return chatGPTAuth.availableModels().flatMap((entry) => {
		const model = piModels().getModel("openai", entry.id);
		if (!model || model.api !== "openai-responses") return [];
		return [{
			...model, api: "openai-responses" as const,
			id: entry.id, name: entry.name, provider: CHATGPT_PROVIDER,
			// Subscription/credit charges are managed by ChatGPT, not API rates.
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		}];
	});
}

piModels().setProvider(createChatGPTPlanProvider({
	connected: () => chatGPTAuth.connected(),
	models: chatGPTModels,
	authorize: (modelId, signal) => chatGPTAuth.authorize(modelId, signal),
}));

/** Only local, same-origin pages may initiate or mutate OAuth. A website
 * cannot POST into an unauthenticated loopback app to switch its account. */
export function chatGPTRequestAllowed(req: Request): boolean {
	try {
		const url = new URL(req.url);
		// Next may canonicalize req.url to localhost even when the browser
		// opened 127.0.0.1. Validate the wire Host separately; never trust
		// forwarded-host headers or accept a non-loopback origin.
		const host = req.headers.get("host") ?? url.host;
		const wire = new URL(`${url.protocol}//${host}`);
		return ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
			["127.0.0.1", "localhost", "[::1]"].includes(wire.hostname) &&
			wire.host === host.toLowerCase() &&
			req.headers.get("origin") === wire.origin &&
			!["cross-site", "none"].includes(req.headers.get("sec-fetch-site") ?? "");
	} catch { return false; }
}

export function createChatGPTHandler(auth: ChatGPTAuth) {
	return async function handle(req: Request): Promise<Response> {
		const headers = { "Cache-Control": "no-store" };
		try {
			if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(req.url).hostname)) {
				return Response.json({ error: "ChatGPT sign-in is available only in the local app." }, { status: 403, headers });
			}
			if (req.method === "GET") return Response.json(auth.status(), { headers });
			if (req.method !== "POST") return Response.json({ error: "Method not allowed." }, { status: 405, headers });
			if (!chatGPTRequestAllowed(req)) return Response.json({ error: "A same-origin local request is required." }, { status: 403, headers });
			const body = await req.json().catch(() => null) as { action?: unknown; accountId?: unknown; consent?: unknown } | null;
			if (!body || typeof body !== "object" || typeof body.action !== "string") throw new ChatGPTAuthError("Invalid ChatGPT action.");
			if (body.accountId !== undefined && typeof body.accountId !== "string") throw new ChatGPTAuthError("Invalid ChatGPT account.");
			const id = typeof body.accountId === "string" ? body.accountId : undefined;
			if (body.action === "start") {
				if (body.consent !== undefined && typeof body.consent !== "boolean") throw new ChatGPTAuthError("Invalid consent choice.");
				return Response.json(await auth.start(id, body.consent === true), { headers });
			}
			if (body.action === "cancel") auth.cancel();
			else if (body.action === "welcome") await auth.acknowledgeWelcome();
			else if (body.action === "refresh") await auth.refreshModels(true);
			else if (body.action === "select" && id) await auth.select(id);
			else if (body.action === "signout" && id) await auth.signOut(id);
			else throw new ChatGPTAuthError("Unknown ChatGPT action.");
			return Response.json(auth.status(), { headers });
		} catch (failure) {
			return Response.json({
				error: failure instanceof ChatGPTAuthError ? failure.message : "The ChatGPT connection could not be updated. Saved credentials were not exposed.",
			}, { status: failure instanceof ChatGPTAuthError ? failure.status : 500, headers });
		}
	};
}

export const handleChatGPTRequest = createChatGPTHandler(chatGPTAuth);
