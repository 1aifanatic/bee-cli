import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandContext } from "@/commands/types";
import { createProxyClient } from "@/client";
import { threadsCommand } from "@/commands/threads";
import { callBeeTool } from "@/mcp/toolRegistry";
import { THREAD_TIMING, threadsErrorMessage } from "@/resources/threads/api";
import { parseDuration } from "@/resources/threads";

type BunServer = ReturnType<typeof Bun.serve>;

type Seen = { method: string; path: string; query: URLSearchParams; body: string; contentType: string; at: number };

const activeServers: BunServer[] = [];
const DEFAULT_TIMING = { ...THREAD_TIMING, retryDelaysMs: [...THREAD_TIMING.retryDelaysMs] };

beforeEach(() => {
  // Fast loops: short server calls, quick retries, no poll pacing.
  THREAD_TIMING.chunkMs = 300;
  THREAD_TIMING.responseMarginMs = 2_000;
  THREAD_TIMING.retryDelaysMs = [5, 5, 5];
  THREAD_TIMING.minPollIntervalMs = 0;
  THREAD_TIMING.responseReserveMs = 50;
  THREAD_TIMING.minFirstCallMs = 500;
});

afterEach(() => {
  Object.assign(THREAD_TIMING, DEFAULT_TIMING);
  for (const server of activeServers.splice(0, activeServers.length)) {
    server.stop(true);
  }
});

function mockBee(handler: (seen: Seen, index: number) => Response | Promise<Response>): { ctx: CommandContext; seen: Seen[] } {
  const seen: Seen[] = [];
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      const entry: Seen = {
        at: Date.now(),
        method: request.method,
        path: url.pathname,
        query: url.searchParams,
        body: request.method === "GET" ? "" : await request.text(),
        contentType: request.headers.get("content-type") ?? "",
      };
      seen.push(entry);
      return await handler(entry, seen.length - 1);
    },
  });
  activeServers.push(upstream);
  return {
    ctx: { env: "prod", client: createProxyClient("prod", { address: `http://127.0.0.1:${upstream.port}` }) },
    seen,
  };
}

function captureOutput(): { logs: string[]; errors: string[]; restore: () => void } {
  const logs: string[] = [];
  const errors: string[] = [];
  const logSpy = spyOn(console, "log").mockImplementation((...args) => {
    logs.push(args.join(" "));
  });
  const errSpy = spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    errors.push(String(chunk));
    return true;
  });
  return { logs, errors, restore: () => { logSpy.mockRestore(); errSpy.mockRestore(); } };
}

async function runCli(ctx: CommandContext, args: string[]): Promise<{ logs: string[]; errors: string[] }> {
  const output = captureOutput();
  try {
    await threadsCommand.run(args, ctx);
  } finally {
    output.restore();
  }
  return { logs: output.logs, errors: output.errors };
}

async function runCliJson(ctx: CommandContext, args: string[]): Promise<Record<string, unknown>> {
  const { logs } = await runCli(ctx, [...args, "--json"]);
  return JSON.parse(logs.join("\n")) as Record<string, unknown>;
}

async function callTool(ctx: CommandContext, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await callBeeTool(ctx, name, args);
  const first = result.content[0];
  if (!first || first.type !== "text") {
    throw new Error("expected text content");
  }
  return JSON.parse(first.text) as Record<string, unknown>;
}

function bodyOf(seen: Seen): Record<string, unknown> {
  return JSON.parse(seen.body) as Record<string, unknown>;
}

const completed = (threadId = "t1", messageId = "m1") => Response.json({
  status: "completed",
  thread_id: threadId,
  message_id: messageId,
  text: "Here is your plan.",
  messages: [{ uuid: "a1", role: "ASSISTANT", parts: [{ kind: "text", text: "Here is your plan." }] }],
});
const waiting = (status: "pending" | "stalled" = "pending", threadId = "t1", messageId = "m1") =>
  Response.json({ status, thread_id: threadId, message_id: messageId }, { status: 202 });

function pngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const data = new DataView(bytes.buffer);
  data.setUint32(16, width);
  data.setUint32(20, height);
  return bytes;
}

describe("threads CLI argument coercion", () => {
  it("requires a subcommand", async () => {
    const { ctx } = mockBee(() => Response.json({}));
    await expect(threadsCommand.run([], ctx)).rejects.toThrow("Missing subcommand. Use list, create, send, wait, messages, or abort.");
  });

  it("requires a thread id for send, wait, messages and abort", async () => {
    const { ctx } = mockBee(() => Response.json({}));
    for (const sub of ["send", "wait", "messages", "abort"]) {
      await expect(threadsCommand.run([sub], ctx)).rejects.toThrow("Provide exactly one thread id.");
    }
  });

  it("requires text or a file", async () => {
    const { ctx, seen } = mockBee(() => Response.json({}));
    await expect(threadsCommand.run(["create"], ctx)).rejects.toThrow("Provide --text or at least one --photo/--file.");
    await expect(threadsCommand.run(["send", "t1"], ctx)).rejects.toThrow("Provide --text or at least one --photo/--file.");
    expect(seen.length).toBe(0);
  });

  it("parses --timeout durations and rejects bad ones", async () => {
    expect(parseDuration("90", "--timeout")).toBe(90_000);
    expect(parseDuration("90s", "--timeout")).toBe(90_000);
    expect(parseDuration("1.5m", "--timeout")).toBe(90_000);
    expect(parseDuration("500ms", "--timeout")).toBe(500);
    expect(parseDuration("2h", "--timeout")).toBe(7_200_000);
    expect(parseDuration("0", "--timeout")).toBe(0);
    expect(() => parseDuration("soon", "--timeout")).toThrow("--timeout must be a duration like 30s, 5m or 1h");
    expect(() => parseDuration("-5s", "--timeout")).toThrow("--timeout must be a duration like 30s, 5m or 1h");
    expect(() => parseDuration("25h", "--timeout")).toThrow("--timeout must be at most 24h");
  });

  it("rejects a malformed --client-message-id", async () => {
    const { ctx } = mockBee(() => Response.json({}));
    await expect(threadsCommand.run(["create", "--text", "hi", "--client-message-id", "has space"], ctx))
      .rejects.toThrow("--client-message-id must be 1-128 characters of A-Z a-z 0-9 . _ : -");
  });

  it("rejects a non-image --photo before uploading anything", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bee-threads-"));
    const png = join(dir, "ok.png");
    const doc = join(dir, "notes.pdf");
    writeFileSync(png, pngBytes(1, 1));
    writeFileSync(doc, "%PDF");
    const { ctx, seen } = mockBee(() => Response.json({}));
    await expect(threadsCommand.run(["create", "--photo", png, "--photo", doc], ctx))
      .rejects.toThrow(`--photo expects an image (jpg, png, gif, webp, heic): ${doc}. Use --file for other files.`);
    expect(seen.length).toBe(0);
  });

  it("sends the CLI default timeout as wait_ms capped per call, and an explicit --timeout 0", async () => {
    THREAD_TIMING.chunkMs = 55_000;
    const { ctx, seen } = mockBee(() => completed());
    await runCliJson(ctx, ["send", "t1", "--text", "hi"]);
    expect(bodyOf(seen[0]!)["wait_ms"]).toBe(55_000);
    await runCliJson(ctx, ["send", "t1", "--text", "hi", "--timeout", "0"]);
    expect(bodyOf(seen[1]!)["wait_ms"]).toBe(0);
  });
});

describe("threads MCP argument coercion", () => {
  it("defaults timeout_seconds to 45 and clamps it", async () => {
    THREAD_TIMING.chunkMs = 120_000;
    THREAD_TIMING.responseReserveMs = 2_000;
    const { ctx, seen } = mockBee(() => completed());
    const waitMs = (index: number) => Number(bodyOf(seen[index]!)["wait_ms"]);
    // The server is asked to answer the reserve before the deadline.
    await callTool(ctx, "bee_send_thread_message", { thread_id: "t1", text: "hi" });
    expect(waitMs(0)).toBeGreaterThan(42_900);
    expect(waitMs(0)).toBeLessThanOrEqual(43_000);
    await callTool(ctx, "bee_send_thread_message", { thread_id: "t1", text: "hi", timeout_seconds: -3 });
    expect(waitMs(1)).toBe(0);
    await callTool(ctx, "bee_send_thread_message", { thread_id: "t1", text: "hi", timeout_seconds: "100" });
    expect(waitMs(2)).toBeGreaterThan(97_900);
    expect(waitMs(2)).toBeLessThanOrEqual(98_000);
  });

  it("requires thread_id and text or files", async () => {
    const { ctx } = mockBee(() => Response.json({}));
    await expect(callBeeTool(ctx, "bee_send_thread_message", { text: "hi" })).rejects.toThrow("Missing thread_id.");
    await expect(callBeeTool(ctx, "bee_create_thread", {})).rejects.toThrow("Provide text or at least one file (file_paths or inline_files).");
  });

  it("validates file_paths and inline_files items", async () => {
    const { ctx } = mockBee(() => Response.json({}));
    await expect(callBeeTool(ctx, "bee_create_thread", { file_paths: [1] })).rejects.toThrow("file_paths must be an array of non-empty strings.");
    await expect(callBeeTool(ctx, "bee_create_thread", { inline_files: [{ data: "eA==" }] })).rejects.toThrow("inline_files[0] needs base64 data and a filename.");
    await expect(callBeeTool(ctx, "bee_create_thread", { file_paths: Array.from({ length: 21 }, (_v, i) => `f${i}`) }))
      .rejects.toThrow("At most 20 photos or files per message.");
  });

  it("generates a client_message_id or uses the caller's", async () => {
    const { ctx, seen } = mockBee(() => completed());
    const generated = await callTool(ctx, "bee_create_thread", { text: "hi" });
    expect(String(bodyOf(seen[0]!)["client_message_id"])).toMatch(/^bee-cli-[0-9a-f-]{36}$/);
    expect(generated["client_message_id"]).toBe(bodyOf(seen[0]!)["client_message_id"]);
    await callTool(ctx, "bee_create_thread", { text: "hi", client_message_id: "mine-1" });
    expect(bodyOf(seen[1]!)["client_message_id"]).toBe("mine-1");
  });

  it("puts status, thread_id and message_id at the top level with a wait hint", async () => {
    const { ctx } = mockBee(() => waiting("pending", "t9", "m9"));
    const result = await callTool(ctx, "bee_send_thread_message", { thread_id: "t9", text: "hi", timeout_seconds: 0 });
    expect(Object.keys(result).slice(0, 3)).toEqual(["status", "thread_id", "message_id"]);
    expect(result).toMatchObject({ status: "pending", thread_id: "t9", message_id: "m9" });
    expect(String(result["hint"])).toContain("bee_wait_thread");
  });

  it("limits bee_get_thread_messages to the latest 50 by default", async () => {
    const messages = Array.from({ length: 60 }, (_v, i) => ({ uuid: `u${i}`, role: "USER", parts: [] }));
    const { ctx } = mockBee(() => Response.json({ thread_id: "t1", messages }));
    const result = await callTool(ctx, "bee_get_thread_messages", { thread_id: "t1" });
    expect((result["messages"] as unknown[]).length).toBe(50);
    expect(result["omitted_earlier"]).toBe(10);
    expect((result["messages"] as Array<{ uuid: string }>)[0]!.uuid).toBe("u10");
  });
});

describe("threads send and wait", () => {
  it("creates a thread and returns the answer with text first in markdown", async () => {
    const { ctx, seen } = mockBee(() => completed("t-new", "m-new"));
    const { logs } = await runCli(ctx, ["create", "--text", "Plan my trip"]);
    expect(seen[0]).toMatchObject({ method: "POST", path: "/v1/threads" });
    expect(bodyOf(seen[0]!)).toMatchObject({ text: "Plan my trip", file_ids: [] });
    const output = logs.join("\n");
    expect(output.startsWith("Here is your plan.")).toBe(true);
    expect(output).toContain("- thread_id: t-new");
    expect(output).toContain("- message_id: m-new");
    expect(output).toContain("- status: completed");
  });

  it("keeps waiting after a pending send until completed", async () => {
    const { ctx, seen } = mockBee((request) => {
      if (request.path === "/v1/threads") {
        return waiting("pending", "t1", "m1");
      }
      return seen.length < 3 ? waiting("pending", "t1", "m1") : completed("t1", "m1");
    });
    const data = await runCliJson(ctx, ["create", "--text", "hi", "--timeout", "5s"]);
    expect(data).toMatchObject({ status: "completed", thread_id: "t1", message_id: "m1", text: "Here is your plan." });
    expect(seen.map((entry) => `${entry.method} ${entry.path}`)).toEqual([
      "POST /v1/threads",
      "GET /v1/threads/t1/wait",
      "GET /v1/threads/t1/wait",
    ]);
    expect(seen[1]!.query.get("after")).toBe("m1");
  });

  it("returns pending with a wait hint (not an error) when the overall timeout passes", async () => {
    // Behaves like the server: a wait holds the request for wait_ms, then answers 202.
    const { ctx, seen } = mockBee(async (request) => {
      const waitMs = request.method === "GET"
        ? Number(request.query.get("wait_ms"))
        : Number(bodyOf(request)["wait_ms"]);
      await Bun.sleep(waitMs);
      return waiting("pending", "t1", "m1");
    });
    const started = Date.now();
    const { logs, errors } = await runCli(ctx, ["send", "t1", "--text", "hi", "--timeout", "1s"]);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(2_000);
    const waits = seen.map((entry) => entry.method === "GET" ? Number(entry.query.get("wait_ms")) : Number(bodyOf(entry)["wait_ms"]));
    expect(waits.every((ms) => ms <= 300)).toBe(true);
    expect(waits.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(1_000);
    expect(seen.length).toBeGreaterThanOrEqual(4);
    const output = logs.join("\n");
    expect(output).toContain("- status: pending");
    expect(output).toContain('Run "bee threads wait t1" to keep waiting.');
    expect(errors.join("")).toContain("Waiting for the answer on thread t1...");
  });

  it("sends without waiting for --timeout 0", async () => {
    const { ctx, seen } = mockBee(() => waiting("pending", "t1", "m1"));
    const data = await runCliJson(ctx, ["send", "t1", "--text", "hi", "--timeout", "0"]);
    expect(data).toMatchObject({ status: "pending", thread_id: "t1", message_id: "m1" });
    expect(seen.length).toBe(1);
  });

  it("stops waiting when the thread is stalled", async () => {
    const { ctx, seen } = mockBee((request) => request.method === "POST" ? waiting("pending") : waiting("stalled"));
    const data = await runCliJson(ctx, ["send", "t1", "--text", "hi", "--timeout", "10s"]);
    expect(data["status"]).toBe("stalled");
    expect(String(data["hint"])).toContain("bee threads abort t1");
    expect(seen.length).toBe(2);
  });
});

describe("threads wait pacing", () => {
  const holdThenPending = async (request: Seen) => {
    const waitMs = request.method === "GET" ? Number(request.query.get("wait_ms")) : Number(bodyOf(request)["wait_ms"]);
    await Bun.sleep(waitMs);
    return waiting("pending", "t1", "m1");
  };

  it("starts the next wait at once after a full-length call", async () => {
    THREAD_TIMING.chunkMs = 500;
    THREAD_TIMING.minPollIntervalMs = 400;
    const { ctx, seen } = mockBee(holdThenPending);
    await runCliJson(ctx, ["send", "t1", "--text", "hi", "--timeout", "800ms"]);
    expect(seen.length).toBe(2);
    // The send held 500 ms, longer than the poll interval: no extra pause.
    expect(seen[1]!.at - seen[0]!.at).toBeLessThan(750);
  });

  it("spaces out wait calls when the server answers pending early", async () => {
    THREAD_TIMING.minPollIntervalMs = 200;
    const { ctx, seen } = mockBee(() => waiting("pending", "t1", "m1"));
    await runCliJson(ctx, ["wait", "t1", "--after", "m1", "--timeout", "1s"]);
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(seen.length).toBeLessThanOrEqual(7);
  });
});

describe("threads overall deadline", () => {
  // Real-world margins: without the deadline these would let one call run
  // for wait_ms + 30 s and retry after that.
  beforeEach(() => {
    THREAD_TIMING.responseMarginMs = 30_000;
    THREAD_TIMING.retryDelaysMs = [400, 400, 400];
  });

  it("returns a resumable pending result when a wait never answers", async () => {
    const { ctx } = mockBee(async (request) => {
      if (request.method === "POST") {
        return waiting("pending", "t1", "m1");
      }
      await Bun.sleep(5_000);
      return completed();
    });
    const started = Date.now();
    const result = await callTool(ctx, "bee_send_thread_message", { thread_id: "t1", text: "hi", timeout_seconds: 1, client_message_id: "k-1" });
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(result).toMatchObject({ status: "pending", thread_id: "t1", message_id: "m1", client_message_id: "k-1" });
    expect(String(result["hint"])).toContain("bee_wait_thread");
  });

  it("returns an unconfirmed pending result when the send never answers", async () => {
    const { ctx } = mockBee(async () => {
      await Bun.sleep(5_000);
      return completed();
    });
    const started = Date.now();
    const { logs } = await runCli(ctx, ["create", "--text", "hi", "--timeout", "1s", "--client-message-id", "k-2"]);
    expect(Date.now() - started).toBeLessThan(1_500);
    const output = logs.join("\n");
    expect(output).toContain("- thread_id: (not confirmed)");
    expect(output).toContain("- message_id: (not confirmed)");
    expect(output).toContain("- status: pending");
    expect(output).toContain("Re-run the same command with --client-message-id k-2 to resume; it will not send twice.");
  });

  it("stops retrying 5xx when the backoff would pass the deadline", async () => {
    const { ctx, seen } = mockBee((request) =>
      request.method === "POST" ? waiting("pending", "t1", "m1") : Response.json({ error: "internal" }, { status: 500 })
    );
    const started = Date.now();
    const data = await runCliJson(ctx, ["send", "t1", "--text", "hi", "--timeout", "1s"]);
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(data).toMatchObject({ status: "pending", thread_id: "t1", message_id: "m1" });
    expect(seen.length).toBeLessThanOrEqual(4);
  });

  it("still sends with --timeout 0 when the first attempt fails", async () => {
    THREAD_TIMING.retryDelaysMs = [5, 5, 5];
    const { ctx, seen } = mockBee((_request, index) => index === 0 ? new Response("oops", { status: 502 }) : waiting("pending", "t1", "m1"));
    const data = await runCliJson(ctx, ["send", "t1", "--text", "hi", "--timeout", "0"]);
    expect(data).toMatchObject({ status: "pending", message_id: "m1" });
    expect(seen.length).toBe(2);
  });
});

describe("threads client_message_id surfacing", () => {
  it("shows client_message_id in markdown output", async () => {
    const { ctx } = mockBee(() => completed());
    const { logs } = await runCli(ctx, ["create", "--text", "hi"]);
    expect(logs.join("\n")).toMatch(/- client_message_id: bee-cli-[0-9a-f-]{36}/);
  });

  it("names the key to resume with when the send may have committed (CLI)", async () => {
    const { ctx } = mockBee(() => Response.json({ error: "internal" }, { status: 500 }));
    await expect(threadsCommand.run(["send", "t1", "--text", "hi", "--client-message-id", "k-3"], ctx)).rejects.toThrow(
      "Bee request failed with status 500: internal The message may have been sent. Re-run the same command with --client-message-id k-3 to resume without sending twice."
    );
  });

  it("names the generated key when the send may have committed (MCP)", async () => {
    const { ctx, seen } = mockBee(() => Response.json({ error: "internal" }, { status: 500 }));
    const failure = await callBeeTool(ctx, "bee_create_thread", { text: "hi" }).then(() => null, (error: Error) => error.message);
    const key = String(bodyOf(seen[0]!)["client_message_id"]);
    expect(failure).toContain(`Call the same tool again with client_message_id "${key}" to resume without sending twice.`);
  });

  it("says how to keep waiting when a wait fails after a confirmed send", async () => {
    const { ctx } = mockBee((request) =>
      request.method === "POST" ? waiting("pending", "t1", "m1") : Response.json({ error: "internal" }, { status: 500 })
    );
    await expect(threadsCommand.run(["send", "t1", "--text", "hi", "--timeout", "30s", "--client-message-id", "k-4"], ctx)).rejects.toThrow(
      'The message (client_message_id k-4) was sent. Run "bee threads wait t1 --after m1" to keep waiting.'
    );
  });
});

describe("threads wait `after` resolution", () => {
  const history = {
    thread_id: "t1",
    messages: [
      { uuid: "u1", role: "USER", parts: [] },
      { uuid: "a1", role: "ASSISTANT", parts: [] },
      { uuid: "u2", role: "USER", parts: [] },
      { uuid: "a2", role: "ASSISTANT", parts: [] },
    ],
  };

  it("waits after the latest USER message when --after is omitted", async () => {
    const { ctx, seen } = mockBee((request) => request.path.endsWith("/messages") ? Response.json(history) : completed("t1", "u2"));
    const data = await runCliJson(ctx, ["wait", "t1"]);
    expect(seen.map((entry) => entry.path)).toEqual(["/v1/threads/t1/messages", "/v1/threads/t1/wait"]);
    expect(seen[1]!.query.get("after")).toBe("u2");
    expect(data["status"]).toBe("completed");
  });

  it("uses an explicit --after / message_id without reading history", async () => {
    const { ctx, seen } = mockBee(() => completed("t1", "u1"));
    await runCliJson(ctx, ["wait", "t1", "--after", "u1"]);
    await callTool(ctx, "bee_wait_thread", { thread_id: "t1", message_id: "u1" });
    expect(seen.map((entry) => entry.path)).toEqual(["/v1/threads/t1/wait", "/v1/threads/t1/wait"]);
    expect(seen.every((entry) => entry.query.get("after") === "u1")).toBe(true);
  });

  it("fails clearly when the thread has no user message", async () => {
    const { ctx } = mockBee(() => Response.json({ thread_id: "t1", messages: [{ uuid: "a1", role: "ASSISTANT", parts: [] }] }));
    await expect(threadsCommand.run(["wait", "t1"], ctx)).rejects.toThrow("Thread t1 has no user message to wait after.");
  });
});

describe("threads retries", () => {
  it("retries 5xx with the same client_message_id", async () => {
    const { ctx, seen } = mockBee((_request, index) =>
      index === 0 ? new Response("oops", { status: 500 }) : index === 1 ? Response.json({ error: "bad_gateway" }, { status: 502 }) : completed()
    );
    const data = await runCliJson(ctx, ["create", "--text", "hi"]);
    expect(data["status"]).toBe("completed");
    expect(seen.length).toBe(3);
    const ids = seen.map((entry) => bodyOf(entry)["client_message_id"]);
    expect(new Set(ids).size).toBe(1);
    expect(data["client_message_id"]).toBe(ids[0]);
  });

  it("retries a request that got no answer in time with the same client_message_id", async () => {
    THREAD_TIMING.responseMarginMs = 150;
    const { ctx, seen } = mockBee(async (_request, index) => {
      if (index === 0) {
        await Bun.sleep(600);
      }
      return completed();
    });
    const data = await runCliJson(ctx, ["send", "t1", "--text", "hi", "--timeout", "0", "--client-message-id", "retry-1"]);
    expect(data["status"]).toBe("completed");
    expect(seen.map((entry) => bodyOf(entry)["client_message_id"])).toEqual(["retry-1", "retry-1"]);
  });

  it("reports a request that never answers after the retries", async () => {
    THREAD_TIMING.responseMarginMs = 50;
    const { ctx, seen } = mockBee(async () => {
      await Bun.sleep(300);
      return Response.json({ threads: [] });
    });
    await expect(threadsCommand.run(["list"], ctx)).rejects.toThrow("Bee did not answer within 0 s.");
    expect(seen.length).toBe(4);
  });

  it("gives up after the retries and reports the last 5xx", async () => {
    const { ctx, seen } = mockBee(() => Response.json({ error: "internal" }, { status: 500 }));
    await expect(threadsCommand.run(["list"], ctx)).rejects.toThrow("Bee request failed with status 500: internal");
    expect(seen.length).toBe(4);
  });

  it("does not retry 503 agent_unavailable", async () => {
    const { ctx, seen } = mockBee(() => Response.json({ error: "agent_unavailable", message: "Agent is offline" }, { status: 503 }));
    await expect(threadsCommand.run(["send", "t1", "--text", "hi"], ctx))
      .rejects.toThrow("The Bee agent is unavailable right now, so nothing was sent. Try again later (agent_unavailable): Agent is offline");
    expect(seen.length).toBe(1);
  });
});

describe("threads attachments", () => {
  it("uploads each file first, then sends their file_ids", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bee-threads-"));
    const photo = join(dir, "Photo 1.png");
    const doc = join(dir, "notes.txt");
    writeFileSync(photo, pngBytes(640, 480));
    writeFileSync(doc, "hello");
    let uploads = 0;
    const { ctx, seen } = mockBee((request) => {
      if (request.path === "/v1/threads/attachments") {
        uploads += 1;
        return Response.json({ file_id: `f${uploads}`, kind: "image", filename: "x", content_type: "x", size_bytes: 1, width: null, height: null });
      }
      return completed("t1", "m1");
    });
    const data = await runCliJson(ctx, ["send", "t1", "--photo", photo, "--file", doc, "--text", "look"]);
    expect(seen.map((entry) => `${entry.method} ${entry.path}`)).toEqual([
      "POST /v1/threads/attachments",
      "POST /v1/threads/attachments",
      "POST /v1/threads/t1/messages",
    ]);
    expect(bodyOf(seen[2]!)["file_ids"]).toEqual(["f1", "f2"]);
    expect((data["files"] as unknown[]).length).toBe(2);

    // Multipart: width/height come before the file part, which carries name and type.
    const image = seen[0]!;
    expect(image.contentType).toStartWith("multipart/form-data");
    expect(image.body.indexOf('name="width"')).toBeLessThan(image.body.indexOf('name="file"'));
    expect(image.body).toContain("640");
    expect(image.body).toContain('filename="Photo 1.png"');
    expect(image.body).toContain("Content-Type: image/png");
    const text = seen[1]!;
    expect(text.body).not.toContain('name="width"');
    expect(text.body).toContain("Content-Type: text/plain");
  });

  it("uploads MCP inline files", async () => {
    const { ctx, seen } = mockBee((request) =>
      request.path === "/v1/threads/attachments"
        ? Response.json({ file_id: "f1", kind: "image", filename: "a.png", content_type: "image/png", size_bytes: 33, width: 2, height: 2 })
        : completed()
    );
    const data = Buffer.from(pngBytes(2, 2)).toString("base64");
    await callTool(ctx, "bee_create_thread", { inline_files: [{ data, filename: "a.png" }] });
    expect(seen[0]!.body).toContain('filename="a.png"');
    expect(bodyOf(seen[1]!)).toMatchObject({ text: "", file_ids: ["f1"] });
  });

  it("rejects an oversized file before uploading anything", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bee-threads-"));
    const big = join(dir, "big.png");
    writeFileSync(big, "");
    truncateSync(big, 25 * 1024 * 1024 + 1); // sparse: no 25 MB write
    const small = join(dir, "small.png");
    writeFileSync(small, pngBytes(1, 1));
    const { ctx, seen } = mockBee(() => Response.json({}));
    await expect(threadsCommand.run(["create", "--photo", small, "--photo", big], ctx)).rejects.toThrow(`File too large (max 25 MB): ${big}`);
    expect(seen.length).toBe(0);
  });

  it("rejects a missing file before uploading anything", async () => {
    const { ctx, seen } = mockBee(() => Response.json({}));
    await expect(threadsCommand.run(["create", "--file", "/nonexistent/notes.pdf"], ctx)).rejects.toThrow("Cannot read /nonexistent/notes.pdf: no such file");
    expect(seen.length).toBe(0);
  });

  it("uploads a file of unknown type as application/octet-stream", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bee-threads-"));
    const blob = join(dir, "data.xyz");
    writeFileSync(blob, "bytes");
    const { ctx, seen } = mockBee((request) =>
      request.path === "/v1/threads/attachments"
        ? Response.json({ file_id: "f1", kind: "file", filename: "data.xyz", content_type: "application/octet-stream", size_bytes: 5, width: null, height: null })
        : completed()
    );
    await runCliJson(ctx, ["create", "--file", blob]);
    expect(seen[0]!.body).toContain("Content-Type: application/octet-stream");
  });

  it("does not send when a later upload fails, and says which file failed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bee-threads-"));
    const photo = join(dir, "a.png");
    const doc = join(dir, "notes.txt");
    writeFileSync(photo, pngBytes(1, 1));
    writeFileSync(doc, "hello");
    const { ctx, seen } = mockBee((_request, index) =>
      index === 0
        ? Response.json({ file_id: "f1", kind: "image", filename: "a.png", content_type: "image/png", size_bytes: 33, width: 1, height: 1 })
        : Response.json({ error: "Uploaded file is empty" }, { status: 400 })
    );
    await expect(threadsCommand.run(["create", "--photo", photo, "--file", doc, "--text", "x"], ctx)).rejects.toThrow(
      "Could not upload notes.txt (file 2 of 2), so nothing was sent. Bee request failed with status 400: Uploaded file is empty"
    );
    expect(seen.map((entry) => entry.path)).toEqual(["/v1/threads/attachments", "/v1/threads/attachments"]);
  });

  it("maps agent_vm_consent_required and does not send", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bee-threads-"));
    const photo = join(dir, "a.png");
    writeFileSync(photo, pngBytes(1, 1));
    const { ctx, seen } = mockBee(() => Response.json({ error: "agent_vm_consent_required" }, { status: 403 }));
    await expect(threadsCommand.run(["create", "--photo", photo], ctx))
      .rejects.toThrow("Attachments need the Bee agent consent. Turn on the Bee agent in the Bee app, then try again (agent_vm_consent_required).");
    expect(seen.length).toBe(1);
  });
});

describe("threads error mapping", () => {
  it("maps test_user_required", async () => {
    const { ctx } = mockBee(() => Response.json({ error: "test_user_required" }, { status: 403 }));
    await expect(threadsCommand.run(["list"], ctx))
      .rejects.toThrow("Threads are available to Bee test users only, and this account is not one (test_user_required).");
  });

  it("maps thread_not_found with the thread id", async () => {
    const { ctx } = mockBee(() => Response.json({ error: "thread_not_found" }, { status: 404 }));
    await expect(threadsCommand.run(["send", "nope", "--text", "hi"], ctx))
      .rejects.toThrow("Thread nope was not found. It may not exist or may belong to another account (thread_not_found).");
    await expect(callBeeTool(ctx, "bee_abort_thread", { thread_id: "nope" })).rejects.toThrow("Thread nope was not found.");
  });

  it("maps message_not_in_thread with both ids", async () => {
    const { ctx } = mockBee(() => Response.json({ error: "message_not_in_thread" }, { status: 400 }));
    await expect(threadsCommand.run(["wait", "t1", "--after", "m0"], ctx))
      .rejects.toThrow("Message m0 is not in thread t1 (message_not_in_thread).");
  });

  it("explains a server without the Threads API", async () => {
    const { ctx } = mockBee(() => Response.json({ message: "Route GET:/v1/threads not found", error: "Not Found", statusCode: 404 }, { status: 404 }));
    await expect(threadsCommand.run(["list"], ctx)).rejects.toThrow("This Bee server does not have the Threads API yet (Route GET:/v1/threads not found).");
  });

  it("maps the remaining codes and falls back to the server message", () => {
    expect(threadsErrorMessage(400, "text_or_files_required", null, {})).toContain("text_or_files_required");
    expect(threadsErrorMessage(400, "invalid_file_ids", null, {})).toContain("invalid_file_ids");
    expect(threadsErrorMessage(400, "Bad Request", "body/wait_ms must be <= 120000", {}))
      .toBe("Bee request failed with status 400: body/wait_ms must be <= 120000");
    expect(threadsErrorMessage(500, null, null, {})).toBe("Bee request failed with status 500.");
  });
});

describe("threads list, messages and abort", () => {
  it("lists threads", async () => {
    const { ctx, seen } = mockBee(() => Response.json({
      threads: [{ thread_id: "t1", name: "Trip planning", state: "running", created_at: 1_700_000_000_000, updated_at: 1_700_000_100_000 }],
    }));
    const { logs } = await runCli(ctx, ["list"]);
    expect(seen[0]).toMatchObject({ method: "GET", path: "/v1/threads" });
    const output = logs.join("\n");
    expect(output).toContain("- Trip planning (running)");
    expect(output).toContain("  - thread_id: t1");
    const data = await callTool(ctx, "bee_list_threads", {});
    expect((data["threads"] as unknown[]).length).toBe(1);
  });

  it("shows thread messages with text and attachments", async () => {
    const { ctx } = mockBee(() => Response.json({
      thread_id: "t1",
      messages: [
        { uuid: "u1", role: "USER", text: "Look", created_at: "2026-10-13T10:00:00.000Z", parts: [{ kind: "image", fileId: "f1", filename: "a.png" }] },
        { uuid: "a1", role: "ASSISTANT", created_at: "2026-10-13T10:00:05.000Z", parts: [{ kind: "thinking", text: "hmm" }, { kind: "text", text: "Nice photo." }] },
      ],
    }));
    const { logs } = await runCli(ctx, ["messages", "t1"]);
    const output = logs.join("\n");
    expect(output).toContain("# Thread t1");
    expect(output).toContain("Look");
    expect(output).toContain("- image: a.png");
    expect(output).toContain("Nice photo.");
    expect(output).not.toContain("hmm");
    const limited = await runCliJson(ctx, ["messages", "t1", "--limit", "1"]);
    expect(limited).toMatchObject({ omitted_earlier: 1 });
  });

  it("aborts a thread", async () => {
    const { ctx, seen } = mockBee(() => Response.json({ thread_id: "t1", state: "idle" }));
    const { logs } = await runCli(ctx, ["abort", "t1"]);
    expect(seen[0]).toMatchObject({ method: "POST", path: "/v1/threads/t1/abort" });
    expect(logs.join("\n")).toBe("Aborted thread t1; state: idle.");
  });
});
