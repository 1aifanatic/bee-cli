// HTTP client for the bee-server Threads developer API (docs/developer-threads.md
// in bee-server). Unlike requestClientJson it keeps the HTTP status, so a 202
// "still waiting" answer, retryable 5xx and the API error codes can be told apart.
//
// Send and wait are bounded by one overall deadline: every server wait_ms,
// every HTTP abort timeout, every retry and its backoff fit inside it. When the
// deadline hits, they return a resumable "pending" answer instead of throwing.
import type { CommandContext } from "@/commands/types";
import { requireClientToken } from "@/client/clientApi";
import { asRecord, parseJson } from "@/resources/json";
import type { LoadedAttachment } from "@/resources/threads/attachments";

// The server caps one wait at 120 s (THREAD_WAIT_MAX_MS).
export const SERVER_MAX_WAIT_MS = 120_000;

// Timing knobs; tests shorten them.
export const THREAD_TIMING = {
  // Longest wait_ms per server call. Below the server cap on purpose: `bee
  // proxy` idles a request out after 120 s by default and common load balancers
  // after 60 s, so a 120 s call could be cut before it answers. Longer waits
  // loop over several calls.
  chunkMs: 55_000,
  // A request without a deadline is abandoned (and retried) when no answer
  // arrives within its wait_ms plus this margin.
  responseMarginMs: 30_000,
  // The server is asked to answer this long before the deadline, which leaves
  // time for the response to arrive.
  responseReserveMs: 2_000,
  // The first call (the send, or the first check of a wait) gets at least this
  // long, retries included, so --timeout 0 still sends or checks once.
  minFirstCallMs: 10_000,
  // Backoff before each retry of a network error or 5xx.
  retryDelaysMs: [500, 1_000, 2_000] as readonly number[],
  // Never start wait calls closer together than this, in case a server answers
  // "pending" early.
  minPollIntervalMs: 1_000,
};

export type ThreadStatus = "completed" | "pending" | "stalled";

export type ThreadAnswer = {
  status: ThreadStatus;
  // Null only for a create whose send Bee did not confirm before the deadline.
  thread_id: string | null;
  // Null when the send was not confirmed, or a bare wait timed out before it
  // found the message to wait after.
  message_id: string | null;
  // False when Bee never confirmed the send before the deadline: it may or may
  // not have been stored. Re-sending with the same client_message_id resumes.
  confirmed: boolean;
  text?: string;
  messages?: unknown[];
};

export type UploadedFile = {
  file_id: string;
  kind: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
};

export class ThreadsApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.name = "ThreadsApiError";
    this.status = status;
    this.code = code;
  }
}

// A send or wait failed (network error, no answer in time, or 5xx after the
// retries) before the deadline, at a point where the message may already be
// stored. Carries what is known so the caller can say how to resume.
export class ThreadsInterruptedError extends Error {
  readonly threadId: string | null;
  readonly messageId: string | null;
  readonly sendConfirmed: boolean;

  constructor(message: string, known: { threadId: string | null; messageId: string | null; sendConfirmed: boolean }) {
    super(message);
    this.name = "ThreadsInterruptedError";
    this.threadId = known.threadId;
    this.messageId = known.messageId;
    this.sendConfirmed = known.sendConfirmed;
  }
}

// No HTTP answer at all: network error or client-side timeout.
class TransportError extends Error {}

// The deadline came before a request could get an answer.
class DeadlineReached extends Error {}

type Fetched = { status: number; data: unknown };

type RequestSpec = {
  method: "GET" | "POST";
  // Built per attempt, so a retry recomputes wait_ms from the time left and
  // gets a fresh multipart body.
  build: () => { query?: URLSearchParams; json?: unknown; form?: FormData; waitMs?: number; timeoutMs?: number };
};

// Client-side limit for an upload of up to 25 MB.
const UPLOAD_TIMEOUT_MS = 300_000;

// What the error message may mention about the request.
type ErrorScope = { threadId?: string; after?: string };

// ---- endpoints ----------------------------------------------------------------

export async function listThreads(ctx: CommandContext): Promise<unknown> {
  return expectOk(await request(ctx, "/v1/threads", { method: "GET", build: () => ({}) }, null), {});
}

export async function getThreadMessages(
  ctx: CommandContext,
  threadId: string,
  deadline: number | null = null
): Promise<unknown> {
  const fetched = await request(ctx, threadPath(threadId, "messages"), { method: "GET", build: () => ({}) }, deadline);
  return expectOk(fetched, { threadId });
}

export async function abortThread(ctx: CommandContext, threadId: string): Promise<unknown> {
  const fetched = await request(ctx, threadPath(threadId, "abort"), { method: "POST", build: () => ({ json: {} }) }, null);
  return expectOk(fetched, { threadId });
}

export async function uploadAttachment(ctx: CommandContext, file: LoadedAttachment): Promise<UploadedFile> {
  const fetched = await request(ctx, "/v1/threads/attachments", {
    method: "POST",
    build: () => {
      // The server reads only fields that come before the file part.
      const form = new FormData();
      if (file.width !== null && file.height !== null) {
        form.append("width", String(file.width));
        form.append("height", String(file.height));
      }
      form.append("file", new Blob([file.bytes], { type: file.contentType }), file.filename);
      return { form, timeoutMs: UPLOAD_TIMEOUT_MS };
    },
  }, null);
  const data = asRecord(expectOk(fetched, {}));
  if (typeof data["file_id"] !== "string") {
    throw new Error("The upload returned no file_id.");
  }
  return data as unknown as UploadedFile;
}

// The latest USER message of the thread: what a bare `wait` waits after.
async function latestUserMessageId(ctx: CommandContext, threadId: string, deadline: number): Promise<string> {
  const messages = asRecord(await getThreadMessages(ctx, threadId, deadline))["messages"];
  const list = Array.isArray(messages) ? messages : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = asRecord(list[index]);
    if (String(message["role"]).toUpperCase() === "USER" && typeof message["uuid"] === "string") {
      return message["uuid"];
    }
  }
  throw new Error(`Thread ${threadId} has no user message to wait after.`);
}

// ---- send and wait ------------------------------------------------------------

export type SendRequest = {
  threadId: string | null; // null creates a new thread
  text: string;
  fileIds: readonly string[];
  clientMessageId: string;
  timeoutMs: number;
  onWaiting: ((answer: ThreadAnswer) => void) | undefined;
};

// Sends one message (POST /v1/threads or /v1/threads/:id/messages), then keeps
// waiting until the answer is completed or stalled, or the overall timeout
// passes; in that last case it returns the pending answer, not an error.
// Retries reuse clientMessageId, so the server never sends the message twice.
export async function sendAndWait(ctx: CommandContext, send: SendRequest): Promise<ThreadAnswer> {
  const startedAt = Date.now();
  const deadline = startedAt + send.timeoutMs;
  const path = send.threadId === null ? "/v1/threads" : threadPath(send.threadId, "messages");
  const scope = send.threadId === null ? {} : { threadId: send.threadId };
  const unconfirmed = { threadId: send.threadId, messageId: null, sendConfirmed: false };
  let answer: ThreadAnswer;
  try {
    const fetched = await request(ctx, path, {
      method: "POST",
      build: () => {
        const waitMs = waitMsUntil(deadline);
        return {
          waitMs,
          json: {
            text: send.text,
            file_ids: [...send.fileIds],
            wait_ms: waitMs,
            client_message_id: send.clientMessageId,
          },
        };
      },
    }, firstCallDeadline(startedAt, deadline));
    answer = toAnswer(fetched, scope);
  } catch (error) {
    if (error instanceof DeadlineReached) {
      return { status: "pending", thread_id: send.threadId, message_id: null, confirmed: false };
    }
    throw interruptedOr(error, unconfirmed);
  }
  return await keepWaiting(ctx, answer, startedAt, deadline, send.onWaiting);
}

// Waits on a thread after `after`, or after its latest USER message when
// `after` is omitted.
export async function waitForAnswer(
  ctx: CommandContext,
  wait: {
    threadId: string;
    after: string | undefined;
    timeoutMs: number;
    onWaiting: ((answer: ThreadAnswer) => void) | undefined;
  }
): Promise<ThreadAnswer> {
  const startedAt = Date.now();
  const deadline = startedAt + wait.timeoutMs;
  const callDeadline = firstCallDeadline(startedAt, deadline);
  let after = wait.after ?? null;
  let answer: ThreadAnswer;
  try {
    after ??= await latestUserMessageId(ctx, wait.threadId, callDeadline);
    answer = await waitOnce(ctx, wait.threadId, after, deadline, callDeadline);
  } catch (error) {
    if (error instanceof DeadlineReached) {
      return { status: "pending", thread_id: wait.threadId, message_id: after, confirmed: true };
    }
    throw interruptedOr(error, { threadId: wait.threadId, messageId: after, sendConfirmed: true });
  }
  return await keepWaiting(ctx, answer, startedAt, deadline, wait.onWaiting);
}

// firstCallAt is when the call that produced `first` started; pacing counts
// from the start of each call, so a full-length wait is followed at once.
async function keepWaiting(
  ctx: CommandContext,
  first: ThreadAnswer,
  firstCallAt: number,
  deadline: number,
  onWaiting: ((answer: ThreadAnswer) => void) | undefined
): Promise<ThreadAnswer> {
  let answer = first;
  let notified = false;
  let lastCallAt = firstCallAt;
  const reserve = THREAD_TIMING.responseReserveMs;
  while (answer.status === "pending" && deadline - Date.now() > reserve) {
    const threadId = answer.thread_id;
    const messageId = answer.message_id;
    if (threadId === null || messageId === null) {
      break;
    }
    if (!notified) {
      onWaiting?.(answer);
      notified = true;
    }
    const pause = Math.min(THREAD_TIMING.minPollIntervalMs - (Date.now() - lastCallAt), deadline - Date.now() - reserve);
    if (pause > 0) {
      await sleep(pause);
    }
    if (deadline - Date.now() <= reserve) {
      break;
    }
    lastCallAt = Date.now();
    try {
      answer = await waitOnce(ctx, threadId, messageId, deadline, deadline);
    } catch (error) {
      if (error instanceof DeadlineReached) {
        break;
      }
      throw interruptedOr(error, { threadId, messageId, sendConfirmed: true });
    }
  }
  return answer;
}

async function waitOnce(
  ctx: CommandContext,
  threadId: string,
  after: string,
  deadline: number,
  callDeadline: number
): Promise<ThreadAnswer> {
  const fetched = await request(ctx, threadPath(threadId, "wait"), {
    method: "GET",
    build: () => {
      const waitMs = waitMsUntil(deadline);
      return { waitMs, query: new URLSearchParams({ after, wait_ms: String(waitMs) }) };
    },
  }, callDeadline);
  return toAnswer(fetched, { threadId, after });
}

function firstCallDeadline(startedAt: number, deadline: number): number {
  return Math.max(deadline, startedAt + THREAD_TIMING.minFirstCallMs);
}

// wait_ms for the next server call: the time left minus the response reserve,
// capped per call.
function waitMsUntil(deadline: number): number {
  const remaining = deadline - Date.now() - THREAD_TIMING.responseReserveMs;
  return Math.floor(Math.max(0, Math.min(remaining, THREAD_TIMING.chunkMs, SERVER_MAX_WAIT_MS)));
}

// Network errors and 5xx after the retries become ThreadsInterruptedError,
// because the message may already be stored. API errors (4xx, 503
// agent_unavailable) are definitive and pass through.
function interruptedOr(
  error: unknown,
  known: { threadId: string | null; messageId: string | null; sendConfirmed: boolean }
): unknown {
  const transient = error instanceof TransportError ||
    (error instanceof ThreadsApiError && error.status >= 500 && error.code !== "agent_unavailable");
  return transient ? new ThreadsInterruptedError((error as Error).message, known) : error;
}

function toAnswer(fetched: Fetched, scope: ErrorScope): ThreadAnswer {
  const data = asRecord(expectOk(fetched, scope));
  const status = data["status"];
  if (
    (status !== "completed" && status !== "pending" && status !== "stalled") ||
    typeof data["thread_id"] !== "string" ||
    typeof data["message_id"] !== "string"
  ) {
    throw new Error("Invalid thread response.");
  }
  const answer: ThreadAnswer = { status, thread_id: data["thread_id"], message_id: data["message_id"], confirmed: true };
  if (status === "completed") {
    answer.text = typeof data["text"] === "string" ? data["text"] : "";
    answer.messages = Array.isArray(data["messages"]) ? data["messages"] : [];
  }
  return answer;
}

// ---- transport ------------------------------------------------------------------

function threadPath(threadId: string, action: "messages" | "wait" | "abort"): string {
  return `/v1/threads/${encodeURIComponent(threadId)}/${action}`;
}

// One logical request: retried on network errors and 5xx (except a definitive
// 503 agent_unavailable), with backoff. Returns the last HTTP answer, or throws
// TransportError once retries are used up on network errors. With a deadline,
// each attempt's abort timeout ends at the deadline, and when no attempt (or
// backoff) fits before it, DeadlineReached is thrown instead.
async function request(ctx: CommandContext, path: string, spec: RequestSpec, deadline: number | null): Promise<Fetched> {
  const token = await requireClientToken(ctx);
  const delays = THREAD_TIMING.retryDelaysMs;
  for (let attempt = 0; ; attempt += 1) {
    const isLast = attempt >= delays.length;
    const budget = deadline === null ? null : deadline - Date.now();
    if (budget !== null && budget <= 0) {
      throw new DeadlineReached("The deadline passed.");
    }
    try {
      const fetched = await fetchOnce(ctx, path, spec, token, budget);
      if (!isRetryable(fetched) || isLast) {
        return fetched;
      }
    } catch (error) {
      if (!(error instanceof TransportError)) {
        throw error;
      }
      if (deadline !== null && Date.now() >= deadline) {
        throw new DeadlineReached(error.message);
      }
      if (isLast) {
        throw error;
      }
    }
    const delay = delays[attempt] ?? 0;
    if (deadline !== null && Date.now() + delay >= deadline) {
      throw new DeadlineReached("No time left to retry.");
    }
    await sleep(delay);
  }
}

async function fetchOnce(
  ctx: CommandContext,
  path: string,
  spec: RequestSpec,
  token: string | null,
  budget: number | null
): Promise<Fetched> {
  const built = spec.build();
  const headers = new Headers();
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  let body: string | FormData | undefined;
  if (built.json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(built.json);
  } else if (built.form !== undefined) {
    body = built.form; // fetch sets the multipart boundary
  }
  const query = built.query?.toString();
  const limit = built.timeoutMs ?? (built.waitMs ?? 0) + THREAD_TIMING.responseMarginMs;
  const timeoutMs = budget === null ? limit : Math.max(1, Math.min(limit, budget));
  let response: Response;
  let text: string;
  try {
    response = await ctx.client.fetch(query ? `${path}?${query}` : path, {
      method: spec.method,
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await response.text();
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new TransportError(`Bee did not answer within ${Math.round(timeoutMs / 1000)} s.`);
    }
    throw new TransportError(`Could not reach Bee: ${error instanceof Error ? error.message : "network error"}`);
  }
  return { status: response.status, data: text ? parseJson(text) : null };
}

function isRetryable(fetched: Fetched): boolean {
  return fetched.status >= 500 && errorCode(fetched.data) !== "agent_unavailable";
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

// ---- errors -------------------------------------------------------------------

function expectOk(fetched: Fetched, scope: ErrorScope): unknown {
  if (fetched.status >= 200 && fetched.status < 300) {
    return fetched.data;
  }
  const code = errorCode(fetched.data);
  const serverMessage = asRecord(fetched.data)["message"];
  throw new ThreadsApiError(
    threadsErrorMessage(fetched.status, code, typeof serverMessage === "string" ? serverMessage : null, scope),
    fetched.status,
    code
  );
}

function errorCode(data: unknown): string | null {
  const error = asRecord(data)["error"];
  return typeof error === "string" ? error : null;
}

export function threadsErrorMessage(
  status: number,
  code: string | null,
  serverMessage: string | null,
  scope: ErrorScope
): string {
  const thread = scope.threadId ? `Thread ${scope.threadId}` : "The thread";
  switch (code) {
    case "test_user_required":
      return "Threads are available to Bee test users only, and this account is not one (test_user_required).";
    case "agent_vm_consent_required":
      return "Attachments need the Bee agent consent. Turn on the Bee agent in the Bee app, then try again (agent_vm_consent_required).";
    case "agent_unavailable":
      return `The Bee agent is unavailable right now, so nothing was sent. Try again later (agent_unavailable)${serverMessage ? `: ${serverMessage}` : "."}`;
    case "thread_not_found":
      return `${thread} was not found. It may not exist or may belong to another account (thread_not_found).`;
    case "text_or_files_required":
      return "Provide message text or at least one photo or file (text_or_files_required).";
    case "invalid_file_ids":
      return "One or more file ids are invalid: each must be a new upload of this account that is not attached to a message yet (invalid_file_ids).";
    case "message_not_in_thread":
      return `Message ${scope.after ?? "(after)"} is not in ${scope.threadId ? `thread ${scope.threadId}` : "this thread"} (message_not_in_thread).`;
    default:
      break;
  }
  // Fastify's own 404 for a route this server does not have.
  if (status === 404 && serverMessage !== null && /^Route \S+ not found$/.test(serverMessage)) {
    return `This Bee server does not have the Threads API yet (${serverMessage}).`;
  }
  const detail = serverMessage ?? code;
  return detail ? `Bee request failed with status ${status}: ${detail}` : `Bee request failed with status ${status}.`;
}
