import { describe, expect, it } from "bun:test";
import { createBeeCliRunner } from "@/lib/runner";
import { createDataApi } from "@/lib/api";
import { createJsonSseStream } from "@/lib/sse";

const TEST_TIMEOUT_MS = 5000;

const NODE_BINARY =
  typeof Bun !== "undefined" ? Bun.which("node") ?? "node" : "node";

function createNodeRunner(script: string) {
  return createBeeCliRunner({
    command: NODE_BINARY,
    baseArgs: ["-e", script],
  });
}

describe("lib integration", () => {
  it(
    "runJson parses JSON output and passes args",
    async () => {
      const runner = createNodeRunner(
        'console.log(JSON.stringify({ ok: true, argv: process.argv.slice(1) }));'
      );

      const result = await runner.runJson<{ ok: boolean; argv: string[] }>([
        "arg1",
      ]);

      expect(result.ok).toBe(true);
      expect(result.argv).toEqual(["arg1", "--json"]);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "run supports stdin",
    async () => {
      const runner = createNodeRunner(
        'process.stdin.setEncoding("utf8"); let data=""; process.stdin.on("data", (chunk) => { data += chunk; }); process.stdin.on("end", () => { console.log(data.toUpperCase()); });'
      );

      const result = await runner.run([], { stdin: "hello" });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("HELLO");
    },
    TEST_TIMEOUT_MS
  );

  it(
    "data api builds CLI arguments",
    async () => {
      const runner = createNodeRunner(
        'console.log(JSON.stringify({ argv: process.argv.slice(1) }));'
      );
      const api = createDataApi(runner);

      const result = (await api.todos.list({
        limit: 2,
        cursor: "abc",
      })) as { argv: string[] };

      expect(result.argv).toEqual([
        "todos",
        "list",
        "--limit",
        "2",
        "--cursor",
        "abc",
        "--json",
      ]);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "data api builds facts update and confirm arguments",
    async () => {
      const runner = createNodeRunner(
        'console.log(JSON.stringify({ argv: process.argv.slice(1) }));'
      );
      const api = createDataApi(runner);

      const updateResult = (await api.facts.update(4, {
        confirmed: true,
      })) as { argv: string[] };
      const confirmResult = (await api.facts.confirm(4)) as { argv: string[] };

      expect(updateResult.argv).toEqual([
        "facts",
        "update",
        "4",
        "--confirmed",
        "true",
        "--json",
      ]);
      expect(confirmResult.argv).toEqual(["facts", "confirm", "4", "--json"]);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "search builds keyword args including filter/sort/since/until",
    async () => {
      const runner = createNodeRunner(
        'console.log(JSON.stringify({ argv: process.argv.slice(1) }));'
      );
      const api = createDataApi(runner);

      const result = (await api.search({
        query: "coffee",
        limit: 5,
        filter: "conversations",
        sort: "mostRecent",
        since: 1000,
        until: 2000,
      })) as { argv: string[] };

      expect(result.argv).toEqual([
        "search",
        "--query",
        "coffee",
        "--limit",
        "5",
        "--since",
        "1000",
        "--until",
        "2000",
        "--filter",
        "conversations",
        "--sort",
        "mostRecent",
        "--json",
      ]);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "search omits filter/sort in neural mode",
    async () => {
      const runner = createNodeRunner(
        'console.log(JSON.stringify({ argv: process.argv.slice(1) }));'
      );
      const api = createDataApi(runner);

      const result = (await api.search({
        query: "coffee",
        neural: true,
        since: 1000,
      })) as { argv: string[] };

      expect(result.argv).toEqual([
        "search",
        "--query",
        "coffee",
        "--since",
        "1000",
        "--neural",
        "--json",
      ]);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "data api builds threads arguments",
    async () => {
      const runner = createNodeRunner(
        'console.log(JSON.stringify({ argv: process.argv.slice(1) }));'
      );
      const api = createDataApi(runner);

      const created = (await api.threads.create({
        text: "Plan my trip",
        photos: ["a.jpg", "b.png"],
        files: ["notes.pdf"],
        timeout: 120,
        clientMessageId: "abc-1",
      })) as { argv: string[] };
      const sent = (await api.threads.send("t1", { text: "More", timeout: "5m" })) as { argv: string[] };
      const waited = (await api.threads.wait("t1", { after: "m1", timeout: 0 })) as { argv: string[] };
      const bareWait = (await api.threads.wait("t1")) as { argv: string[] };
      const messages = (await api.threads.messages("t1", { limit: 5 })) as { argv: string[] };
      const aborted = (await api.threads.abort("t1")) as { argv: string[] };
      const listed = (await api.threads.list()) as { argv: string[] };

      expect(created.argv).toEqual([
        "threads", "create", "--text", "Plan my trip",
        "--photo", "a.jpg", "--photo", "b.png", "--file", "notes.pdf",
        "--timeout", "120s", "--client-message-id", "abc-1", "--json",
      ]);
      expect(sent.argv).toEqual(["threads", "send", "t1", "--text", "More", "--timeout", "5m", "--json"]);
      expect(waited.argv).toEqual(["threads", "wait", "t1", "--after", "m1", "--timeout", "0s", "--json"]);
      expect(bareWait.argv).toEqual(["threads", "wait", "t1", "--json"]);
      expect(messages.argv).toEqual(["threads", "messages", "t1", "--limit", "5", "--json"]);
      expect(aborted.argv).toEqual(["threads", "abort", "t1", "--json"]);
      expect(listed.argv).toEqual(["threads", "list", "--json"]);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "sse stream yields json lines",
    async () => {
      const runner = createNodeRunner(
        'const events=[{id:1},{id:2}]; let i=0; const timer=setInterval(() => { if (i >= events.length) { clearInterval(timer); process.exit(0); } else { console.log(JSON.stringify(events[i++])); } }, 10);'
      );

      const stream = createJsonSseStream<{ id: number }>(runner);
      const received: Array<{ id: number }> = [];

      for await (const event of stream.events) {
        received.push(event.data);
      }

      expect(received).toEqual([{ id: 1 }, { id: 2 }]);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "sse stream skips malformed and non-json lines",
    async () => {
      const runner = createNodeRunner(
        'console.log("event: connected"); console.log("data: {\\"id\\":1}"); console.log("not-json"); console.log("{\\"id\\":2}"); console.log("data: [DONE]");'
      );

      const stream = createJsonSseStream<{ id: number }>(runner);
      const received: Array<{ id: number }> = [];

      for await (const event of stream.events) {
        received.push(event.data);
      }

      expect(received).toEqual([{ id: 1 }, { id: 2 }]);
    },
    TEST_TIMEOUT_MS
  );
});
