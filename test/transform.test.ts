import { describe, expect, it } from "vitest";
import {
  BridgeDelta,
  StreamAccumulator,
  applyOpenaiToolConfig,
  buildQoderMessages,
  buildUserMessage,
  convertIncomingMessage,
  extractDelta,
  extractMessageImages,
  extractStreamEvent,
  findUsage,
  makeSseChunk,
  parseToolCallsText,
} from "../src/transform";

describe("buildQoderMessages", () => {
  it("uses only incoming OpenAI messages", () => {
    const messages = [
      { role: "system", content: "Sys" },
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello!" },
      { role: "user", content: "Ok" },
    ];
    const converted = buildQoderMessages(messages, "Ok", true);
    expect(JSON.stringify(converted)).not.toContain("Skill");
  });

  it("falls back to prompt when messages are empty", () => {
    const converted = buildQoderMessages([], "hello", false);
    expect(converted).toHaveLength(1);
    expect(converted[0]!.role).toBe("user");
  });

  it("tool history is flattened when request tools are absent", () => {
    const messages = [
      { role: "user", content: "Hi" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "1", function: { name: "do", arguments: "{}" } }],
      },
      { role: "tool", content: "result!", tool_call_id: "1" },
    ];
    const converted = buildQoderMessages(messages, "Hi", false);
    expect(converted[1]!.content).toContain("do");
  });
});

describe("applyOpenaiToolConfig", () => {
  it("removes template tools when absent in request", () => {
    const body: Record<string, any> = {
      tools: [{ type: "function", function: { name: "Skill" } }],
      tool_choice: "auto",
      parallel_tool_calls: true,
    };
    const reqBody = { messages: [{ role: "user", content: "hi" }] };
    const toolsEnabled = applyOpenaiToolConfig(body, reqBody);
    expect(toolsEnabled).toBe(false);
    expect(body.tools).toBeUndefined();
    expect(body.parallel_tool_calls).toBeUndefined();
  });

  it("keeps only request tools", () => {
    const templateTool = { type: "function", function: { name: "Skill" } };
    const reqTool = {
      type: "function",
      function: { name: "MyTool", parameters: {} },
    };
    const body: Record<string, any> = {
      tools: [templateTool],
      tool_choice: "auto",
    };
    const reqBody = {
      tools: [reqTool],
      tool_choice: "required",
      messages: [{ role: "user", content: "hi" }],
    };
    const toolsEnabled = applyOpenaiToolConfig(body, reqBody);
    expect(toolsEnabled).toBe(true);
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].function.name).toBe("MyTool");
    expect(body.tool_choice).toBe("required");
  });
});

describe("extractDelta", () => {
  it("captures reasoning_content", () => {
    const line = JSON.stringify({
      body: JSON.stringify({
        choices: [{ delta: { content: "", reasoning_content: "thinking..." } }],
      }),
    });
    const delta = extractDelta(line);
    expect(delta.reasoningContent).toBe("thinking...");
    expect(delta.isEmpty()).toBe(false);
  });

  it("returns empty delta for non-JSON / heartbeat lines", () => {
    expect(extractDelta(": keepalive").isEmpty()).toBe(true);
    expect(extractDelta("{}").isEmpty()).toBe(true);
  });
});

describe("extractStreamEvent / findUsage", () => {
  const USAGE = {
    prompt_tokens: 11,
    completion_tokens: 7,
    total_tokens: 18,
    completion_tokens_details: { reasoning_tokens: 3 },
    prompt_tokens_details: { cached_tokens: 0 },
  };

  const line = (inner: Record<string, any>) =>
    JSON.stringify({ body: JSON.stringify(inner) });

  it("passes through top-level usage verbatim", () => {
    const ev = extractStreamEvent(line({ choices: [], usage: USAGE }));
    expect(ev.usage).toEqual(USAGE);
    expect(ev.delta.isEmpty()).toBe(true);
  });

  it("finds usage under choices[] and response_meta", () => {
    expect(
      extractStreamEvent(line({ choices: [{ delta: {}, usage: USAGE }] })).usage,
    ).toEqual(USAGE);
    expect(
      extractStreamEvent(line({ choices: [], response_meta: { usage: USAGE } }))
        .usage,
    ).toEqual(USAGE);
  });

  it("yields delta and usage from the same line without double parsing", () => {
    const ev = extractStreamEvent(
      line({ choices: [{ delta: { content: "hi" } }], usage: USAGE }),
    );
    expect(ev.delta.content).toBe("hi");
    expect(ev.usage).toEqual(USAGE);
  });

  it("ignores usage objects without token counts", () => {
    expect(extractStreamEvent(line({ choices: [], usage: {} })).usage).toBeNull();
    expect(
      extractStreamEvent(line({ choices: [], usage: { id: "x" } })).usage,
    ).toBeNull();
    expect(extractStreamEvent(line({ choices: [] })).usage).toBeNull();
  });

  it("returns null usage for heartbeat / malformed lines", () => {
    expect(extractStreamEvent(": keepalive").usage).toBeNull();
    expect(extractStreamEvent("{}").usage).toBeNull();
    expect(extractStreamEvent(JSON.stringify({ body: "{oops" })).usage).toBeNull();
  });

  it("accepts an envelope whose body is already an object", () => {
    const ev = extractStreamEvent(
      JSON.stringify({ body: { choices: [{ delta: { content: "x" } }], usage: USAGE } }),
    );
    expect(ev.delta.content).toBe("x");
    expect(ev.usage).toEqual(USAGE);
  });

  it("accepts a bare chunk frame (no envelope), as the gateway may send for the final metrics frame", () => {
    const ev = extractStreamEvent(
      JSON.stringify({
        id: "up-1",
        object: "chat.completion.chunk",
        choices: [{ delta: { content: "tail" }, finish_reason: "stop" }],
        usage: USAGE,
        raw_usage: { total: 18 },
        sub_usages: [{ model: "x" }],
      }),
    );
    expect(ev.delta.content).toBe("tail");
    expect(ev.usage).toEqual(USAGE);
  });

  it("accepts numeric-string and Anthropic-style counts, passed through unchanged", () => {
    expect(
      extractStreamEvent(
        line({ choices: [], usage: { prompt_tokens: "11", total_tokens: "18" } }),
      ).usage,
    ).toEqual({ prompt_tokens: "11", total_tokens: "18" });
    expect(
      extractStreamEvent(
        line({ choices: [], usage: { input_tokens: 4, output_tokens: 9 } }),
      ).usage,
    ).toEqual({ input_tokens: 4, output_tokens: 9 });
  });

  it("ignores error envelopes and non-metric objects", () => {
    const ev = extractStreamEvent(
      JSON.stringify({
        body: JSON.stringify({ code: "105", message: "Login expired" }),
        statusCodeValue: 403,
        statusCode: "FORBIDDEN",
      }),
    );
    expect(ev.usage).toBeNull();
    expect(ev.delta.isEmpty()).toBe(true);
    expect(
      extractStreamEvent(JSON.stringify({ statusCodeValue: 200 })).usage,
    ).toBeNull();
  });

  it("returns a detached copy, not the upstream object itself", () => {
    const inner = { choices: [], usage: { ...USAGE } };
    const got = findUsage(inner);
    expect(got).toEqual(USAGE);
    got!.total_tokens = 999;
    expect(inner.usage.total_tokens).toBe(18);
  });
});

describe("makeSseChunk", () => {
  it("outputs reasoning_content when present", () => {
    const chunk = makeSseChunk(
      "r1",
      0,
      "Qwen3.7-Max",
      "assistant",
      "hi",
      "thinking...",
      null,
    );
    expect(chunk).toContain("thinking...");
    expect(chunk.startsWith("data: ")).toBe(true);
  });

  it("does not escape non-ASCII (ensure_ascii=False 等价)", () => {
    const chunk = makeSseChunk("r1", 0, "m", "assistant", "你好", null, null);
    expect(chunk).toContain("你好");
    expect(chunk).not.toContain("\\u4f60");
  });
});

describe("StreamAccumulator", () => {
  it("forwards reasoning and non-reasoning deltas", () => {
    const acc = new StreamAccumulator("r1", 0, "m", false);
    acc.accept(new BridgeDelta("", "hello"));
    acc.accept(new BridgeDelta("", "", "think"));
    acc.accept(new BridgeDelta("", " world"));
    acc.flush();
    const result = acc.getChunks();
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]).toContain("hello");
    expect(result[result.length - 1]).toContain(" world");
  });

  it("emits role only on first chunk", () => {
    const acc = new StreamAccumulator("r1", 0, "m", false);
    acc.accept(new BridgeDelta("assistant", "a"));
    acc.accept(new BridgeDelta("", "b"));
    const chunks = acc.getChunks();
    expect(chunks[0]).toContain('"role":"assistant"');
    expect(chunks[1]).not.toContain('"role"');
  });

  it("buffers potential tool-call text in fallback mode", () => {
    const acc = new StreamAccumulator("r1", 0, "m", true);
    acc.accept(new BridgeDelta("", "Tool "));
    acc.accept(new BridgeDelta("", 'calls: [{"id":"1","type":"function","function":{"name":"f","arguments":"{}"}}]'));
    // 尚未 flush：仍可能是 tool call 文本，不应输出内容
    expect(acc.getChunks()).toHaveLength(0);
    acc.flush();
    expect(acc.finishReason()).toBe("tool_calls");
    const chunks = acc.getChunks();
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("tool_calls");
  });

  it("streams plain text in fallback mode once ruled out", () => {
    const acc = new StreamAccumulator("r1", 0, "m", true);
    acc.accept(new BridgeDelta("", "Hello there"));
    acc.flush();
    expect(acc.finishReason()).toBe("stop");
    expect(acc.getChunks().join("")).toContain("Hello there");
  });
});

describe("parseToolCallsText", () => {
  const valid =
    'Tool calls: [{"id":"1","type":"function","function":{"name":"f","arguments":"{}"}}]';

  it("parses valid tool call text", () => {
    const parsed = parseToolCallsText(valid);
    expect(parsed).not.toBeNull();
    expect(parsed![0]!.function.name).toBe("f");
  });

  it("parses fenced variant", () => {
    const parsed = parseToolCallsText("Tool calls: ```json\n" + valid.slice(12) + "\n```");
    expect(parsed).not.toBeNull();
  });

  it("returns null for non-tool text", () => {
    expect(parseToolCallsText("just text")).toBeNull();
    expect(parseToolCallsText("Tool calls: not-json")).toBeNull();
    expect(parseToolCallsText(null)).toBeNull();
  });
});

describe("images", () => {
  const dataUrl = "data:image/png;base64,iVBORw0KGgo=";

  it("extracts images from both part shapes", () => {
    const msg = {
      role: "user",
      content: [
        { type: "text", text: "what is this?" },
        { type: "image_url", image_url: { url: dataUrl } },
        { type: "input_image", image_url: { url: "https://x/a.jpg" } },
      ],
    };
    expect(extractMessageImages(msg)).toEqual([dataUrl, "https://x/a.jpg"]);
  });

  it("buildUserMessage puts images first, text last", () => {
    const built = buildUserMessage("what is this?", [dataUrl, "https://x/a.jpg"]);
    const contents = built.contents;
    expect(contents[0]).toEqual({
      type: "image_url",
      image_url: { url: dataUrl },
    });
    expect(contents[1]).toEqual({
      type: "image_url",
      image_url: { url: "https://x/a.jpg" },
    });
    expect(contents[contents.length - 1]).toEqual({
      type: "text",
      text: "what is this?",
    });
  });

  it("buildUserMessage works with image only", () => {
    const built = buildUserMessage("", ["data:image/png;base64,AAA"]);
    const types = built.contents.map((p: any) => p.type);
    expect(types).toEqual(["image_url"]);
  });

  it("convertIncomingMessage keeps image parts and strips text fallback", () => {
    const msg = {
      role: "user",
      content: [
        { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
        { type: "text", text: "describe" },
      ],
    };
    const out = convertIncomingMessage(msg, false, false);
    expect(out).not.toBeNull();
    expect(out!.role).toBe("user");
    expect(out!.contents[0].type).toBe("image_url");
    expect(out!.contents[out!.contents.length - 1].text).toBe("describe");
  });
});
