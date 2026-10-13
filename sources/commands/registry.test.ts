import { describe, expect, it } from "bun:test";
import type { CommandContext } from "@/commands/types";
import { createProxyClient } from "@/client";
import { makeCliCommand } from "@/commands/registry";
import type { RawArgs, ResourceModule } from "@/resources/types";

// A throwaway resource that records the raw bag the argv parser produced.
function recordingCommand(): { run: (args: string[]) => Promise<RawArgs> } {
  let captured: RawArgs = {};
  const resource: ResourceModule = {
    cliCommand: { name: "demo", description: "Demo.", usage: "bee demo" },
    actions: [{
      cli: {
        subcommand: "go",
        positionals: [{ name: "threadId", required: true, kind: "string", arityMessage: "Provide one thread id." }],
        flags: [
          { name: "--photo", kind: "stringList" },
          { name: "--file", kind: "stringList" },
          { name: "--text", kind: "string" },
        ],
        render: () => {},
      },
      coerceInput: (raw: RawArgs) => {
        captured = raw;
        return raw;
      },
      run: async () => ({ kind: "json", data: null }),
    }],
  };
  const command = makeCliCommand(resource);
  const context: CommandContext = {
    env: "prod",
    client: createProxyClient("prod", { address: "http://127.0.0.1:9" }),
  };
  return {
    run: async (args) => {
      await command.run(args, context);
      return captured;
    },
  };
}

describe("resource argv parser", () => {
  it("collects a repeatable stringList flag in order", async () => {
    const raw = await recordingCommand().run([
      "go", "abc", "--photo", "a.jpg", "--file", "doc.pdf", "--photo", "b.png",
    ]);
    expect(raw["photo"]).toEqual(["a.jpg", "b.png"]);
    expect(raw["file"]).toEqual(["doc.pdf"]);
  });

  it("omits a stringList flag that was never given", async () => {
    const raw = await recordingCommand().run(["go", "abc", "--text", "hi"]);
    expect(raw["photo"]).toBeUndefined();
    expect(raw["text"]).toBe("hi");
  });

  it("rejects a stringList flag without a value", async () => {
    await expect(recordingCommand().run(["go", "abc", "--photo"])).rejects.toThrow("--photo requires a value");
    await expect(recordingCommand().run(["go", "abc", "--photo", " "])).rejects.toThrow("--photo requires a value");
  });

  it("keeps a kind:string required positional as a string", async () => {
    const raw = await recordingCommand().run(["go", "7f1c2b9e-thread"]);
    expect(raw["threadId"]).toBe("7f1c2b9e-thread");
  });

  it("uses the arity message for a missing string positional", async () => {
    await expect(recordingCommand().run(["go"])).rejects.toThrow("Provide one thread id.");
  });
});
