import type { BeeCliOptions, RunOptions, SpawnOptions } from "./types.js";
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

type RunResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

type NodeReadable = {
  on: (event: string, listener: (...args: unknown[]) => void) => void;
  setEncoding?: (encoding: BufferEncoding) => unknown;
  [Symbol.asyncIterator]?: () => AsyncIterator<unknown>;
};

type NodeWritable = {
  write: (chunk: string) => void;
  end: () => void;
};

export type BeeSubprocess = {
  stdin: NodeWritable | null;
  stdout: NodeReadable | null;
  stderr: NodeReadable | null;
  kill: (signal?: string | number) => void;
  exited: Promise<number>;
};

export type BeeCliRunner = {
  run: (args: string[], options?: RunOptions) => Promise<RunResult>;
  runJson: <T = unknown>(args: string[], options?: RunOptions) => Promise<T>;
  spawn: (args: string[], options?: SpawnOptions) => BeeSubprocess;
};

// The npm package ships the native binary next to this module (dist/lib -> dist/platforms).
// Spawning it directly works without a global install, and on Windows, where spawn() cannot run
// the `bee.cmd` shim npm puts on PATH. Same lookup as bin/bee.js, including BEE_CLI_BINARY.
function defaultCommand(): string {
  const override = process.env["BEE_CLI_BINARY"];
  if (override) {
    return override;
  }
  const platforms: Record<string, string> = { darwin: "mac", linux: "linux", win32: "windows" };
  const arches: Record<string, string> = { arm64: "arm64", x64: "x64" };
  const platform = platforms[process.platform];
  const arch = arches[process.arch];
  if (platform && arch) {
    const binary = platform === "windows" ? "bee.exe" : "bee";
    const bundled = fileURLToPath(new URL(`../platforms/${platform}-${arch}/${binary}`, import.meta.url));
    if (existsSync(bundled)) {
      return bundled;
    }
  }
  return "bee";
}

export function createBeeCliRunner(options: BeeCliOptions = {}): BeeCliRunner {
  const command = options.command ?? defaultCommand();
  const baseArgs = options.baseArgs ?? [];
  const environment = options.environment ?? "prod";
  const cwd = options.cwd;
  const customEnv = options.env;

  function buildArgs(args: string[]): string[] {
    const globalArgs = environment === "staging" ? ["--staging"] : [];
    return [...baseArgs, ...globalArgs, ...args];
  }

  function buildEnv(): Record<string, string> {
    const merged: Record<string, string> = {};
    const runtimeEnv =
      typeof Bun !== "undefined" && Bun.env ? Bun.env : process.env;
    for (const [key, value] of Object.entries(runtimeEnv)) {
      if (value !== undefined) {
        merged[key] = value;
      }
    }
    if (!customEnv) {
      return merged;
    }

    for (const [key, value] of Object.entries(customEnv)) {
      if (value === undefined) {
        delete merged[key];
      } else {
        merged[key] = value;
      }
    }

    return merged;
  }

  function spawn(args: string[], spawnOptions: SpawnOptions = {}): BeeSubprocess {
    const stdio: ("pipe" | "inherit" | "ignore")[] = [
      spawnOptions.stdin ?? "inherit",
      spawnOptions.stdout ?? "pipe",
      spawnOptions.stderr ?? "pipe",
    ];

    const child = nodeSpawn(command, buildArgs(args), {
      cwd,
      env: buildEnv(),
      stdio,
      signal: spawnOptions.signal,
    });

    const exited = new Promise<number>((resolve, reject) => {
      child.once("error", (error) => {
        reject(error);
      });
      child.once("exit", (code) => {
        resolve(code ?? 1);
      });
    });

    return {
      stdin: child.stdin ?? null,
      stdout: child.stdout ?? null,
      stderr: child.stderr ?? null,
      kill: (signal?: string | number) => {
        child.kill(signal as never);
      },
      exited,
    };
  }

  async function run(
    args: string[],
    runOptions: RunOptions = {}
  ): Promise<RunResult> {
    const inheritStdio = runOptions.inheritStdio ?? false;
    const spawnOptions: SpawnOptions = {
      stdout: inheritStdio ? "inherit" : "pipe",
      stderr: inheritStdio ? "inherit" : "pipe",
      stdin: runOptions.stdin !== undefined ? "pipe" : "inherit",
    };
    if (runOptions.signal) {
      spawnOptions.signal = runOptions.signal;
    }

    const proc = spawn(args, spawnOptions);

    if (runOptions.stdin !== undefined) {
      const stdin = proc.stdin;
      if (!stdin) {
        throw new Error("Failed to open stdin pipe for Bee CLI.");
      }
      stdin.write(runOptions.stdin);
      stdin.end();
    }

    const stdoutPromise = inheritStdio
      ? Promise.resolve("")
      : readStream(proc.stdout);
    const stderrPromise = inheritStdio
      ? Promise.resolve("")
      : readStream(proc.stderr);

    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      stdoutPromise,
      stderrPromise,
    ]);

    return { stdout, stderr, exitCode };
  }

  async function runJson<T>(
    args: string[],
    runOptions?: RunOptions
  ): Promise<T> {
    const jsonArgs = ensureJsonFlag(args);
    const result = await run(jsonArgs, runOptions);

    if (result.exitCode !== 0) {
      const message =
        result.stderr.trim() ||
        result.stdout.trim() ||
        `Bee CLI exited with code ${result.exitCode}.`;
      throw new Error(message);
    }

    const trimmed = result.stdout.trim();
    if (!trimmed) {
      return null as T;
    }

    try {
      return JSON.parse(trimmed) as T;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown JSON parse error";
      throw new Error(`Failed to parse Bee CLI JSON output: ${message}`);
    }
  }

  return { run, runJson, spawn };
}

function ensureJsonFlag(args: string[]): string[] {
  return args.includes("--json") ? [...args] : [...args, "--json"];
}

function readStream(
  stream: NodeReadable | ReadableStream<Uint8Array> | null | undefined
): Promise<string> {
  if (!stream) {
    return Promise.resolve("");
  }
  if (isWebReadableStream(stream)) {
    return new Response(stream).text();
  }
  return readNodeStream(stream);
}

function isWebReadableStream(
  stream: NodeReadable | ReadableStream<Uint8Array>
): stream is ReadableStream<Uint8Array> {
  return typeof (stream as ReadableStream<Uint8Array>).getReader === "function";
}

function readNodeStream(stream: NodeReadable): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    if (stream.setEncoding) {
      stream.setEncoding("utf8");
    }
    stream.on("data", (chunk) => {
      if (typeof chunk === "string") {
        data += chunk;
      } else if (Buffer.isBuffer(chunk)) {
        data += chunk.toString("utf8");
      } else if (chunk instanceof Uint8Array) {
        data += new TextDecoder().decode(chunk);
      } else {
        data += String(chunk);
      }
    });
    stream.on("error", (error) => {
      reject(error);
    });
    stream.on("end", () => {
      resolve(data);
    });
  });
}
