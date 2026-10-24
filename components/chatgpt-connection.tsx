"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { CHATGPT_USAGE_URL, type ChatGPTStatus } from "@/src/core";
import { notifySettingsSaved, useSettingsSaved } from "@/components/settings-signal";

export interface ChatGPTAction {
	action: "start" | "cancel" | "select" | "signout" | "refresh" | "welcome";
	accountId?: string;
	consent?: boolean;
}

/** Pure presentation seam; OAuth tokens never appear in this contract. */
export function ChatGPTConnectionBody({
	status, busy, error, authorizationUrl, onAction,
}: {
	status: ChatGPTStatus | null;
	busy: boolean;
	error: string | null;
	authorizationUrl: string | null;
	onAction: (action: ChatGPTAction) => void;
}) {
	const titleId = useId();
	const modalRef = useRef<HTMLDivElement>(null);
	const actionRef = useRef(onAction);
	const busyRef = useRef(busy);
	actionRef.current = onAction;
	busyRef.current = busy;
	useEffect(() => {
		if (!status?.welcome) return;
		const previous = document.activeElement as HTMLElement | null;
		const buttons = () => Array.from(modalRef.current?.querySelectorAll<HTMLElement>("a[href], button:not(:disabled)") ?? []);
		modalRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
		const keydown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				if (!busyRef.current) actionRef.current({ action: "welcome" });
			} else if (event.key === "Tab") {
				const items = buttons();
				const next = event.shiftKey ? items.at(-1) : items[0];
				if (!modalRef.current?.contains(document.activeElement) ||
					(event.shiftKey && document.activeElement === items[0]) ||
					(!event.shiftKey && document.activeElement === items.at(-1))) {
					event.preventDefault();
					next?.focus();
				}
			}
		};
		document.addEventListener("keydown", keydown, true);
		return () => {
			document.removeEventListener("keydown", keydown, true);
			if (previous?.isConnected) previous.focus();
		};
	}, [status?.welcome]);
	const button = "rounded-sm border border-border px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-accent disabled:opacity-40";
	return (
		<section className="flex flex-col gap-3" data-testid="chatgpt-connection">
			<p className="text-sm text-foreground">Use your ChatGPT plan</p>
			<p className="text-xs text-muted-foreground">
				Connect an eligible ChatGPT account without an API key. Selected ChatGPT plan models use your plan allowance or credits.
				Existing model choices are not changed.
			</p>
			{status?.accounts.map((account) => (
				<div key={account.id} className="flex flex-wrap items-center gap-2 text-xs" data-testid="chatgpt-account">
					<span className="min-w-0 break-words text-foreground">{account.label}</span>
					<span className="text-muted-foreground">
						{account.id === status.activeId ? "Active · " : ""}
						{account.connected ? account.planEnabled ? "Plan enabled" : "Plan permission needed" : "Signed out"}
					</span>
					{account.connected && account.id !== status.activeId && (
						<button type="button" className={button} disabled={busy || status.pending} onClick={() => onAction({ action: "select", accountId: account.id })}>Use account</button>
					)}
					{(!account.connected || !account.planEnabled) && (
						<button type="button" className={button} disabled={busy || status.pending} onClick={() => onAction({ action: "start", accountId: account.id, consent: account.connected && !account.planEnabled })}>
							{account.connected ? "Enable ChatGPT plan usage" : "Continue with ChatGPT"}
						</button>
					)}
					{account.connected && (
						<button type="button" className={button} disabled={busy} onClick={() => onAction({ action: "signout", accountId: account.id })}>Sign out</button>
					)}
				</div>
			))}
			<div className="flex flex-wrap items-center gap-2">
				<button type="button" className={button} data-testid="chatgpt-signin" disabled={busy || !status || status.pending} onClick={() => onAction({ action: "start" })}>
					Continue with ChatGPT
				</button>
				{status?.pending && (
					<>
						<span className="text-xs text-muted-foreground">Complete sign-in in your browser.</span>
						{authorizationUrl && <a href={authorizationUrl} target="_blank" rel="noopener noreferrer" className="text-xs underline">Open sign-in page</a>}
						<button type="button" className={button} disabled={busy} onClick={() => onAction({ action: "cancel" })}>Cancel</button>
					</>
				)}
				{status?.activeId && status.accounts.some((a) => a.id === status.activeId && a.planEnabled) && (
					<button type="button" className={button} disabled={busy || status.pending} onClick={() => onAction({ action: "refresh" })}>Refresh models</button>
				)}
				<a href={CHATGPT_USAGE_URL} target="_blank" rel="noopener noreferrer" className="text-xs text-muted-foreground underline">Manage usage</a>
			</div>
			{(error || status?.error) && <p role="alert" className="text-xs text-destructive">{error || status?.error}</p>}
			{status?.notice && <p role="status" className="text-xs text-muted-foreground">{status.notice}</p>}
			<p className="text-xs text-muted-foreground">
				After connecting, choose ChatGPT plan models for Strong, Cheap, and Vision.
				Dictation and external web search still use their separate services.
			</p>
			{status?.welcome && (
				<div ref={modalRef} className="fixed inset-0 z-[60] flex items-center justify-center bg-background/80 p-6 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid="chatgpt-welcome">
					<div className="flex max-w-md flex-col gap-4 rounded-md border border-border bg-card p-6">
						<h2 id={titleId} className="text-lg text-foreground">You&apos;re using your ChatGPT plan</h2>
						<p className="text-sm text-muted-foreground">
							Eligible requests made with ChatGPT plan models use your ChatGPT plan allowance or credits.
							You can review limits and manage access in ChatGPT settings.
						</p>
						<a href={CHATGPT_USAGE_URL} target="_blank" rel="noopener noreferrer" className="text-sm underline">Manage usage</a>
						<button type="button" className={button} disabled={busy} onClick={() => onAction({ action: "welcome" })}>Got it</button>
					</div>
				</div>
			)}
		</section>
	);
}

export function ChatGPTConnection() {
	const [status, setStatus] = useState<ChatGPTStatus | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);
	const readGeneration = useRef(0);
	const reload = useCallback(async () => {
		const generation = ++readGeneration.current;
		try {
			const response = await fetch("/api/chatgpt", { cache: "no-store" });
			if (!response.ok) throw new Error();
			const next = await response.json() as ChatGPTStatus;
			if (generation !== readGeneration.current) return;
			setStatus(next);
			setError(null);
			if (!next.pending) setAuthorizationUrl(null);
		} catch {
			if (generation === readGeneration.current) setError("ChatGPT sign-in is available in the local app. Could not load its connection status.");
		}
	}, []);
	useEffect(() => { void reload(); }, [reload]);
	useSettingsSaved((section) => { if (section === "keys") void reload(); });

	async function action(body: ChatGPTAction) {
		setBusy(true); setError(null);
		try {
			const response = await fetch("/api/chatgpt", {
				method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
			});
			const result = await response.json();
			if (!response.ok) throw new Error(result.error ?? "ChatGPT connection failed.");
			if (body.action === "start") {
				const url = new URL(result.authorizationUrl);
				if (url.origin !== "https://auth.openai.com" || url.pathname !== "/api/accounts/authorize") throw new Error("Invalid sign-in destination.");
				setAuthorizationUrl(url.href);
				// Electron routes external HTTPS links to the system browser.
				// The visible link remains available if a web popup is blocked.
				window.open(url.href, "_blank", "noopener,noreferrer");
			}
			await reload();
			notifySettingsSaved("keys");
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : "Could not connect ChatGPT. Try again.");
		} finally { setBusy(false); }
	}
	return <ChatGPTConnectionBody status={status} busy={busy} error={error} authorizationUrl={authorizationUrl} onAction={(body) => void action(body)} />;
}
