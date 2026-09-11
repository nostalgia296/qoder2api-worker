export type Dict = Record<string, any>;

export class BridgeDelta {
  constructor(
    public role: string = "",
    public content: string = "",
    public reasoningContent: string = "",
    public toolCalls: Dict[] | null = null,
  ) {}

  isEmpty(): boolean {
    return (
      !this.role &&
      !this.content &&
      !this.reasoningContent &&
      (this.toolCalls === null || this.toolCalls.length === 0)
    );
  }
}

export class ToolCallAccumulator {
  calls: Dict[] = [];

  append(deltaCalls: Dict[]): void {
    for (const dc of deltaCalls) {
      const rawIdx = dc.index;
      const idx =
        typeof rawIdx === "number" && Number.isInteger(rawIdx)
          ? rawIdx
          : this.calls.length;
      while (this.calls.length <= idx) {
        this.calls.push({
          id: "",
          type: "function",
          function: { name: "", arguments: "" },
        });
      }
      const existing = this.calls[idx]!;
      if (typeof dc.id === "string") existing.id = dc.id;
      if (typeof dc.type === "string") existing.type = dc.type;
      const df: Dict = dc.function ?? {};
      const ef: Dict = existing.function;
      if (typeof df.name === "string") ef.name = df.name;
      if (typeof df.arguments === "string") ef.arguments += df.arguments;
    }
  }

  isEmpty(): boolean {
    return this.calls.length === 0;
  }

  snapshot(): Dict[] {
    return structuredClone(this.calls);
  }
}

export class StreamAccumulator {
  private toolCalls = new ToolCallAccumulator();
  private pendingContent: string[] = [];
  private pendingRole = "assistant";
  private emitted = false;
  private streamingText = false;
  private chunks: string[] = [];

  constructor(
    private reqId: string,
    private created: number,
    private model: string,
    private toolCallFallback: boolean,
    private emitFn: ((chunk: string) => void) | null = null,
  ) {}

  accept(delta: BridgeDelta): void {
    if (delta.role) this.pendingRole = delta.role;

    if (delta.reasoningContent) {
      this.emit(null, delta.reasoningContent, null);
    }

    if (delta.toolCalls && delta.toolCalls.length > 0) {
      this.discardBufferedToolCallText();
      this.toolCalls.append(delta.toolCalls);
      this.emit(null, null, withToolCallIndices(delta.toolCalls));
      return;
    }

    if (!delta.content) return;

    if (!this.toolCallFallback || this.streamingText) {
      this.streamingText = true;
      this.emit(delta.content, null, null);
      return;
    }

    this.pendingContent.push(delta.content);
    const text = this.pendingContent.join("");
    if (isPotentialToolCallText(text)) return;
    this.streamingText = true;
    this.emitBufferedText();
  }

  flush(): void {
    if (this.pendingContent.length === 0) return;
    const buffered = this.pendingContent.join("");
    this.pendingContent = [];
    const parsed = this.toolCallFallback
      ? parseToolCallsText(buffered)
      : null;
    if (parsed !== null) {
      this.toolCalls.append(parsed);
      this.emit(null, null, withToolCallIndices(parsed));
      return;
    }
    this.streamingText = true;
    this.emit(buffered, null, null);
  }

  finishReason(): string {
    return this.toolCalls.isEmpty() ? "stop" : "tool_calls";
  }

  getChunks(): string[] {
    return this.chunks;
  }

  private emitBufferedText(): void {
    if (this.pendingContent.length === 0) return;
    const buffered = this.pendingContent.join("");
    this.pendingContent = [];
    this.emit(buffered, null, null);
  }

  private discardBufferedToolCallText(): void {
    if (this.pendingContent.length === 0) return;
    const buffered = this.pendingContent.join("");
    this.pendingContent = [];
    if (this.toolCallFallback && isPotentialToolCallText(buffered)) return;
    this.streamingText = true;
    this.emit(buffered, null, null);
  }

  private emit(
    content: string | null,
    reasoningContent: string | null,
    toolCalls: Dict[] | null,
  ): void {
    let role = "";
    if (!this.emitted) role = this.pendingRole || "assistant";
    const chunk = makeSseChunk(
      this.reqId,
      this.created,
      this.model,
      role,
      content,
      reasoningContent,
      toolCalls,
    );
    if (this.emitFn !== null) this.emitFn(chunk);
    else this.chunks.push(chunk);
    this.emitted = true;
  }
}

function isPotentialToolCallText(text: string): boolean {
  const candidate = text.replace(/^\s+/, "");
  if (!candidate) return true;
  return (
    "Tool calls:".startsWith(candidate) || candidate.startsWith("Tool calls:")
  );
}

function withToolCallIndices(rawToolCalls: Dict[]): Dict[] {
  return rawToolCalls.map((tc, i) => {
    const call = structuredClone(tc);
    if (typeof call.index !== "number") call.index = i;
    return call;
  });
}

export function normalizeContent(content: unknown): string {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      const part = normalizeContentPart(item);
      if (part) parts.push(part);
    }
    return parts.join("\n\n");
  }
  if (typeof content === "object") return normalizeContentPart(content);
  return String(content);
}

function normalizeContentPart(item: unknown): string {
  if (item === null || item === undefined) return "";
  if (typeof item === "string") return item;
  if (typeof item === "object" && !Array.isArray(item)) {
    const it = item as Dict;
    const t = it.type ?? "";
    if (typeof it.text === "string") return it.text;
    if (t === "image_url" || t === "input_image") {
      const url = it.image_url?.url ?? "";
      if (url) return `[image] ${url}`;
    }
    if (Array.isArray(it.content) || typeof it.content === "object") {
      return normalizeContent(it.content);
    }
    return JSON.stringify(it);
  }
  return String(item);
}

export function extractImageDataUrl(part: Dict): string | null {
  if (typeof part !== "object" || part === null) return null;
  const t = part.type ?? "";
  if (t !== "image_url" && t !== "input_image") return null;
  const iu = part.image_url;
  let url: unknown;
  if (typeof iu === "object" && iu !== null) url = iu.url;
  else if (typeof iu === "string") url = iu;
  else url = part.url;
  return typeof url === "string" && url ? url : null;
}

export function extractMessageImages(message: Dict): string[] {
  const content = message.content;
  const urls: string[] = [];
  if (Array.isArray(content)) {
    for (const part of content) {
      const url =
        typeof part === "object" && part !== null
          ? extractImageDataUrl(part)
          : null;
      if (url) urls.push(url);
    }
  }
  return urls;
}

function normalizeMessageText(message: Dict): string {
  let text = normalizeContent(message.content);
  if (!text.trim()) text = normalizeContent(message.contents);
  return text;
}

function normalizeToolArguments(args: unknown): string {
  if (args === null || args === undefined) return "";
  if (typeof args === "string") return args;
  return JSON.stringify(args);
}

function normalizeToolCalls(rawToolCalls: unknown): Dict[] | null {
  if (!Array.isArray(rawToolCalls)) return null;
  const normalized: Dict[] = [];
  for (const rtc of rawToolCalls) {
    const func = rtc?.function ?? {};
    const name = func.name ?? "";
    const args = normalizeToolArguments(func.arguments);
    if (!name && !args) continue;
    normalized.push({
      id: rtc?.id ?? "",
      type: rtc?.type ?? "function",
      function: { name, arguments: args },
    });
  }
  return normalized.length ? normalized : null;
}

export function parseToolCallsText(text: string | null): Dict[] | null {
  if (text === null) return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith("Tool calls:")) return null;
  let payload = trimmed.slice("Tool calls:".length).trim();
  if (payload.startsWith("```") && payload.endsWith("```")) {
    const newline = payload.indexOf("\n");
    if (newline >= 0) payload = payload.slice(newline + 1, -3).trim();
  }
  if (!payload.startsWith("[")) return null;
  try {
    const parsed = JSON.parse(payload);
    return normalizeToolCalls(parsed);
  } catch {
    return null;
  }
}

function blankResponseMeta(): Dict {
  return {
    id: "",
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      completion_tokens_details: { reasoning_tokens: 0 },
      prompt_tokens_details: { cached_tokens: 0 },
    },
  };
}

export function buildUserMessage(text: string, images?: string[]): Dict {
  const parts: Dict[] = [];
  for (const url of images ?? []) {
    parts.push({ type: "image_url", image_url: { url } });
  }
  if (text.trim()) parts.push({ type: "text", text });
  if (parts.length === 0) parts.push({ type: "text", text: "" });
  return {
    role: "user",
    content: "",
    contents: parts,
    response_meta: blankResponseMeta(),
    reasoning_content_signature: "",
  };
}

function buildStructuredMessage(role: string, text: string | null): Dict {
  return {
    role,
    content: text || "",
    response_meta: blankResponseMeta(),
    reasoning_content_signature: "",
  };
}

function buildAssistantToolCallMessage(text: string, toolCalls: Dict[]): Dict {
  let content = text || "";
  if (parseToolCallsText(content) !== null) content = "";
  const msg = buildStructuredMessage("assistant", content);
  msg.tool_calls = structuredClone(toolCalls);
  return msg;
}

function buildToolMessage(message: Dict, text: string): Dict {
  const out = buildStructuredMessage("tool", text);
  if (typeof message.name === "string") out.name = message.name;
  if (typeof message.tool_call_id === "string") {
    out.tool_call_id = message.tool_call_id;
  }
  return out;
}

function renderToolCalls(toolCalls: Dict[]): string {
  return "Tool calls:\n" + JSON.stringify(toolCalls);
}

function renderToolResult(message: Dict, text: string): string {
  const name: string = message.name ?? "";
  const toolCallId: string = message.tool_call_id ?? "";
  const parts: string[] = ["Tool result"];
  if (name) parts.push(` (${name})`);
  if (toolCallId) parts.push(` [${toolCallId}]`);
  if (text.trim()) parts.push(`:\n${text}`);
  return parts.join("");
}

function summarizeUnresolvedToolCalls(toolCalls: Dict[]): string {
  const sb: string[] = ["Previously planned but unexecuted tool calls"];
  const limit = Math.min(toolCalls.length, 6);
  const names: string[] = [];
  for (let i = 0; i < limit; i++) {
    names.push(toolCalls[i]?.function?.name || "unknown");
  }
  if (names.length) {
    sb.push(": ");
    sb.push(names.join(", "));
  }
  if (toolCalls.length > limit) {
    sb.push(` and ${toolCalls.length - limit} more`);
  }
  sb.push(".");
  return sb.join("");
}

function joinSections(first: string | null, second: string | null): string {
  if (!first || !first.trim()) return second || "";
  if (!second || !second.trim()) return first;
  return first + "\n\n" + second;
}

function hasResolvedToolResponse(messages: Dict[], assistantIndex: number): boolean {
  const message = messages[assistantIndex]!;
  if (message.role !== "assistant") return false;
  const tc = message.tool_calls;
  const hasToolCalls =
    (Array.isArray(tc) && tc.length > 0) ||
    parseToolCallsText(normalizeMessageText(message)) !== null;
  if (!hasToolCalls) return false;
  for (let i = assistantIndex + 1; i < messages.length; i++) {
    const nextRole = messages[i]!.role ?? "";
    if (nextRole === "tool") return true;
    if (nextRole === "assistant" || nextRole === "user" || nextRole === "system") {
      return false;
    }
  }
  return false;
}

function extractAnyToolCalls(
  message: Dict,
  text: string,
  toolsEnabled: boolean,
): Dict[] | null {
  if (!toolsEnabled) return null;
  const tc = message.tool_calls;
  if (Array.isArray(tc) && tc.length > 0) return normalizeToolCalls(tc);
  return parseToolCallsText(text);
}

export function convertIncomingMessage(
  message: Dict,
  toolsEnabled: boolean,
  allowStructuredToolCalls: boolean,
): Dict | null {
  let role: string = message.role ?? "user";
  let text = normalizeMessageText(message);
  const anyToolCalls = extractAnyToolCalls(message, text, toolsEnabled);
  let structuredToolCalls: Dict[] | null = null;
  if (toolsEnabled && allowStructuredToolCalls) {
    structuredToolCalls = extractAnyToolCalls(message, text, true);
  }

  if (role === "assistant" && structuredToolCalls !== null) {
    return buildAssistantToolCallMessage(text, structuredToolCalls);
  }

  if (
    role === "assistant" &&
    anyToolCalls !== null &&
    !allowStructuredToolCalls
  ) {
    return buildStructuredMessage(
      "assistant",
      summarizeUnresolvedToolCalls(anyToolCalls),
    );
  }

  const tc = message.tool_calls;
  if (!toolsEnabled && Array.isArray(tc) && tc.length > 0) {
    text = joinSections(text, renderToolCalls(tc));
  }

  if (role === "tool") {
    if (toolsEnabled) return buildToolMessage(message, text);
    role = "user";
    text = renderToolResult(message, text);
  }

  const images = role === "user" ? extractMessageImages(message) : [];
  if (images.length) {
    text = text
      .split("\n\n")
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith("[image] "))
      .join("\n\n");
  }

  if (!text.trim() && images.length === 0) return null;

  if (role === "user") return buildUserMessage(text, images);

  return buildStructuredMessage(role, text);
}

export function buildQoderMessages(
  incomingMessages: Dict[],
  prompt: string,
  toolsEnabled: boolean,
): Dict[] {
  const rebuilt: Dict[] = [];

  if (incomingMessages.length) {
    for (let i = 0; i < incomingMessages.length; i++) {
      const allowStructured =
        toolsEnabled && hasResolvedToolResponse(incomingMessages, i);
      const converted = convertIncomingMessage(
        incomingMessages[i]!,
        toolsEnabled,
        allowStructured,
      );
      if (converted !== null) rebuilt.push(converted);
    }
  }

  if (rebuilt.length === 0 && prompt.trim()) {
    rebuilt.push(buildUserMessage(prompt));
  }

  return rebuilt;
}

export function applyOpenaiToolConfig(body: Dict, reqBody: Dict): boolean {
  const incomingTools = reqBody.tools;
  const toolsEnabled =
    Array.isArray(incomingTools) && incomingTools.length > 0;
  if (toolsEnabled) {
    body.tools = structuredClone(incomingTools);
  } else {
    delete body.tools;
  }
  if ("tool_choice" in reqBody) {
    body.tool_choice = structuredClone(reqBody.tool_choice);
  } else {
    delete body.tool_choice;
  }
  if ("parallel_tool_calls" in reqBody) {
    body.parallel_tool_calls = reqBody.parallel_tool_calls;
  } else {
    delete body.parallel_tool_calls;
  }
  return toolsEnabled;
}

export function extractLatestUserPrompt(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === "user") {
      const text = normalizeMessageText(message);
      if (text.trim()) return text;
    }
  }
  return "";
}

export function makeChunk(reqId: string, created: number, model: string): Dict {
  return {
    id: reqId,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: null }],
  };
}

export function makeSseChunk(
  reqId: string,
  created: number,
  model: string,
  role: string | null,
  content: string | null,
  reasoningContent: string | null,
  toolCalls: Dict[] | null,
): string {
  const chunk = makeChunk(reqId, created, model);
  const delta = chunk.choices[0].delta;
  if (role) delta.role = role;
  if (content) delta.content = content;
  if (reasoningContent) delta.reasoning_content = reasoningContent;
  if (toolCalls && toolCalls.length > 0) delta.tool_calls = toolCalls;
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

function parseInnerBody(dataLine: string): Dict | null {
  try {
    const wrapper = JSON.parse(dataLine);
    if (typeof wrapper !== "object" || wrapper === null || Array.isArray(wrapper)) {
      return null;
    }
    if ("body" in wrapper) {
      const inner = wrapper.body;
      if (typeof inner === "object" && inner !== null && !Array.isArray(inner)) {
        return inner as Dict;
      }
      if (typeof inner !== "string" || !inner) return null;
      const parsed = JSON.parse(inner);
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Dict)
        : null;
    }
    const isChunk =
      "choices" in wrapper ||
      "usage" in wrapper ||
      wrapper.object === "chat.completion.chunk" ||
      wrapper.object === "chat.completion";
    return isChunk ? (wrapper as Dict) : null;
  } catch {
    return null;
  }
}

function deltaFromInner(innerJson: Dict | null): BridgeDelta {
  if (innerJson === null) return new BridgeDelta();
  for (const ch of innerJson.choices ?? []) {
    const delta = ch?.delta ?? {};
    const role: string = delta.role ?? "";
    const content: string = delta.content ?? "";
    const reasoningContent: string = delta.reasoning_content ?? "";
    const tc = delta.tool_calls;
    const toolCalls =
      Array.isArray(tc) && tc.length > 0 ? structuredClone(tc) : null;
    if (role || content || reasoningContent || toolCalls !== null) {
      return new BridgeDelta(role, content, reasoningContent, toolCalls);
    }
  }
  return new BridgeDelta();
}

const USAGE_TOKEN_KEYS = [
  "prompt_tokens",
  "completion_tokens",
  "total_tokens",
  "input_tokens",
  "output_tokens",
];

function hasTokenCounts(usage: unknown): boolean {
  if (typeof usage !== "object" || usage === null || Array.isArray(usage)) {
    return false;
  }
  const u = usage as Dict;
  return USAGE_TOKEN_KEYS.some((k) => {
    const v = u[k];
    if (typeof v === "number") return Number.isFinite(v);
    if (typeof v !== "string" || !v.trim()) return false;
    return Number.isFinite(Number(v));
  });
}

export function findUsage(innerJson: Dict | null): Dict | null {
  if (innerJson === null) return null;
  const candidates: unknown[] = [innerJson.usage, innerJson.response_meta?.usage];
  for (const ch of innerJson.choices ?? []) {
    candidates.push(ch?.usage, ch?.response_meta?.usage);
  }
  for (const c of candidates) {
    if (hasTokenCounts(c)) return structuredClone(c) as Dict;
  }
  return null;
}

export interface UpstreamEvent {
  delta: BridgeDelta;
  usage: Dict | null;
}

export function extractStreamEvent(dataLine: string): UpstreamEvent {
  const innerJson = parseInnerBody(dataLine);
  return { delta: deltaFromInner(innerJson), usage: findUsage(innerJson) };
}

export function extractDelta(dataLine: string): BridgeDelta {
  return deltaFromInner(parseInnerBody(dataLine));
}
