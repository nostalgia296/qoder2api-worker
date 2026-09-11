import { afterEach, describe, expect, it, vi } from "vitest";
import { QoderBridgeDO } from "../src/bridge_do";
import { decode } from "../src/crypto/custom_base64";

const JT = () => ({
  name: "u",
  id: "1",
  userType: "personal_standard",
  securityOauthToken: "s",
  refreshToken: "r",
  expireTime: Date.now() + 24 * 3600 * 1000,
});

const CATALOG = {
  chat: [
    { key: "qmodel_latest", display_name: "Qwen3.7-Max", enable: true, is_vl: true },
  ],
};

function sseDelta(content: string): string {
  return `data:${JSON.stringify({
    body: JSON.stringify({ choices: [{ delta: { content } }] }),
  })}\n\n`;
}

const USAGE = {
  prompt_tokens: 11,
  completion_tokens: 7,
  total_tokens: 18,
  completion_tokens_details: { reasoning_tokens: 3 },
  prompt_tokens_details: { cached_tokens: 0 },
};

function sseUsage(usage: Record<string, any> = USAGE): string {
  return `data:${JSON.stringify({
    body: JSON.stringify({ choices: [], usage }),
  })}\n\n`;
}

function authEnvelope(): string {
  return `data:${JSON.stringify({
    body: JSON.stringify({ code: "105", message: "Login expired" }),
    statusCodeValue: 403,
    statusCode: "FORBIDDEN",
  })}\n\n`;
}

interface Counters {
  cold: number;
  refresh: number;
  chat: number;
  modelList: number;
}

function parseJobTokenBody(init: any): { needRefresh: boolean } {
  const text = typeof init?.body === "string" ? init.body : "";
  const outer = JSON.parse(new TextDecoder().decode(decode(text)));
  return JSON.parse(outer.payload);
}

function makeFetch(
  c: Counters,
  opts: { chatFirstResponse?: () => Response; chatBody?: string } = {},
) {
  return async (input: any, init: any): Promise<Response> => {
    const url = String(input);
    if (url.includes("/algo/api/v3/user/jobToken")) {
      const inner = parseJobTokenBody(init);
      if (inner.needRefresh) c.refresh++;
      else c.cold++;
      return Response.json(JT());
    }
    if (url.includes("/algo/api/v2/model/list")) {
      c.modelList++;
      return Response.json(CATALOG);
    }
    if (url.includes("/algo/api/v2/service/pro/sse/agent_chat_generation")) {
      c.chat++;
      if (opts.chatFirstResponse && c.chat === 1) {
        return opts.chatFirstResponse();
      }
      return new Response(opts.chatBody ?? sseDelta("hi"), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };
}

function makeState(): any {
  const map = new Map<string, any>();
  return {
    storage: {
      get: async (key: string) => map.get(key),
      put: async (key: string, value: any) => {
        map.set(key, value);
      },
    },
  };
}

function makeDO(fetchImpl: any): QoderBridgeDO {
  vi.stubGlobal("fetch", fetchImpl);
  return new QoderBridgeDO(makeState(), { BRIDGE: {} } as any);
}

function chatRequest(body: Record<string, any>): Request {
  return new Request("https://do.internal/v1/chat/completions", {
    method: "POST",
    headers: {
      "x-qoder-pat": "pt-test",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

const CHAT_BODY = {
  model: "Qwen3.7-Max",
  stream: false,
  messages: [{ role: "user", content: "hi" }],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("QoderBridgeDO session", () => {
  it("deduplicates cold exchange under concurrent first requests", async () => {
    const c: Counters = { cold: 0, refresh: 0, chat: 0, modelList: 0 };
    const dobj = makeDO(makeFetch(c));

    const responses = await Promise.all(
      [1, 2, 3].map(() => dobj.fetch(chatRequest(CHAT_BODY))),
    );

    expect(c.cold).toBe(1);
    expect(c.refresh).toBe(0);
    expect(c.chat).toBe(3);
    for (const resp of responses) {
      expect(resp.status).toBe(200);
      const data = await resp.json();
      expect(data.choices[0].message.content).toBe("hi");
      expect(data.object).toBe("chat.completion");
    }
  });

  it("refreshes and retries once when auth error before any content", async () => {
    const c: Counters = { cold: 0, refresh: 0, chat: 0, modelList: 0 };
    const dobj = makeDO(
      makeFetch(c, {
        chatFirstResponse: () => new Response(authEnvelope(), { status: 200 }),
      }),
    );

    const resp = await dobj.fetch(chatRequest(CHAT_BODY));
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.choices[0].message.content).toBe("hi");
    expect(c.cold).toBe(1); // bootstrap
    expect(c.refresh).toBe(1); // 被动强刷
    expect(c.chat).toBe(2); // 重试了一次
  });

  it("does not retry after content produced; emits error chunk before DONE", async () => {
    const c: Counters = { cold: 0, refresh: 0, chat: 0, modelList: 0 };
    const dobj = makeDO(
      makeFetch(c, {
        chatFirstResponse: () =>
          new Response(sseDelta("partial") + authEnvelope(), { status: 200 }),
      }),
    );

    const resp = await dobj.fetch(
      chatRequest({ ...CHAT_BODY, stream: true }),
    );
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toBe("text/event-stream");
    const text = await resp.text();

    expect(text).toContain("partial");
    const doneIdx = text.indexOf("data: [DONE]");
    expect(doneIdx).toBeGreaterThan(-1);
    const prefix = text.slice(0, doneIdx);
    expect(prefix).toContain('"finish_reason":"error"');
    expect(prefix).toContain('"error"');
    expect(c.chat).toBe(1); // 没有重试
    expect(c.refresh).toBe(0); // 没有刷新
  });

  it("returns 400 OpenAI error for unsupported model", async () => {
    const c: Counters = { cold: 0, refresh: 0, chat: 0, modelList: 0 };
    const dobj = makeDO(makeFetch(c));
    const resp = await dobj.fetch(
      chatRequest({ ...CHAT_BODY, model: "unknown-model" }),
    );
    expect(resp.status).toBe(400);
    const data = await resp.json();
    expect(data.error.type).toBe("invalid_request_error");
  });

  it("GET /v1/models returns dynamic catalog", async () => {
    const c: Counters = { cold: 0, refresh: 0, chat: 0, modelList: 0 };
    const dobj = makeDO(makeFetch(c));
    const resp = await dobj.fetch(
      new Request("https://do.internal/v1/models", {
        headers: { "x-qoder-pat": "pt-test" },
      }),
    );
    const data = await resp.json();
    const ids = data.data.map((m: any) => m.id);
    expect(ids).toEqual(["Qwen3.7-Max"]);
  });
});

function sseChunks(text: string): Record<string, any>[] {
  return text
    .split("\n")
    .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
    .map((l) => JSON.parse(l.slice("data: ".length)));
}

const NEW_COUNTERS = (): Counters => ({
  cold: 0,
  refresh: 0,
  chat: 0,
  modelList: 0,
});

describe("upstream usage pass-through", () => {
  it("non-stream relays upstream usage verbatim", async () => {
    const dobj = makeDO(
      makeFetch(NEW_COUNTERS(), { chatBody: sseDelta("hi") + sseUsage() }),
    );
    const resp = await dobj.fetch(chatRequest(CHAT_BODY));
    const data = await resp.json();
    expect(data.choices[0].message.content).toBe("hi");
    expect(data.usage).toEqual(USAGE);
  });

  it("non-stream falls back to zeros when upstream reports no usage", async () => {
    const dobj = makeDO(makeFetch(NEW_COUNTERS(), { chatBody: sseDelta("hi") }));
    const data = await (await dobj.fetch(chatRequest(CHAT_BODY))).json();
    expect(data.usage).toEqual({
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    });
  });

  it("stream attaches usage to the finish_reason chunk", async () => {
    const dobj = makeDO(
      makeFetch(NEW_COUNTERS(), { chatBody: sseDelta("hi") + sseUsage() }),
    );
    const resp = await dobj.fetch(chatRequest({ ...CHAT_BODY, stream: true }));
    const text = await resp.text();
    const chunks = sseChunks(text);
    const last = chunks[chunks.length - 1]!;
    expect(last.choices[0].finish_reason).toBe("stop");
    expect(last.usage).toEqual(USAGE);
    expect(chunks.filter((ch) => ch.choices.length === 0)).toHaveLength(0);
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("stream emits a trailing empty-choices usage chunk for include_usage", async () => {
    const dobj = makeDO(
      makeFetch(NEW_COUNTERS(), { chatBody: sseDelta("hi") + sseUsage() }),
    );
    const resp = await dobj.fetch(
      chatRequest({
        ...CHAT_BODY,
        stream: true,
        stream_options: { include_usage: true },
      }),
    );
    const chunks = sseChunks(await resp.text());
    const last = chunks[chunks.length - 1]!;
    const finish = chunks[chunks.length - 2]!;
    expect(finish.choices[0].finish_reason).toBe("stop");
    expect(finish.usage).toBeUndefined();
    expect(last.choices).toEqual([]);
    expect(last.usage).toEqual(USAGE);
  });

  it("stream omits usage entirely when upstream sends none", async () => {
    const dobj = makeDO(makeFetch(NEW_COUNTERS(), { chatBody: sseDelta("hi") }));
    const resp = await dobj.fetch(
      chatRequest({
        ...CHAT_BODY,
        stream: true,
        stream_options: { include_usage: true },
      }),
    );
    const chunks = sseChunks(await resp.text());
    expect(chunks.every((ch) => ch.usage === undefined)).toBe(true);
    expect(chunks[chunks.length - 1]!.choices[0].finish_reason).toBe("stop");
  });

  it("captures usage from a bare final frame (no {body:...} envelope)", async () => {
    const bare = `data:${JSON.stringify({
      object: "chat.completion.chunk",
      choices: [],
      usage: USAGE,
      raw_usage: { noise: true },
      sub_usages: [{ noise: true }],
    })}\n\n`;
    const dobj = makeDO(
      makeFetch(NEW_COUNTERS(), { chatBody: sseDelta("hi") + bare }),
    );
    const data = await (await dobj.fetch(chatRequest(CHAT_BODY))).json();
    expect(data.usage).toEqual(USAGE);
  });
});
