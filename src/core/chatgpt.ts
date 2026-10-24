/** Public, browser-safe subscription identity. Never contains OAuth tokens. */
export const CHATGPT_PROVIDER = "chatgpt-plan";
export const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";

export interface ChatGPTAccountInfo {
	id: string;
	label: string;
	email?: string;
	connected: boolean;
	planEnabled: boolean;
}

export interface ChatGPTStatus {
	accounts: ChatGPTAccountInfo[];
	activeId: string | null;
	pending: boolean;
	error: string | null;
	notice: string | null;
	welcome: boolean;
}

/** Server-side persistence types; type-only imports never carry secrets into UI. */
export interface ChatGPTTokens {
	access: string;
	refresh: string;
	idToken: string;
	expiresAt: number;
	scopes: string[];
}

export interface ChatGPTAccount {
	id: string;
	subject: string;
	email?: string;
	tokens?: ChatGPTTokens;
	models: { id: string; name: string }[];
}

export interface ChatGPTRecord {
	version: 1;
	hostId?: string;
	activeId?: string;
	welcomed?: boolean;
	accounts: ChatGPTAccount[];
}

export interface ChatGPTStore {
	read(): ChatGPTRecord;
	/** Cross-process serialization covers token rotation, login, and sign-out. */
	modify<T>(fn: (record: ChatGPTRecord) => Promise<T> | T): Promise<T>;
}
