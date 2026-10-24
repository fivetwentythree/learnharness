import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatGPTConnectionBody } from "../components/chatgpt-connection.tsx";
import { ModelMenuList } from "../components/settings/model-menu.tsx";
import { setupStage } from "../components/setup-dialog.tsx";
import { hasProviderKey, strongKeyless } from "../components/setup-cta.tsx";
import { providerKeyMissing, isProviderKeyRefusal } from "../src/core/settings.ts";
import { CHATGPT_PROVIDER, CHATGPT_USAGE_URL, type ChatGPTStatus } from "../src/core/chatgpt.ts";
import type { ModelCatalogResponse } from "../src/core/contracts/models.ts";
import { toModelDto } from "../src/server/model-catalog.ts";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

const connected: ChatGPTStatus = {
	accounts: [{ id: "oaiapp_fixture", label: "learner@example.test · 1", connected: true, planEnabled: true }],
	activeId: "oaiapp_fixture", pending: false, error: null, notice: null, welcome: false,
};
const render = (status: ChatGPTStatus) => renderToStaticMarkup(
	<ChatGPTConnectionBody status={status} busy={false} error={null} authorizationUrl={null} onAction={() => {}} />,
);

describe("ChatGPT setup and presentation", () => {
	it("offers browser sign-in and usage management, never a password or token input", () => {
		const html = render(connected);
		assert.match(html, /Continue with ChatGPT/);
		assert.match(html, /learner@example.test/);
		assert.ok(html.includes(CHATGPT_USAGE_URL));
		assert.doesNotMatch(html, /<input|type="password"/);
		assert.match(html, /Existing model choices are not changed/);
	});
	it("shows the first-use modal only when the server requests it", () => {
		assert.doesNotMatch(render(connected), /chatgpt-welcome/);
		assert.match(render({ ...connected, welcome: true }), /chatgpt-welcome/);
		assert.match(render({ ...connected, welcome: true }), /Got it/);
	});
	it("offers explicit consent recovery without pretending identity alone enables plan use", () => {
		const html = render({ ...connected, accounts: [{ ...connected.accounts[0]!, planEnabled: false }] });
		assert.match(html, /Plan permission needed/);
		assert.match(html, /Enable ChatGPT plan usage/);
	});
	it("a subscription unlocks setup without synthesizing an API key", () => {
		assert.ok(hasProviderKey([], [], true));
		assert.equal(setupStage([{ id: CHATGPT_PROVIDER, keyPresent: true }]), "pickers");
		const catalog = { slots: { strong: { model: { provider: CHATGPT_PROVIDER, id: "gpt-6-luna" } } }, providers: [{ id: CHATGPT_PROVIDER, envVar: null, keyPresent: true, authType: "oauth" }] } as ModelCatalogResponse;
		assert.equal(strongKeyless(catalog), false);
		assert.equal(strongKeyless({ ...catalog, providers: [] }), true);
		const refusal = providerKeyMissing(CHATGPT_PROVIDER, ["strong"]);
		assert.match(refusal.error, /sign in/);
		assert.ok(isProviderKeyRefusal(refusal.error));
	});
	it("labels subscription models by billing path, not API dollar rates", () => {
		const base = openaiProvider().getModels().find((m) => m.id === "gpt-6-luna")!;
		const model = toModelDto({ ...base, provider: CHATGPT_PROVIDER });
		const html = renderToStaticMarkup(<ModelMenuList models={[model]} effectiveId={model.id} onPick={() => {}} />);
		assert.match(html, /ChatGPT plan/);
		assert.doesNotMatch(html, /USD per 1M|\$\d/);
	});
});
