import type { BeeCliRunner } from "./runner.js";

type ListOptions = {
  limit?: number;
  cursor?: string;
};

type FactsListOptions = ListOptions & {
  unconfirmed?: boolean;
};

type ChangedOptions = {
  cursor?: string;
};

type TodoCreateOptions = {
  text: string;
  alarmAt?: string;
};

type TodoUpdateOptions = {
  text?: string;
  completed?: boolean;
  alarmAt?: string;
  clearAlarm?: boolean;
};

type FactUpdateOptions = {
  text?: string;
  confirmed?: boolean;
};

// Overall wait for an answer: seconds, or a duration such as "90s" or "5m".
// 0 sends without waiting. The CLI default is 90 seconds.
type ThreadTimeout = number | string;

type ThreadSendOptions = {
  text?: string;
  photos?: string[];
  files?: string[];
  timeout?: ThreadTimeout;
  clientMessageId?: string;
};

type ThreadWaitOptions = {
  // Message id to wait after; defaults to the thread's latest user message.
  after?: string;
  timeout?: ThreadTimeout;
};

type SearchFilter = "conversations" | "daily" | "facts" | "all";
type SearchSort = "relevance" | "mostRecent";

// Mirrors the `bee search` CLI contract:
//  - keyword (default): filter/sort scope the BM25 search; since/until bound it.
//  - neural (semantic): conversations only; filter/sort do not apply, so the CLI
//    rejects them with --neural. The union forbids them at compile time.
// since/until (epoch ms) are valid in BOTH modes.
type SearchOptions =
  | {
      query: string;
      limit?: number;
      filter?: SearchFilter;
      sort?: SearchSort;
      since?: number;
      until?: number;
      neural?: false;
    }
  | {
      query: string;
      limit?: number;
      neural: true;
      since?: number;
      until?: number;
      filter?: never;
      sort?: never;
    };

export type DataApi = {
  me: <T = unknown>() => Promise<T>;
  today: <T = unknown>() => Promise<T>;
  now: <T = unknown>() => Promise<T>;
  changed: <T = unknown>(options?: ChangedOptions) => Promise<T>;
  version: <T = unknown>() => Promise<T>;
  facts: {
    list: <T = unknown>(options?: FactsListOptions) => Promise<T>;
    get: <T = unknown>(id: string | number) => Promise<T>;
    create: <T = unknown>(text: string) => Promise<T>;
    update: <T = unknown>(id: string | number, options: FactUpdateOptions) => Promise<T>;
    confirm: <T = unknown>(id: string | number) => Promise<T>;
    delete: <T = unknown>(id: string | number) => Promise<T>;
  };
  todos: {
    list: <T = unknown>(options?: ListOptions) => Promise<T>;
    get: <T = unknown>(id: string | number) => Promise<T>;
    create: <T = unknown>(options: TodoCreateOptions) => Promise<T>;
    update: <T = unknown>(id: string | number, options: TodoUpdateOptions) => Promise<T>;
    delete: <T = unknown>(id: string | number) => Promise<T>;
  };
  conversations: {
    list: <T = unknown>(options?: ListOptions) => Promise<T>;
    get: <T = unknown>(id: string | number) => Promise<T>;
  };
  daily: {
    list: <T = unknown>(options?: ListOptions) => Promise<T>;
    get: <T = unknown>(id: string | number) => Promise<T>;
  };
  journals: {
    list: <T = unknown>(options?: ListOptions) => Promise<T>;
    get: <T = unknown>(id: string | number) => Promise<T>;
  };
  threads: {
    list: <T = unknown>() => Promise<T>;
    create: <T = unknown>(options: ThreadSendOptions) => Promise<T>;
    send: <T = unknown>(threadId: string, options: ThreadSendOptions) => Promise<T>;
    wait: <T = unknown>(threadId: string, options?: ThreadWaitOptions) => Promise<T>;
    messages: <T = unknown>(threadId: string, options?: { limit?: number }) => Promise<T>;
    abort: <T = unknown>(threadId: string) => Promise<T>;
  };
  search: <T = unknown>(options: SearchOptions) => Promise<T>;
};

export function createDataApi(runner: BeeCliRunner): DataApi {
  return {
    me: () => runner.runJson(["me"]),
    today: () => runner.runJson(["today"]),
    now: () => runner.runJson(["now"]),
    changed: (options) => {
      const args = ["changed"];
      if (options?.cursor) {
        args.push("--cursor", options.cursor);
      }
      return runner.runJson(args);
    },
    version: () => runner.runJson(["version"]),
    facts: {
      list: (options) => {
        const args = ["facts", "list"];
        appendListOptions(args, options);
        if (options?.unconfirmed) {
          args.push("--unconfirmed");
        }
        return runner.runJson(args);
      },
      get: (id) => runner.runJson(["facts", "get", String(id)]),
      create: (text) => runner.runJson(["facts", "create", "--text", text]),
      update: (id, options) => {
        const args = ["facts", "update", String(id)];
        if (options.text !== undefined) {
          args.push("--text", options.text);
        }
        if (options.confirmed !== undefined) {
          args.push("--confirmed", String(options.confirmed));
        }
        return runner.runJson(args);
      },
      confirm: (id) => runner.runJson(["facts", "confirm", String(id)]),
      delete: (id) => runner.runJson(["facts", "delete", String(id)]),
    },
    todos: {
      list: (options) => {
        const args = ["todos", "list"];
        appendListOptions(args, options);
        return runner.runJson(args);
      },
      get: (id) => runner.runJson(["todos", "get", String(id)]),
      create: (options) => {
        const args = ["todos", "create", "--text", options.text];
        if (options.alarmAt) {
          args.push("--alarm-at", options.alarmAt);
        }
        return runner.runJson(args);
      },
      update: (id, options) => {
        const args = ["todos", "update", String(id)];
        if (options.text !== undefined) {
          args.push("--text", options.text);
        }
        if (options.completed !== undefined) {
          args.push("--completed", String(options.completed));
        }
        if (options.alarmAt !== undefined) {
          args.push("--alarm-at", options.alarmAt);
        } else if (options.clearAlarm) {
          args.push("--clear-alarm");
        }
        return runner.runJson(args);
      },
      delete: (id) => runner.runJson(["todos", "delete", String(id)]),
    },
    conversations: {
      list: (options) => {
        const args = ["conversations", "list"];
        appendListOptions(args, options);
        return runner.runJson(args);
      },
      get: (id) => runner.runJson(["conversations", "get", String(id)]),
    },
    daily: {
      list: (options) => {
        const args = ["daily", "list"];
        appendListOptions(args, options);
        return runner.runJson(args);
      },
      get: (id) => runner.runJson(["daily", "get", String(id)]),
    },
    journals: {
      list: (options) => {
        const args = ["journals", "list"];
        appendListOptions(args, options);
        return runner.runJson(args);
      },
      get: (id) => runner.runJson(["journals", "get", String(id)]),
    },
    threads: {
      list: () => runner.runJson(["threads", "list"]),
      create: (options) => runner.runJson(["threads", "create", ...threadSendArgs(options)]),
      send: (threadId, options) => runner.runJson(["threads", "send", threadId, ...threadSendArgs(options)]),
      wait: (threadId, options) => {
        const args = ["threads", "wait", threadId];
        if (options?.after !== undefined) {
          args.push("--after", options.after);
        }
        appendThreadTimeout(args, options?.timeout);
        return runner.runJson(args);
      },
      messages: (threadId, options) => {
        const args = ["threads", "messages", threadId];
        if (options?.limit !== undefined) {
          args.push("--limit", String(options.limit));
        }
        return runner.runJson(args);
      },
      abort: (threadId) => runner.runJson(["threads", "abort", threadId]),
    },
    search: (options) => {
      const args = ["search", "--query", options.query];
      if (options.limit !== undefined) {
        args.push("--limit", String(options.limit));
      }
      if (options.since !== undefined) {
        args.push("--since", String(options.since));
      }
      if (options.until !== undefined) {
        args.push("--until", String(options.until));
      }
      if (options.neural) {
        args.push("--neural");
      } else {
        // Keyword-only scoping flags; the union forbids them alongside neural.
        if (options.filter !== undefined) {
          args.push("--filter", options.filter);
        }
        if (options.sort !== undefined) {
          args.push("--sort", options.sort);
        }
      }
      return runner.runJson(args);
    },
  };
}

function appendListOptions(args: string[], options?: ListOptions): void {
  if (options?.limit !== undefined) {
    args.push("--limit", String(options.limit));
  }
  if (options?.cursor) {
    args.push("--cursor", options.cursor);
  }
}

function threadSendArgs(options: ThreadSendOptions): string[] {
  const args: string[] = [];
  if (options.text !== undefined) {
    args.push("--text", options.text);
  }
  for (const photo of options.photos ?? []) {
    args.push("--photo", photo);
  }
  for (const file of options.files ?? []) {
    args.push("--file", file);
  }
  appendThreadTimeout(args, options.timeout);
  if (options.clientMessageId !== undefined) {
    args.push("--client-message-id", options.clientMessageId);
  }
  return args;
}

function appendThreadTimeout(args: string[], timeout: ThreadTimeout | undefined): void {
  if (timeout !== undefined) {
    args.push("--timeout", typeof timeout === "number" ? `${timeout}s` : timeout);
  }
}
