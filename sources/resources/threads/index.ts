// threads resource: backs the `bee threads` CLI command and the bee_*_thread*
// MCP tools, over the bee-server Threads developer API (test users only).
//
// Surface divergences:
//  - Argument keys: the CLI bag uses camelCase flag keys (threadId,
//    clientMessageId, photo, file, timeout); MCP uses snake_case (thread_id,
//    client_message_id, file_paths, inline_files, timeout_seconds).
//  - Overall wait: CLI --timeout is a duration (default 90s, under the 2-minute
//    command limit many agent shells apply); MCP timeout_seconds defaults to 45,
//    under the ~60 s at which MCP clients often cut a tool call.
//  - The pending/stalled `hint` names the next CLI command or MCP tool.
//  - bee_get_thread_messages returns the latest 50 messages by default; the CLI
//    shows all unless --limit is given.
import { randomUUID } from "node:crypto";
import { printJson } from "@/client/clientApi";
import { asRecord } from "@/resources/json";
import { optionalNumber, optionalString } from "@/resources/coerce";
import { emptySchema, objectSchema } from "@/resources/schema";
import {
  abortThread,
  getThreadMessages,
  latestUserMessageId,
  listThreads,
  sendAndWait,
  uploadAttachment,
  waitForAnswer,
  type ThreadAnswer,
  type UploadedFile,
} from "@/resources/threads/api";
import {
  loadAttachment,
  MAX_THREAD_FILES,
  type AttachmentSource,
} from "@/resources/threads/attachments";
import type { JsonObject } from "@/mcp/types";
import type {
  ActionContext,
  ActionDefinition,
  ActionResult,
  CliFlag,
  CliPositional,
  ResourceModule,
  Surface,
} from "@/resources/types";
import { formatDateValue, resolveTimeZone, type OutputFormat } from "@/utils/markdown";

const USAGE = [
  "bee threads list [--json]",
  "bee threads create --text <text> [--photo PATH]... [--file PATH]... [--timeout 90s] [--client-message-id ID] [--json]",
  "bee threads send <thread-id> --text <text> [--photo PATH]... [--file PATH]... [--timeout 90s] [--client-message-id ID] [--json]",
  "bee threads wait <thread-id> [--after <message-id>] [--timeout 90s] [--json]",
  "bee threads messages <thread-id> [--limit N] [--json]",
  "bee threads abort <thread-id> [--json]",
  "",
  "--timeout is the overall wait for the answer (e.g. 30s, 5m, 1h; default 90s; 0 sends without waiting).",
  "If the answer is not ready in time, the thread id is printed; continue with \"bee threads wait <thread-id>\".",
].join("\n");

export const CLI_DEFAULT_TIMEOUT_MS = 90_000;
export const MCP_DEFAULT_TIMEOUT_SECONDS = 45;
const MCP_MAX_TIMEOUT_SECONDS = 3_600;
const CLI_MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const MAX_TEXT_LENGTH = 100_000;
const MCP_DEFAULT_MESSAGES_LIMIT = 50;
const MCP_MAX_MESSAGES_LIMIT = 500;
const CLIENT_MESSAGE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

// ---- shared coercers ----------------------------------------------------------

function threadIdArg(raw: { readonly [key: string]: unknown }, surface: Surface): string {
  const value = optionalString(raw[surface === "cli" ? "threadId" : "thread_id"]);
  if (value === null) {
    throw new Error(surface === "cli" ? "Provide exactly one thread id." : "Missing thread_id.");
  }
  if (value.length > 255) {
    throw new Error("thread_id is too long.");
  }
  return value;
}

// "90", "90s", "1.5m", "500ms", "2h" -> milliseconds. A bare number is seconds.
export function parseDuration(value: string, flag: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(value.trim().toLowerCase());
  if (!match) {
    throw new Error(`${flag} must be a duration like 30s, 5m or 1h`);
  }
  const unit = match[2] ?? "s";
  const factor = unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000;
  const ms = Math.round(Number(match[1]) * factor);
  if (ms > CLI_MAX_TIMEOUT_MS) {
    throw new Error(`${flag} must be at most 24h`);
  }
  return ms;
}

function timeoutArg(raw: { readonly [key: string]: unknown }, surface: Surface): number {
  if (surface === "cli") {
    const value = raw["timeout"];
    return typeof value === "string" ? parseDuration(value, "--timeout") : CLI_DEFAULT_TIMEOUT_MS;
  }
  const seconds = optionalNumber(raw["timeout_seconds"]) ?? MCP_DEFAULT_TIMEOUT_SECONDS;
  return Math.round(Math.min(Math.max(seconds, 0), MCP_MAX_TIMEOUT_SECONDS) * 1000);
}

function clientMessageIdArg(raw: { readonly [key: string]: unknown }, surface: Surface): string {
  const key = surface === "cli" ? "clientMessageId" : "client_message_id";
  const value = optionalString(raw[key]);
  if (value === null) {
    return `bee-cli-${randomUUID()}`;
  }
  if (!CLIENT_MESSAGE_ID.test(value)) {
    throw new Error(
      `${surface === "cli" ? "--client-message-id" : "client_message_id"} must be 1-128 characters of A-Z a-z 0-9 . _ : -`
    );
  }
  return value;
}

function stringList(value: unknown, name: string): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new Error(`${name} must be an array of non-empty strings.`);
  }
  return value as string[];
}

function inlineFiles(value: unknown): AttachmentSource[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("inline_files must be an array.");
  }
  return value.map((item, index) => {
    const record = asRecord(item);
    const data = record["data"];
    const filename = optionalString(record["filename"]);
    if (typeof data !== "string" || filename === null) {
      throw new Error(`inline_files[${index}] needs base64 data and a filename.`);
    }
    return {
      kind: "inline",
      data,
      filename,
      contentType: optionalString(record["content_type"]) ?? undefined,
    };
  });
}

function attachmentsArg(raw: { readonly [key: string]: unknown }, surface: Surface): AttachmentSource[] {
  const sources: AttachmentSource[] = surface === "cli"
    ? [
      ...stringList(raw["photo"], "--photo").map((path): AttachmentSource => ({ kind: "path", path, photo: true })),
      ...stringList(raw["file"], "--file").map((path): AttachmentSource => ({ kind: "path", path, photo: false })),
    ]
    : [
      ...stringList(raw["file_paths"], "file_paths").map((path): AttachmentSource => ({ kind: "path", path, photo: false })),
      ...inlineFiles(raw["inline_files"]),
    ];
  if (sources.length > MAX_THREAD_FILES) {
    throw new Error(`At most ${MAX_THREAD_FILES} photos or files per message.`);
  }
  return sources;
}

// ---- send (create + send) -------------------------------------------------------

type SendInput = {
  surface: Surface;
  threadId: string | null;
  text: string;
  attachments: AttachmentSource[];
  timeoutMs: number;
  clientMessageId: string;
};

function coerceSend(raw: { readonly [key: string]: unknown }, surface: Surface, newThread: boolean): SendInput {
  const text = typeof raw["text"] === "string" ? raw["text"] : "";
  const attachments = attachmentsArg(raw, surface);
  if (text.trim().length === 0 && attachments.length === 0) {
    throw new Error(surface === "cli"
      ? "Provide --text or at least one --photo/--file."
      : "Provide text or at least one file (file_paths or inline_files).");
  }
  if (text.length > MAX_TEXT_LENGTH) {
    throw new Error(`Message text must be at most ${MAX_TEXT_LENGTH} characters.`);
  }
  return {
    surface,
    threadId: newThread ? null : threadIdArg(raw, surface),
    text,
    attachments,
    timeoutMs: timeoutArg(raw, surface),
    clientMessageId: clientMessageIdArg(raw, surface),
  };
}

async function runSend(ctx: ActionContext, input: SendInput): Promise<ActionResult> {
  // Read every local file before uploading any, so a bad path uploads nothing.
  const loaded = input.attachments.map(loadAttachment);
  const files: UploadedFile[] = [];
  for (const file of loaded) {
    files.push(await uploadAttachment(ctx, file));
  }
  const answer = await sendAndWait(ctx, {
    threadId: input.threadId,
    text: input.text,
    fileIds: files.map((file) => file.file_id),
    clientMessageId: input.clientMessageId,
    timeoutMs: input.timeoutMs,
    onWaiting: waitingNotice(input.surface),
  });
  return {
    kind: "json",
    data: answerPayload(answer, input.surface, {
      client_message_id: input.clientMessageId,
      ...(files.length > 0 ? { files } : {}),
    }),
  };
}

// The CLI tells stderr which thread it is waiting on, so an interrupted run
// still leaves the id behind. MCP stays quiet.
function waitingNotice(surface: Surface): ((answer: ThreadAnswer) => void) | undefined {
  return surface === "cli"
    ? (answer) => process.stderr.write(`Waiting for the answer on thread ${answer.thread_id}...\n`)
    : undefined;
}

const TIMEOUT_SCHEMA: JsonObject = {
  type: "number",
  minimum: 0,
  maximum: MCP_MAX_TIMEOUT_SECONDS,
  description: `Overall seconds to wait for the answer (default ${MCP_DEFAULT_TIMEOUT_SECONDS}; 0 sends without waiting). Raise it only if your client allows long tool calls.`,
};

const SEND_PROPERTIES: JsonObject = {
  text: {
    type: "string",
    maxLength: MAX_TEXT_LENGTH,
    description: "Message text. Optional when files are attached.",
  },
  file_paths: {
    type: "array",
    items: { type: "string" },
    description: "Local paths of photos or files to attach (max 20, 25 MB each). Content type comes from the extension.",
  },
  inline_files: {
    type: "array",
    items: {
      type: "object",
      properties: {
        data: { type: "string", description: "Base64 file content (a data: URL also works)." },
        filename: { type: "string", description: "File name, e.g. photo.jpg; its extension sets the content type." },
        content_type: { type: "string", description: "Optional MIME type, e.g. image/png." },
      },
      required: ["data", "filename"],
      additionalProperties: false,
    },
    description: "Files to attach given inline as base64, for content that is not on disk.",
  },
  timeout_seconds: TIMEOUT_SCHEMA,
  client_message_id: {
    type: "string",
    minLength: 1,
    maxLength: 128,
    description: "Optional idempotency key (A-Z a-z 0-9 . _ : -). Re-sending with the same key does not send twice. Generated when omitted.",
  },
};

const NEXT_STEP =
  "The result has status, thread_id and message_id at the top level. If status is \"pending\" (not answered in time, not an error) or \"stalled\", call bee_wait_thread with thread_id and message_id to keep waiting.";

const createThread: ActionDefinition<SendInput> = {
  mcp: {
    name: "bee_create_thread",
    description:
      `Start a new Bee agent chat thread with a first message (text and/or photos/files) and wait for the agent's answer. Returns the answer text and messages when completed. ${NEXT_STEP}`,
    inputSchema: objectSchema({ properties: { ...SEND_PROPERTIES } }),
  },
  cli: {
    subcommand: "create",
    flags: sendFlags(),
    render: (result, format) => renderAnswer(result, format),
  },
  coerceInput: (raw, surface) => coerceSend(raw, surface, true),
  run: runSend,
};

const sendThreadMessage: ActionDefinition<SendInput> = {
  mcp: {
    name: "bee_send_thread_message",
    description:
      `Send a message (text and/or photos/files) to an existing Bee agent thread and wait for the agent's answer. ${NEXT_STEP}`,
    inputSchema: objectSchema({
      properties: {
        thread_id: { type: "string", minLength: 1, maxLength: 255, description: "Thread id from bee_list_threads or bee_create_thread." },
        ...SEND_PROPERTIES,
      },
      required: ["thread_id"],
    }),
  },
  cli: {
    subcommand: "send",
    positionals: [threadPositional()],
    flags: sendFlags(),
    render: (result, format) => renderAnswer(result, format),
  },
  coerceInput: (raw, surface) => coerceSend(raw, surface, false),
  run: runSend,
};

function sendFlags(): CliFlag[] {
  return [
    { name: "--text", kind: "string" },
    { name: "--photo", kind: "stringList" },
    { name: "--file", kind: "stringList" },
    { name: "--timeout", kind: "string" },
    { name: "--client-message-id", kind: "string" },
  ];
}

function threadPositional(): CliPositional {
  return { name: "threadId", required: true, kind: "string", arityMessage: "Provide exactly one thread id." };
}

// ---- wait ------------------------------------------------------------------------

type WaitInput = { surface: Surface; threadId: string; after: string | undefined; timeoutMs: number };

const waitThread: ActionDefinition<WaitInput> = {
  mcp: {
    name: "bee_wait_thread",
    description:
      "Keep waiting for the Bee agent's answer on a thread, e.g. after bee_create_thread or bee_send_thread_message returned status \"pending\". Waits after message_id, or after the thread's latest user message when message_id is omitted. Returns the same result shape (status, thread_id, message_id at the top level); call it again while status is \"pending\".",
    inputSchema: objectSchema({
      properties: {
        thread_id: { type: "string", minLength: 1, maxLength: 255, description: "Thread id." },
        message_id: {
          type: "string",
          minLength: 1,
          maxLength: 255,
          description: "Wait for the answer after this message (the message_id of a previous result). Defaults to the thread's latest user message.",
        },
        timeout_seconds: TIMEOUT_SCHEMA,
      },
      required: ["thread_id"],
    }),
  },
  cli: {
    subcommand: "wait",
    positionals: [threadPositional()],
    flags: [
      { name: "--after", kind: "string" },
      { name: "--timeout", kind: "string" },
    ],
    render: (result, format) => renderAnswer(result, format),
  },
  coerceInput: (raw, surface) => {
    const after = optionalString(raw[surface === "cli" ? "after" : "message_id"]) ?? undefined;
    return { surface, threadId: threadIdArg(raw, surface), after, timeoutMs: timeoutArg(raw, surface) };
  },
  run: async (ctx, input) => {
    const after = input.after ?? await latestUserMessageId(ctx, input.threadId);
    const answer = await waitForAnswer(ctx, {
      threadId: input.threadId,
      after,
      timeoutMs: input.timeoutMs,
      onWaiting: waitingNotice(input.surface),
    });
    return { kind: "json", data: answerPayload(answer, input.surface, {}) };
  },
};

// ---- list ------------------------------------------------------------------------

const listThreadsAction: ActionDefinition<Record<string, never>> = {
  mcp: {
    name: "bee_list_threads",
    description: "List the user's Bee agent chat threads with thread_id, name, state (idle or running), created_at and updated_at.",
    inputSchema: emptySchema,
  },
  cli: {
    subcommand: "list",
    flags: [],
    render: (result, format) => {
      if (result.kind !== "json") {
        return;
      }
      if (format === "json") {
        printJson(result.data);
        return;
      }
      console.log(formatThreadList(result.data));
    },
  },
  coerceInput: () => ({}),
  run: async (ctx) => ({ kind: "json", data: await listThreads(ctx) }),
};

// ---- messages --------------------------------------------------------------------

type MessagesInput = { threadId: string; limit: number | null };

const threadMessages: ActionDefinition<MessagesInput> = {
  mcp: {
    name: "bee_get_thread_messages",
    description:
      `Get the messages of a Bee agent thread, oldest first: role, text, parts (text, attachments, tool calls) and timestamps. Returns the latest ${MCP_DEFAULT_MESSAGES_LIMIT} by default; omitted_earlier counts older ones left out.`,
    inputSchema: objectSchema({
      properties: {
        thread_id: { type: "string", minLength: 1, maxLength: 255, description: "Thread id." },
        limit: {
          type: "number",
          minimum: 1,
          maximum: MCP_MAX_MESSAGES_LIMIT,
          description: `Return only the latest N messages (default ${MCP_DEFAULT_MESSAGES_LIMIT}).`,
        },
      },
      required: ["thread_id"],
    }),
  },
  cli: {
    subcommand: "messages",
    positionals: [threadPositional()],
    flags: [{ name: "--limit", kind: "int" }],
    render: (result, format) => {
      if (result.kind !== "json") {
        return;
      }
      if (format === "json") {
        printJson(result.data);
        return;
      }
      console.log(formatMessages(result.data));
    },
  },
  coerceInput: (raw, surface) => {
    const threadId = threadIdArg(raw, surface);
    if (surface === "cli") {
      return { threadId, limit: typeof raw["limit"] === "number" ? raw["limit"] : null };
    }
    const limit = optionalNumber(raw["limit"]) ?? MCP_DEFAULT_MESSAGES_LIMIT;
    return { threadId, limit: Math.floor(Math.min(Math.max(limit, 1), MCP_MAX_MESSAGES_LIMIT)) };
  },
  run: async (ctx, input) => {
    const data = asRecord(await getThreadMessages(ctx, input.threadId));
    const messages = Array.isArray(data["messages"]) ? data["messages"] : [];
    const kept = input.limit !== null && messages.length > input.limit ? messages.slice(-input.limit) : messages;
    return {
      kind: "json",
      data: {
        thread_id: data["thread_id"] ?? input.threadId,
        messages: kept,
        ...(kept.length < messages.length ? { omitted_earlier: messages.length - kept.length } : {}),
      },
    };
  },
};

// ---- abort -----------------------------------------------------------------------

type AbortInput = { threadId: string };

const abortThreadAction: ActionDefinition<AbortInput> = {
  mcp: {
    name: "bee_abort_thread",
    description: "Stop the Bee agent's current work on a thread. The thread becomes idle; send a new message to continue.",
    inputSchema: objectSchema({
      properties: { thread_id: { type: "string", minLength: 1, maxLength: 255, description: "Thread id." } },
      required: ["thread_id"],
    }),
  },
  cli: {
    subcommand: "abort",
    positionals: [threadPositional()],
    flags: [],
    render: (result, format) => {
      if (result.kind !== "json") {
        return;
      }
      if (format === "json") {
        printJson(result.data);
        return;
      }
      const data = asRecord(result.data);
      console.log(`Aborted thread ${String(data["thread_id"])}; state: ${String(data["state"] ?? "idle")}.`);
    },
  },
  coerceInput: (raw, surface) => ({ threadId: threadIdArg(raw, surface) }),
  run: async (ctx, input) => ({ kind: "json", data: await abortThread(ctx, input.threadId) }),
};

// ---- payload + rendering -----------------------------------------------------------

function answerPayload(
  answer: ThreadAnswer,
  surface: Surface,
  extra: { client_message_id?: string; files?: UploadedFile[] }
): { [key: string]: unknown } {
  const hint = answerHint(answer, surface);
  return {
    status: answer.status,
    thread_id: answer.thread_id,
    message_id: answer.message_id,
    ...(hint ? { hint } : {}),
    ...(answer.status === "completed" ? { text: answer.text ?? "", messages: answer.messages ?? [] } : {}),
    ...extra,
  };
}

function answerHint(answer: ThreadAnswer, surface: Surface): string | null {
  const id = answer.thread_id;
  if (answer.status === "pending") {
    return surface === "cli"
      ? `Not answered yet. Run "bee threads wait ${id}" to keep waiting.`
      : "Not answered yet. Call bee_wait_thread with this thread_id and message_id to keep waiting.";
  }
  if (answer.status === "stalled") {
    return surface === "cli"
      ? `The agent has reported no progress for a while. Run "bee threads wait ${id}" to check again, or "bee threads abort ${id}" and send again.`
      : "The agent has reported no progress for a while. Call bee_wait_thread to check again, or bee_abort_thread and send again.";
  }
  return null;
}

function renderAnswer(result: ActionResult, format: OutputFormat): void {
  if (result.kind !== "json") {
    return;
  }
  if (format === "json") {
    printJson(result.data);
    return;
  }
  const data = asRecord(result.data);
  const lines: string[] = [];
  if (data["status"] === "completed") {
    const text = typeof data["text"] === "string" ? data["text"].trim() : "";
    lines.push(text.length > 0 ? text : "(The agent finished without a text reply.)", "");
  }
  lines.push(`- thread_id: ${String(data["thread_id"])}`);
  lines.push(`- message_id: ${String(data["message_id"])}`);
  lines.push(`- status: ${String(data["status"])}`);
  const files = Array.isArray(data["files"]) ? data["files"] : [];
  if (files.length > 0) {
    lines.push(`- files: ${files.map((file) => String(asRecord(file)["filename"])).join(", ")}`);
  }
  if (typeof data["hint"] === "string") {
    lines.push("", data["hint"]);
  }
  console.log(lines.join("\n"));
}

function formatThreadList(payload: unknown): string {
  const threads = Array.isArray(asRecord(payload)["threads"]) ? asRecord(payload)["threads"] as unknown[] : [];
  const timeZone = resolveTimeZone(null);
  const nowMs = Date.now();
  const lines = ["# Threads", ""];
  if (threads.length === 0) {
    lines.push("- (none)");
  }
  for (const item of threads) {
    const thread = asRecord(item);
    const name = optionalString(thread["name"]) ?? "(untitled)";
    lines.push(`- ${name} (${String(thread["state"] ?? "idle")})`);
    lines.push(`  - thread_id: ${String(thread["thread_id"])}`);
    lines.push(`  - updated_at: ${formatDateValue(dateValue(thread["updated_at"]), timeZone, nowMs)}`);
  }
  return lines.join("\n");
}

function formatMessages(payload: unknown): string {
  const data = asRecord(payload);
  const messages = Array.isArray(data["messages"]) ? data["messages"] : [];
  const timeZone = resolveTimeZone(null);
  const nowMs = Date.now();
  const lines = [`# Thread ${String(data["thread_id"])}`, ""];
  if (typeof data["omitted_earlier"] === "number") {
    lines.push(`(${data["omitted_earlier"]} earlier messages omitted)`, "");
  }
  if (messages.length === 0) {
    lines.push("- (no messages)");
  }
  for (const item of messages) {
    const message = asRecord(item);
    lines.push(`## ${String(message["role"] ?? "MESSAGE")} - ${formatDateValue(dateValue(message["created_at"]), timeZone, nowMs)}`, "");
    const parts = Array.isArray(message["parts"]) ? message["parts"].map(asRecord) : [];
    const texts = parts.filter((part) => part["kind"] === "text" && typeof part["text"] === "string")
      .map((part) => String(part["text"]).trim())
      .filter((text) => text.length > 0);
    const fallback = optionalString(message["text"]);
    if (texts.length > 0) {
      lines.push(texts.join("\n\n"), "");
    } else if (fallback !== null) {
      lines.push(fallback, "");
    }
    for (const part of parts) {
      if (part["kind"] === "image" || part["kind"] === "audio" || part["kind"] === "file") {
        lines.push(`- ${String(part["kind"])}: ${String(part["filename"] ?? part["fileId"])}`);
      } else if (part["kind"] === "tool_call") {
        lines.push(`- tool call: ${String(part["name"] ?? part["id"])}`);
      }
    }
    if (lines[lines.length - 1] !== "") {
      lines.push("");
    }
  }
  return lines.join("\n").trimEnd();
}

function dateValue(value: unknown): number | string | null {
  return typeof value === "number" || typeof value === "string" ? value : null;
}

export const threadsResource: ResourceModule = {
  cliCommand: {
    name: "threads",
    description: "Chat with the Bee agent in threads: create, send (with photos/files), wait, list, read and abort. Test users only.",
    usage: USAGE,
    missingSubcommandMessage: "Missing subcommand. Use list, create, send, wait, messages, or abort.",
    unknownSubcommandPrefix: "Unknown threads subcommand: ",
  },
  actions: [listThreadsAction, createThread, sendThreadMessage, waitThread, threadMessages, abortThreadAction],
};
