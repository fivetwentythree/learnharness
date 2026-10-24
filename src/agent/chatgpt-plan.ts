import type { Model, Provider, SimpleStreamOptions, StreamOptions, TranscriptContext, AssistantMessage } from "@earendil-works/pi-ai";
import { stream as responses, streamSimple as responsesSimple } from "@earendil-works/pi-ai/api/openai-responses";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { CHATGPT_PROVIDER, CHATGPT_USAGE_URL } from "../core/chatgpt.ts";

export interface ChatGPTPlanAccess {
	connected(): boolean;
	models(): readonly Model<"openai-responses">[];
	authorize(modelId: string, signal?: AbortSignal): Promise<{
		token: string;
		signal: AbortSignal;
		release(): unknown;
	}>;
}

const UNSUPPORTED = [
	"background", "conversation", "max_output_tokens", "max_tool_calls", "metadata", "moderation",
	"multi_agent", "prompt", "prompt_cache_retention", "prompt_cache_options", "safety_identifier",
	"temperature", "top_logprobs", "top_p", "truncation", "user", "previous_response_id",
];
const TOOL_NAMESPACE = "learnharness";

/** Public Responses endpoint rules for ChatGPT plan usage, not Codex backend
 * endpoints. Run after caller payload hooks so constraints cannot be undone. */
export function chatGPTPlanPayload(payload: unknown): Record<string, unknown> {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid ChatGPT request.");
	const body = { ...payload } as Record<string, unknown>;
	for (const key of UNSUPPORTED) delete body[key];
	body.store = false;
	body.stream = true;
	if (!Array.isArray(body.input)) throw new Error("ChatGPT plan requests require explicit conversation history.");
	body.input = body.input.map((raw) => {
		const item = { ...raw } as Record<string, unknown>;
		if (item.role === "system") item.role = "developer";
		if (item.type === "function_call" || item.type === "custom_tool_call") item.namespace = TOOL_NAMESPACE;
		return item;
	});
	if (Array.isArray(body.tools) && body.tools.length) {
		if (body.tools.some((tool) => tool.type !== "function" && tool.type !== "custom")) {
			throw new Error("This tool is not supported through ChatGPT plan usage.");
		}
		body.tools = [{ type: "namespace", name: TOOL_NAMESPACE, description: "LearnHarness tools", tools: body.tools }];
	}
	return body;
}

/** Keep subscription identity separate from API-key OpenAI in settings and
 * usage records. Only the wire adapter sees provider=openai, for pi-ai's
 * native serialization/reasoning rules. Auth is injected by the server. */
export function createChatGPTPlanProvider(access: ChatGPTPlanAccess): Provider<"openai-responses"> {
	function run(model: Model<"openai-responses">, context: TranscriptContext, options: SimpleStreamOptions = {}, simple = true) {
		const output = new AssistantMessageEventStream();
		void (async () => {
			let auth: Awaited<ReturnType<ChatGPTPlanAccess["authorize"]>> | undefined;
			try {
				auth = await access.authorize(model.id, options.signal);
				const headers = Object.fromEntries(Object.entries(options.headers ?? {}).filter(([key]) =>
					!["authorization", "openai-organization", "openai-project"].includes(key.toLowerCase())));
				const wireModel: Model<"openai-responses"> = {
					...model, provider: "openai", baseUrl: "https://api.openai.com/v1",
					compat: { ...model.compat, supportsMidConvoSystemMessages: false, supportsMidConvoEffort: false, supportsAdditionalTools: false, supportsToolSearch: false },
				};
				const wireContext = {
					...context,
					messages: context.messages.map((m) => m.role === "assistant" && m.provider === CHATGPT_PROVIDER ? { ...m, provider: "openai" } : m),
				};
				const stream = (simple ? responsesSimple : responses)(wireModel, wireContext, {
					...options,
					apiKey: auth.token,
					signal: auth.signal,
					// A subscription failure must never cause a paid-key retry.
					maxRetries: 0,
					headers: { ...headers, authorization: `Bearer ${auth.token}`, "OpenAI-Organization": null, "OpenAI-Project": null },
					onPayload: async (payload, requestModel) => chatGPTPlanPayload(await options.onPayload?.(payload, requestModel) ?? payload),
					onProviderStreamEvent: async (event, requestModel) => {
						await options.onProviderStreamEvent?.(event, { ...requestModel, provider: CHATGPT_PROVIDER });
						const raw = event as { type?: string; response?: { status?: string } };
						if (raw.type === "response.incomplete" || (raw.type === "response.completed" && raw.response?.status !== "completed")) {
							throw new Error("ChatGPT returned an incomplete response. Try again; no API-key fallback was used.");
						}
					},
				});
				for await (const event of stream) {
					const message = event.type === "done" ? event.message : event.type === "error" ? event.error : event.partial;
					message.provider = CHATGPT_PROVIDER;
					if (event.type === "error" && /subscription_sharing_.*usage|usage_limit_exceeded/.test(message.errorMessage ?? "")) {
						if (!message.errorMessage?.includes(CHATGPT_USAGE_URL)) message.errorMessage += `\nManage ChatGPT usage: ${CHATGPT_USAGE_URL}`;
					}
					output.push(event);
				}
				output.end();
			} catch (failure) {
				const error: AssistantMessage = {
					role: "assistant", content: [], api: model.api, provider: CHATGPT_PROVIDER, model: model.id,
					stopReason: options.signal?.aborted || auth?.signal.aborted ? "aborted" : "error",
					errorMessage: failure instanceof Error ? failure.message : "The ChatGPT request could not be completed.",
					timestamp: Date.now(),
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				};
				output.push({ type: "error", reason: error.stopReason as "error" | "aborted", error });
				output.end();
			} finally { auth?.release(); }
		})();
		return output;
	}
	return {
		id: CHATGPT_PROVIDER, name: "ChatGPT plan", baseUrl: "https://api.openai.com/v1",
		// This is only an availability gate; the real bearer token is resolved
		// inside each stream under the app-owned OAuth session lock.
		auth: { apiKey: {
			name: "ChatGPT plan",
			check: async () => access.connected() ? { type: "api_key", source: "ChatGPT plan" } : undefined,
			resolve: async () => access.connected() ? { auth: { apiKey: "subscription-managed" }, source: "ChatGPT plan" } : undefined,
		} },
		getModels: () => access.models(),
		stream: (model, context, options) => run(model, context, options as StreamOptions, false),
		streamSimple: (model, context, options) => run(model, context, options),
	};
}
