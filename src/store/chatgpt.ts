import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import { z } from "zod";
import { CHATGPT_AUTH_FILE } from "../../config.ts";
import type { ChatGPTRecord, ChatGPTStore } from "../core/chatgpt.ts";

const tokens = z.object({
	access: z.string().min(1),
	refresh: z.string().min(1),
	idToken: z.string().min(1),
	expiresAt: z.number().finite().positive(),
	scopes: z.array(z.string()),
});
const schema = z.object({
	version: z.literal(1),
	hostId: z.string().regex(/^urn:uuid:[0-9a-f-]{36}$/i).optional(),
	activeId: z.string().optional(),
	welcomed: z.boolean().optional(),
	accounts: z.array(z.object({
		id: z.string().min(1),
		subject: z.string().min(1),
		email: z.string().optional(),
		tokens: tokens.optional(),
		models: z.array(z.object({ id: z.string(), name: z.string() })),
	})),
});

/** No corrupt-file fallback: never overwrite registrations we cannot understand. */
export function createChatGPTStore(file: string): ChatGPTStore {
	function read(): ChatGPTRecord {
		try {
			const result = schema.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
			if (!result.success) throw new Error("invalid format");
			const record = result.data;
			if (new Set(record.accounts.map((a) => a.id)).size !== record.accounts.length ||
				(record.activeId && !record.accounts.some((a) => a.id === record.activeId))) {
				throw new Error("invalid account mapping");
			}
			return record;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, accounts: [] };
			throw new Error("Could not read the saved ChatGPT connection. Its credentials were not changed.");
		}
	}
	return {
		read,
		async modify(fn) {
			fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
			const release = await lockfile.lock(file, {
				realpath: false,
				retries: { retries: 20, minTimeout: 50, maxTimeout: 500 },
			});
			const tmp = `${file}.tmp-${randomUUID()}`;
			try {
				const record = read();
				const before = JSON.stringify(record);
				const result = await fn(record);
				schema.parse(record);
				if (JSON.stringify(record) !== before) {
					fs.writeFileSync(tmp, `${JSON.stringify(record, null, "\t")}\n`, { flag: "wx", mode: 0o600 });
					fs.chmodSync(tmp, 0o600);
					fs.renameSync(tmp, file);
				}
				return result;
			} finally {
				try { fs.unlinkSync(tmp); } catch { /* already renamed or never created */ }
				await release();
			}
		},
	};
}

export const chatGPTStore = createChatGPTStore(CHATGPT_AUTH_FILE);
