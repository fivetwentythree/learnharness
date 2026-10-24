import { handleChatGPTRequest } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = handleChatGPTRequest;
export const POST = handleChatGPTRequest;
