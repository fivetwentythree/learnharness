import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createModels, type Model } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { Agent } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { chatGPTPlanPayload, createChatGPTPlanProvider } from "../src/agent/chatgpt-plan.ts";
import { CHATGPT_PROVIDER, CHATGPT_USAGE_URL } from "../src/core/chatgpt.ts";

const TOKEN = "synthetic-chatgpt-plan-token";
const base = openaiProvider().getModels().find((m) => m.id === "gpt-6-luna")!;
assert.ok(base);
const model: Model<"openai-responses"> = { ...base, provider: CHATGPT_PROVIDER, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };

function sse(events: unknown[]) {
	return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
}
const usage = { input_tokens: 10, output_tokens: 3, total_tokens: 13 };
function textEvents(text = "Completed") {
	const item = { type: "message", id: "msg_test", role: "assistant", phase: "final_answer", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
	return [
		{ type: "response.created", response: { id: "resp_test", status: "in_progress" } },
		{ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
		{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
		{ type: "response.output_item.done", output_index: 0, item },
		{ type: "response.completed", response: { id: "resp_test", status: "completed", output: [item], usage } },
	];
}
function toolEvents() {
	const item = { type: "function_call", id: "fc_test", call_id: "call_test", name: "double", namespace: "learnharness", arguments: '{"n":2}', status: "completed" };
	return [
		{ type: "response.created", response: { id: "resp_tool", status: "in_progress" } },
		{ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
		{ type: "response.function_call_arguments.delta", output_index: 0, delta: '{"n":2}' },
		{ type: "response.output_item.done", output_index: 0, item },
		{ type: "response.completed", response: { id: "resp_tool", status: "completed", output: [item], usage } },
	];
}
function collection(authorize?: () => Promise<never>) {
	let released = 0;
	const models = createModels();
	models.setProvider(createChatGPTPlanProvider({
		connected: () => true,
		models: () => [model],
		authorize: authorize ?? (async () => ({ token: TOKEN, signal: new AbortController().signal, release: () => { released++; } })),
	}));
	return { models, released: () => released };
}
const context = { messages: [{ role: "user" as const, content: "Explain", timestamp: 1 }] };

describe("ChatGPT plan Responses adapter", () => {
	it("pins streaming/stateless requests, removes unsupported fields, and namespaces tools and replayed calls", () => {
		const original = {
			model: model.id, input: [{ role: "system", content: "Teach" }, { type: "function_call", name: "double", call_id: "x" }],
			tools: [{ type: "function", name: "double", parameters: { type: "object" } }],
			stream: false, store: true, max_output_tokens: 100, metadata: { note: "not allowed" },
			temperature: 0.5, previous_response_id: "old", prompt_cache_retention: "24h", background: true,
		};
		const body = chatGPTPlanPayload(original);
		assert.equal(body.stream, true); assert.equal(body.store, false);
		for (const field of ["max_output_tokens", "metadata", "temperature", "previous_response_id", "prompt_cache_retention", "background"]) assert.ok(!(field in body));
		assert.equal((body.input as Record<string, unknown>[])[0]!.role, "developer");
		assert.equal((body.input as Record<string, unknown>[])[1]!.namespace, "learnharness");
		assert.equal((body.tools as Record<string, unknown>[])[0]!.type, "namespace");
		assert.equal(original.stream, false, "caller payload is not mutated");
		assert.throws(() => chatGPTPlanPayload({ input: [], tools: [{ type: "tool_search" }] }), /not supported/);
	});

	it("uses only the subscription token at the public endpoint, even with paid-key/header overrides", async () => {
		const f = collection();
		let requests = 0;
		const result = await f.models.completeSimple(model, context, {
			apiKey: "sk-paid-key-MUST-NOT-BE-USED",
			headers: { Authorization: "Bearer sk-other-paid-key", "OpenAI-Project": "paid-project" },
			maxTokens: 100, temperature: 0.4, cacheRetention: "long",
			onPayload: (body) => ({ ...body as object, store: true, temperature: 0.9 }),
			fetch: async (input, init) => {
				requests++;
				assert.equal(String(input), "https://api.openai.com/v1/responses");
				const headers = new Headers(init?.headers);
				assert.equal(headers.get("authorization"), `Bearer ${TOKEN}`);
				assert.equal(headers.get("openai-project"), null);
				const body = JSON.parse(init!.body as string);
				assert.equal(body.stream, true); assert.equal(body.store, false);
				assert.ok(!("temperature" in body)); assert.ok(!("max_output_tokens" in body));
				assert.ok(!("prompt_cache_retention" in body));
				return sse(textEvents());
			},
		});
		assert.equal(requests, 1);
		assert.equal(result.provider, CHATGPT_PROVIDER);
		assert.equal(result.stopReason, "stop");
		assert.equal(result.content[0]!.type, "text");
		assert.equal(f.released(), 1);
	});

	it("completes an actual agent tool loop and replays namespaced history", async () => {
		const f = collection();
		let calls = 0, executed = 0;
		const bodies: Record<string, any>[] = [];
		const agent = new Agent({
			initialState: {
				model, systemPrompt: "Explain with a tool", thinkingLevel: "off",
				tools: [{
					name: "double", label: "Double", description: "Double a number", parameters: Type.Object({ n: Type.Number() }),
					execute: async (_id, args) => { executed++; return { content: [{ type: "text", text: String((args as { n: number }).n * 2) }], details: {} }; },
				}],
			},
			streamFn: (requestModel, requestContext, options) => f.models.streamSimple(requestModel, requestContext, {
				...options,
				fetch: async (url, init) => {
					assert.equal(String(url), "https://api.openai.com/v1/responses");
					const body = JSON.parse(init!.body as string);
					bodies.push(body);
					return sse(calls++ === 0 ? toolEvents() : textEvents("Four"));
				},
			}),
		});
		await agent.prompt("Double two");
		assert.equal(agent.state.errorMessage, undefined);
		assert.equal(calls, 2); assert.equal(executed, 1);
		assert.equal(bodies[0]!.tools[0].type, "namespace");
		const replay = bodies[1]!.input.find((item: Record<string, unknown>) => item.type === "function_call");
		assert.equal(replay.namespace, "learnharness");
		assert.ok(bodies[1]!.input.some((item: Record<string, unknown>) => item.type === "function_call_output" && item.output === "4"));
		assert.ok(agent.state.messages.some((message) => message.role === "assistant" && message.provider === CHATGPT_PROVIDER));
		assert.equal(f.released(), 2);
	});

	it("surfaces mid-stream usage limits without executing tools or changing billing", async () => {
		const f = collection();
		let count = 0;
		const result = await f.models.completeSimple(model, context, {
			fetch: async () => {
				count++;
				return sse([
					{ type: "response.created", response: { id: "r", status: "in_progress" } },
					{ type: "response.failed", response: { id: "r", status: "failed", error: { code: "subscription_sharing_usage_limit_exceeded", message: "Limit reached" } } },
				]);
			},
		});
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage!, /subscription_sharing_usage_limit_exceeded/);
		assert.ok(result.errorMessage!.includes(CHATGPT_USAGE_URL));
		assert.equal(count, 1);
	});

	it("never treats incomplete or interrupted streams as success", async () => {
		for (const events of [
			[{ type: "response.created", response: { id: "r", status: "in_progress" } }],
			[{ type: "response.incomplete", response: { id: "r", status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } }],
		]) {
			const f = collection();
			const result = await f.models.completeSimple(model, context, { fetch: async () => sse(events) });
			assert.equal(result.stopReason, "error");
			assert.equal(f.released(), 1);
		}
	});

	it("does not retry an admission error or fall back to an environment API key", async () => {
		const f = collection();
		let count = 0;
		const result = await f.models.completeSimple(model, context, {
			fetch: async () => { count++; return Response.json({ detail: "Plan route unavailable" }, { status: 503, headers: { "x-request-id": "test-request-id" } }); },
		});
		assert.equal(count, 1); assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage!, /503|unavailable/);
	});

	it("encodes auth failures as stream errors without making an inference request", async () => {
		const f = collection(async () => { throw new Error("Reconnect ChatGPT"); });
		const result = await f.models.completeSimple(model, context, { fetch: async () => { throw new Error("MUST NOT FETCH"); } });
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage!, /Reconnect ChatGPT/);
	});
});
