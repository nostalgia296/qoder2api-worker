import {
  type AuthIdentity,
  type MachineIdentity,
  type RegionConfig,
  type SessionContext,
  CN,
  DEFAULT_SECRET,
  QoderAuthError,
  chatUrl,
  exchangeJobToken,
  fetchModelCatalog,
  newSession,
  openStreamLines,
  refreshJobToken,
} from "./qoder_auth";
import {
  ModelCatalog,
  UnsupportedModelError,
  defaultCatalog,
  extractCatalog,
  modelsPayload,
  resolveModel,
} from "./models";
import {
  StreamAccumulator,
  ToolCallAccumulator,
  applyOpenaiToolConfig,
  buildQoderMessages,
  extractLatestUserPrompt,
  extractMessageImages,
  extractStreamEvent,
  makeChunk,
  parseToolCallsText,
} from "./transform";
import { cloneTemplate } from "./baseprompt";

const REFRESH_MARGIN_MS = 2 * 3600 * 1000;
const CATALOG_TTL_MS = 600 * 1000;

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export interface Env {
  BRIDGE: DurableObjectNamespace;
  QODER_SIGNATURE_SECRET?: string;
}

interface StoredState {
  machineId: string;
  machineToken: string;
  machineType: string;
  identity: AuthIdentity | null;
  expireTimeMs: number;
}

function generateMachineIdentity(): MachineIdentity {
  const machineId = crypto.randomUUID();
  const raw =
    (crypto.randomUUID().replace(/-/g, "") +
      crypto.randomUUID().replace(/-/g, ""))
      .slice(0, 50);
  const machineToken = btoa(raw)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const machineType = crypto.randomUUID().replace(/-/g, "").slice(0, 18);
  return { machineId, machineToken, machineType };
}

function openaiErrorResponse(e: unknown): Response {
  if (e instanceof ValidationError || e instanceof UnsupportedModelError) {
    return Response.json(
      { error: { message: e.message, type: "invalid_request_error" } },
      { status: 400 },
    );
  }
  const message = e instanceof Error ? e.message : String(e);
  return Response.json(
    { error: { message, type: "qoder_error" } },
    { status: 500 },
  );
}

export class QoderBridgeDO {
  private region: RegionConfig = CN;
  private pat = "";

  private loaded = false;
  private loadP: Promise<void> | null = null;
  private refreshP: Promise<void> | null = null;
  private bootstrapped = false;

  private machine: MachineIdentity = {
    machineId: "",
    machineToken: "",
    machineType: "",
  };
  private identity: AuthIdentity | null = null;
  private sess: SessionContext | null = null;
  private expireTimeMs = 0;

  private catalog: ModelCatalog | null = null;
  private catalogTs = 0;

  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {}

  private get secret(): string {
    return this.env.QODER_SIGNATURE_SECRET || DEFAULT_SECRET;
  }

  async fetch(request: Request): Promise<Response> {
    this.pat = request.headers.get("x-qoder-pat") ?? "";
    try {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/v1/models") {
        return await this.modelsResponse();
      }
      if (
        request.method === "POST" &&
        url.pathname === "/v1/chat/completions"
      ) {
        const reqBody = (await request.json()) as Record<string, any>;
        return await this.handleChat(reqBody);
      }
      return new Response("Not Found", { status: 404 });
    } catch (e) {
      return openaiErrorResponse(e);
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loadP ??= this.load();
    await this.loadP;
  }

  private async load(): Promise<void> {
    try {
      const stored = await this.state.storage.get<StoredState>("state");
      if (stored?.machineId) {
        this.machine = {
          machineId: stored.machineId,
          machineToken: stored.machineToken,
          machineType: stored.machineType,
        };
        if (stored.identity) {
          this.identity = stored.identity;
          this.expireTimeMs = stored.expireTimeMs || 0;
          this.bootstrapped = true;
          this.sess = await newSession(
            this.identity,
            this.machine.machineId,
            this.machine.machineToken,
            this.machine.machineType,
          );
        }
      } else {
        this.machine = generateMachineIdentity();
        await this.persist();
      }
    } finally {
      this.loaded = true;
    }
  }

  private async persist(): Promise<void> {
    const stored: StoredState = {
      machineId: this.machine.machineId,
      machineToken: this.machine.machineToken,
      machineType: this.machine.machineType,
      identity: this.identity,
      expireTimeMs: this.expireTimeMs,
    };
    await this.state.storage.put("state", stored);
  }

  private needsRefresh(): boolean {
    return (
      this.sess === null ||
      this.expireTimeMs === 0 ||
      Date.now() > this.expireTimeMs - REFRESH_MARGIN_MS
    );
  }

  private async ensureFreshSession(): Promise<void> {
    await this.ensureLoaded();
    if (this.bootstrapped && !this.needsRefresh()) return;
    this.refreshP ??= this.renewOrBootstrap().finally(() => {
      this.refreshP = null;
    });
    await this.refreshP;
  }

  private async renewOrBootstrap(): Promise<void> {
    if (!this.bootstrapped) {
      await this.bootstrapSession();
      return;
    }
    if (!this.needsRefresh()) return;
    await this.doRenew(false);
  }

  private async bootstrapSession(): Promise<void> {
    const jt = await exchangeJobToken(
      this.pat,
      this.machine,
      this.region,
      this.secret,
    );
    console.log(
      `[bridge] session for ${jt?.name ?? ""} (${jt?.id ?? ""}) ` +
        `[${this.region.name}] exp=${jt?.expireTime}`,
    );
    await this.applyJobToken(jt);
    this.bootstrapped = true;
    await this.persist();
  }

  private async applyJobToken(jt: Record<string, any>): Promise<void> {
    const identity: AuthIdentity = {
      name: jt?.name ?? "",
      aid: jt?.id ?? "",
      uid: jt?.id ?? "",
      yxUid: "",
      organizationId: "",
      organizationName: "",
      userType: jt?.userType ?? "personal_standard",
      securityOauthToken: jt?.securityOauthToken ?? "",
      refreshToken: jt?.refreshToken ?? "",
    };
    this.identity = identity;
    const rawExp = jt?.expireTime ?? 0;
    const exp =
      typeof rawExp === "number" ? rawExp : parseInt(String(rawExp), 10);
    this.expireTimeMs = Number.isFinite(exp) ? exp : 0;
    this.sess = await newSession(
      identity,
      this.machine.machineId,
      this.machine.machineToken,
      this.machine.machineType,
    );
  }

  private async doRenew(force: boolean): Promise<void> {
    const ident = this.identity;
    if (!ident) throw new Error("session not bootstrapped");
    let jt: Record<string, any>;
    try {
      jt = await refreshJobToken(
        this.pat,
        ident.refreshToken,
        ident.securityOauthToken,
        this.machine,
        this.region,
        this.secret,
      );
      console.log(
        `[bridge] session ${force ? "force-refreshed" : "refreshed"} ` +
          `(exp=${jt?.expireTime})`,
      );
    } catch (e) {
      if (!force || !(e instanceof QoderAuthError)) throw e;
      console.log(`[bridge] refresh rejected (${e}); falling back to PAT exchange`);
      jt = await exchangeJobToken(this.pat, this.machine, this.region, this.secret);
      console.log(`[bridge] PAT re-exchange ok (exp=${jt?.expireTime})`);
    }
    await this.applyJobToken(jt);
    await this.persist();
  }

  private async forceRefresh(): Promise<void> {
    this.refreshP ??= this.doRenew(true).finally(() => {
      this.refreshP = null;
    });
    await this.refreshP;
  }

  private async getCatalog(): Promise<ModelCatalog> {
    const now = Date.now();
    if (this.catalog !== null && now - this.catalogTs < CATALOG_TTL_MS) {
      return this.catalog;
    }
    let fetched: ModelCatalog | null = null;
    try {
      await this.ensureFreshSession();
      if (this.sess === null) throw new Error("session not bootstrapped");
      const raw = await fetchModelCatalog(this.sess, this.region);
      fetched =
        typeof raw === "object" && raw !== null ? extractCatalog(raw) : null;
      if (fetched) {
        console.log(
          `[models] dynamic catalog loaded: ${fetched.keys().length} models ` +
            `[${fetched.keys().join(", ")}]`,
        );
      } else {
        console.log(
          "[models] WARN model/list response shape unexpected; using fallback",
        );
      }
    } catch (e) {
      console.log(`[models] WARN dynamic fetch failed (${e}); using fallback`);
    }
    const cat = fetched ?? defaultCatalog();
    this.catalog = cat;
    this.catalogTs = now;
    return cat;
  }

  private async modelsResponse(): Promise<Response> {
    try {
      return Response.json(modelsPayload(await this.getCatalog()));
    } catch (e) {
      console.log(`[models] WARN /v1/models dynamic failed (${e}); fallback`);
      return Response.json(modelsPayload());
    }
  }

  private async handleChat(reqBody: Record<string, any>): Promise<Response> {
    await this.ensureFreshSession();
    if (this.identity === null) throw new Error("session not bootstrapped");
    const stream = reqBody.stream === true;
    const modelParam = reqBody.model;
    const catalog = await this.getCatalog();
    const [openaiModel, qoderModel] = resolveModel(modelParam ?? null, catalog);
    const messages: any[] = reqBody.messages ?? [];

    const body = cloneTemplate();
    const nid = crypto.randomUUID();
    body.request_id = nid;
    body.chat_record_id = nid;
    body.request_set_id = crypto.randomUUID();
    body.session_id = crypto.randomUUID();
    body.stream = true;
    body.aliyun_user_type = this.identity.userType;
    body.model_config.key = qoderModel;
    body.model_config.is_reasoning = true;
    body.chat_context.extra.modelConfig.key = qoderModel;
    body.chat_context.extra.modelConfig.is_reasoning = true;
    body.business.id = crypto.randomUUID();
    body.business.begin_at = Date.now();

    const prompt = extractLatestUserPrompt(messages);
    body.chat_context.text.text = prompt;
    body.chat_context.extra.originalContent.text = prompt;
    body.business.name = prompt.length > 30 ? prompt.slice(0, 30) : prompt;

    const toolsEnabled = applyOpenaiToolConfig(body, reqBody);
    body.messages = buildQoderMessages(messages, prompt, toolsEnabled);

    const hasImages = messages.some(
      (m) =>
        typeof m === "object" &&
        m !== null &&
        extractMessageImages(m).length > 0,
    );
    if (hasImages) {
      if (!catalog.visionModels.has(openaiModel)) {
        const supported = [...catalog.visionModels].sort().join(", ") || "(none)";
        throw new ValidationError(
          `Image input is not supported by model '${openaiModel}'. ` +
            `Use one of: ${supported}.`,
        );
      }
      body.model_config.is_vl = true;
      body.chat_context.extra.modelConfig.is_vl = true;
      const imgCount = messages.reduce(
        (n, m) =>
          typeof m === "object" && m !== null
            ? n + extractMessageImages(m).length
            : n,
        0,
      );
      console.log(
        `[bridge] multimodal: ${imgCount} image(s) attached [${openaiModel}]`,
      );
    }

    console.log(
      `[bridge] chat req: prompt_len=${prompt.length} model=${openaiModel}`,
    );

    const url = chatUrl(this.region);
    const extraHeaders = {
      "x-model-key": qoderModel,
      "x-model-source": body.model_config.source ?? "system",
    };

    const reqId =
      "chatcmpl-" + crypto.randomUUID().replace(/-/g, "").slice(0, 24);
    const created = Math.floor(Date.now() / 1000);

    if (stream) {
      return this.handleStream(
        body,
        url,
        extraHeaders,
        reqId,
        created,
        openaiModel,
        toolsEnabled,
        reqBody.stream_options?.include_usage === true,
      );
    }
    return Response.json(
      await this.handleSync(
        body,
        url,
        extraHeaders,
        reqId,
        created,
        openaiModel,
        toolsEnabled,
      ),
    );
  }

  private async *openStreamWithRetry(
    url: string,
    body: Record<string, any>,
    extraHeaders: Record<string, string>,
  ): AsyncGenerator<string> {
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (this.sess === null) throw new Error("session not bootstrapped");
      let produced = false;
      try {
        for await (const line of openStreamLines(
          this.sess,
          url,
          body,
          extraHeaders,
        )) {
          produced = true;
          yield line;
        }
        return;
      } catch (e) {
        if (!(e instanceof QoderAuthError)) throw e;
        if (produced) throw e;
        if (attempt >= 2) throw e;
        console.log(
          `[bridge] auth error before any content (${e}); ` +
            "refreshing and retrying once",
        );
        try {
          await this.forceRefresh();
        } catch (rf) {
          console.log(`[bridge] reactive refresh failed: ${rf}`);
          throw rf;
        }
      }
    }
  }

  private handleStream(
    body: Record<string, any>,
    url: string,
    extraHeaders: Record<string, string>,
    reqId: string,
    created: number,
    model: string,
    toolsEnabled: boolean,
    includeUsage: boolean,
  ): Response {
    const encoder = new TextEncoder();
    const self = this;
    let upstream: AsyncGenerator<string> | null = null;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const acc = new StreamAccumulator(
          reqId,
          created,
          model,
          toolsEnabled,
          (chunk) => controller.enqueue(encoder.encode(chunk)),
        );
        let usage: Record<string, any> | null = null;
        try {
          upstream = self.openStreamWithRetry(url, body, extraHeaders);
          for await (const line of upstream) {
            if (!line.startsWith("data:")) continue;
            const event = extractStreamEvent(line.slice(5).trim());
            if (event.usage !== null) usage = event.usage;
            if (!event.delta.isEmpty()) acc.accept(event.delta);
          }
          acc.flush();

          const done = makeChunk(reqId, created, model);
          done.choices[0].finish_reason = acc.finishReason();
          done.choices[0].delta = {};
          if (usage !== null && !includeUsage) done.usage = usage;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(done)}\n\n`));

          if (usage !== null && includeUsage) {
            const usageChunk = makeChunk(reqId, created, model);
            usageChunk.choices = [];
            usageChunk.usage = usage;
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(usageChunk)}\n\n`),
            );
          }
        } catch (e) {
          console.log(`[bridge] stream error: ${e}`);
          try {
            const errChunk = makeChunk(reqId, created, model);
            errChunk.choices[0].finish_reason = "error";
            errChunk.choices[0].delta = {};
            errChunk.error = {
              message: e instanceof Error ? e.message : String(e),
              type: "qoder_error",
            };
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(errChunk)}\n\n`),
            );
          } catch (inner) {
            console.log(
              `[bridge] failed to emit stream error chunk: ${inner}`,
            );
          }
        } finally {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        }
      },
      cancel() {
        if (upstream) void upstream.return(undefined).catch(() => {});
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      },
    });
  }

  private async handleSync(
    body: Record<string, any>,
    url: string,
    extraHeaders: Record<string, string>,
    reqId: string,
    created: number,
    model: string,
    toolsEnabled: boolean,
  ): Promise<Record<string, any>> {
    const fullContent: string[] = [];
    const fullReasoningContent: string[] = [];
    const toolCalls = new ToolCallAccumulator();
    let usage: Record<string, any> | null = null;

    for await (const line of this.openStreamWithRetry(url, body, extraHeaders)) {
      if (!line.startsWith("data:")) continue;
      const event = extractStreamEvent(line.slice(5).trim());
      if (event.usage !== null) usage = event.usage;
      const delta = event.delta;
      if (delta.reasoningContent) fullReasoningContent.push(delta.reasoningContent);
      if (delta.content) fullContent.push(delta.content);
      if (delta.toolCalls && delta.toolCalls.length > 0) {
        toolCalls.append(delta.toolCalls);
      }
    }

    const fullText = fullContent.join("");
    let fallbackToolCalls: Record<string, any>[] | null = null;
    if (toolCalls.isEmpty() && toolsEnabled) {
      fallbackToolCalls = parseToolCallsText(fullText);
    }

    const msg: Record<string, any> = { role: "assistant" };
    if (fallbackToolCalls !== null) {
      msg.content = null;
      msg.tool_calls = fallbackToolCalls;
    } else if (!fullText && !toolCalls.isEmpty()) {
      msg.content = null;
    } else {
      msg.content = fullText;
    }
    if (fullReasoningContent.length) {
      msg.reasoning_content = fullReasoningContent.join("");
    }
    if (!toolCalls.isEmpty()) {
      msg.tool_calls = toolCalls.snapshot();
    }

    const finishReason =
      !toolCalls.isEmpty() || fallbackToolCalls !== null
        ? "tool_calls"
        : "stop";

    return {
      id: reqId,
      object: "chat.completion",
      created,
      model,
      choices: [{ index: 0, message: msg, finish_reason: finishReason }],
      usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  }
}
