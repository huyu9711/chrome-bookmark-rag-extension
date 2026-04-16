/**
 * Minimal OpenAI-compatible mock for local dev.
 * Run: npm run mock-server
 *
 * Options example:
 *   Embeddings: base http://127.0.0.1:8787/v1  path embeddings  (i.e. http://127.0.0.1:8787/v1/embeddings)
 *   Chat:       base http://127.0.0.1:8787/v1  path chat/completions
 */

import http from "node:http";

const PORT = 8787;

function json(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname.replace(/\/+$/, "");

  try {
    if (req.method === "POST" && path === "/v1/embeddings") {
      const body = await parseBody(req);
      if (body.encoding_format != null && body.encoding_format !== "float") {
        return json(res, 400, {
          error: { message: `unsupported encoding_format: ${body.encoding_format}` },
        });
      }
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      const data = inputs.map((_, i) => ({
        object: "embedding",
        index: i,
        embedding: new Array(8).fill(0).map((_, j) => (i + j) * 0.01),
      }));
      return json(res, 200, {
        object: "list",
        data,
        model: body.model || "mock",
        usage: { prompt_tokens: 1, total_tokens: 1 },
      });
    }

    if (req.method === "POST" && path === "/v1/responses") {
      const body = await parseBody(req);
      const input = String(body.input ?? "");
      return json(res, 200, {
        id: "resp-mock-1",
        object: "response",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: `Mock responses API. Input: ${input.slice(0, 120)}` }],
          },
        ],
        model: body.model || "mock",
      });
    }

    if (req.method === "POST" && path === "/v1/chat/completions") {
      const body = await parseBody(req);
      const last = body.messages?.[body.messages.length - 1]?.content ?? "";
      return json(res, 200, {
        id: "mock-1",
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: `Mock reply. You said: ${String(last).slice(0, 200)}`,
            },
            finish_reason: "stop",
          },
        ],
        model: body.model || "mock",
      });
    }

    if (req.method === "POST" && path === "/v1/completions") {
      const body = await parseBody(req);
      const p = String(body.prompt ?? "");
      return json(res, 200, {
        id: "mock-comp-1",
        object: "text_completion",
        choices: [
          {
            index: 0,
            text: `Mock completion. Prompt: ${p.slice(0, 200)}`,
            finish_reason: "stop",
          },
        ],
        model: body.model || "mock",
      });
    }

    if (req.method === "GET" && path === "/health") {
      return json(res, 200, { ok: true });
    }

    json(res, 404, { error: { message: "Not Found", type: "invalid_request_error" }, detail: "Not Found" });
  } catch (e) {
    json(res, 500, { error: { message: String(e) } });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`OpenAI-compatible mock at http://127.0.0.1:${PORT}`);
  console.log("  POST /v1/embeddings");
  console.log("  POST /v1/chat/completions");
  console.log("Example Options:");
  console.log("  RAG base: http://127.0.0.1:8787/v1   embeddings path: embeddings");
  console.log("  QA base:  http://127.0.0.1:8787/v1   chat path: chat/completions");
});
