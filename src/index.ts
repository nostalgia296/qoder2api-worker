import { type Env, QoderBridgeDO } from "./bridge_do";
import { modelsPayload } from "./models";

export { QoderBridgeDO };

function extractPat(request: Request): string | null {
  const auth = request.headers.get("Authorization") ?? "";
  if (auth.startsWith("Bearer ")) {
    const token = auth.slice(7).trim();
    if (token) return token;
  }
  return null;
}

async function patKey(pat: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`cn:${pat}`),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  )
    .join("")
    .slice(0, 16);
}

function forwardRequest(
  request: Request,
  pat: string,
  withBody: boolean,
): Request {
  const headers = new Headers(request.headers);
  headers.delete("Authorization");
  headers.set("x-qoder-pat", pat);
  return new Request(request.url, {
    method: request.method,
    headers,
    body: withBody ? request.body : undefined,
    // @ts-expect-error duplex 是转发流式 body 所需的运行时选项
    duplex: withBody ? "half" : undefined,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (
      request.method === "POST" &&
      url.pathname === "/v1/chat/completions"
    ) {
      const pat = extractPat(request);
      if (!pat) {
        return Response.json(
          {
            error: {
              message: "Missing Authorization: Bearer <PAT>",
              type: "invalid_request_error",
            },
          },
          { status: 401 },
        );
      }
      const stub = env.BRIDGE.get(env.BRIDGE.idFromName(await patKey(pat)));
      return stub.fetch(forwardRequest(request, pat, true));
    }

    if (request.method === "GET" && url.pathname === "/v1/models") {
      const pat = extractPat(request);
      if (pat) {
        try {
          const stub = env.BRIDGE.get(
            env.BRIDGE.idFromName(await patKey(pat)),
          );
          return await stub.fetch(forwardRequest(request, pat, false));
        } catch (e) {
          console.log(`[models] WARN /v1/models dynamic failed (${e}); fallback`);
        }
      }
      return Response.json(modelsPayload());
    }

    return new Response("Not Found", { status: 404 });
  },
};
