import { readFile } from "node:fs/promises";
import { join } from "node:path";
import Fastify from "fastify";
import type { ConfirmRequest, ExpandRequest, StartSessionRequest } from "../shared/types.js";
import { ExplorationEngine } from "./engine.js";
import { createEngineDeps } from "./providers.js";
import { TraceStore } from "./trace-store.js";

const traceStore = new TraceStore();
const engine = new ExplorationEngine(
  createEngineDeps({
    provider: (process.env.LLM_PROVIDER as "auto" | "minimax" | "kimi" | undefined) ?? "auto",
    minimaxApiKey: process.env.MINIMAX_API_KEY,
    minimaxBaseUrl: process.env.MINIMAX_BASE_URL,
    minimaxModel: process.env.MINIMAX_MODEL,
    apiKey: process.env.KIMI_API_KEY,
    baseUrl: process.env.KIMI_BASE_URL,
    model: process.env.KIMI_MODEL,
  }),
  traceStore,
);

function htmlShell(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Keyword Star Atlas</title>
  <style>
    :root {
      --bg-1: #020612;
      --bg-2: #05142f;
      --gold: #d4b36f;
      --line: #7e9bc5;
      --text: #e7edf8;
      --panel: rgba(10, 19, 40, 0.72);
      --muted: #9fb2d6;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Space Grotesk", "Segoe UI", sans-serif;
      color: var(--text);
      background: radial-gradient(circle at 20% 20%, #113066, transparent 45%),
        radial-gradient(circle at 80% 10%, #2a2054, transparent 38%),
        linear-gradient(160deg, var(--bg-1), var(--bg-2));
      min-height: 100vh;
    }
    .layout {
      display: grid;
      grid-template-columns: 2fr 1fr;
      gap: 16px;
      padding: 16px;
    }
    .atlas, .panel {
      background: var(--panel);
      border: 1px solid rgba(212, 179, 111, 0.35);
      border-radius: 14px;
      backdrop-filter: blur(3px);
    }
    .atlas { padding: 16px; }
    .panel { padding: 12px; max-height: calc(100vh - 32px); overflow: auto; }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
    }
    #start-form { display: flex; gap: 8px; }
    #keyword-input {
      width: 280px;
      border: 1px solid rgba(212, 179, 111, 0.45);
      border-radius: 10px;
      background: rgba(7, 16, 34, 0.8);
      color: var(--text);
      padding: 10px;
    }
    button {
      border: 1px solid rgba(212, 179, 111, 0.6);
      border-radius: 10px;
      background: linear-gradient(145deg, #273252, #13233f);
      color: var(--text);
      padding: 10px 14px;
      cursor: pointer;
    }
    #status { color: var(--muted); }
    .link { fill: none; stroke: var(--line); stroke-opacity: 0.7; stroke-width: 1.2; }
    .star-node { fill: #dbe8ff; stroke: var(--gold); stroke-width: 2; }
    .selected-node { stroke: #64c7ff; stroke-width: 3.2; }
    .root-node { fill: #ffe5a9; stroke: #f0bf62; stroke-width: 2.4; }
    .leaf-node { fill: #b8e8ff; stroke: #64c7ff; stroke-width: 2; }
    .node-label { fill: var(--text); font-size: 12px; }
    .direction-hint { fill: #9fb2d6; font-size: 12px; }
    .panel-card {
      border: 1px solid rgba(126, 155, 197, 0.4);
      background: rgba(6, 14, 29, 0.65);
      border-radius: 10px;
      padding: 10px;
      margin-bottom: 8px;
      font-size: 13px;
      line-height: 1.4;
    }
    .panel-title { color: var(--gold); margin-bottom: 6px; font-weight: 600; }
    .trace-item {
      border-left: 2px solid rgba(212, 179, 111, 0.6);
      padding: 8px 10px;
      margin-bottom: 8px;
      background: rgba(6, 14, 29, 0.65);
      border-radius: 8px;
      font-size: 12px;
    }
    .trace-head { color: var(--gold); margin-bottom: 4px; }
    .trace-time { color: var(--muted); margin-top: 3px; }
    @media (max-width: 960px) {
      .layout { grid-template-columns: 1fr; }
      #keyword-input { width: 100%; }
      #start-form { width: 100%; }
    }
  </style>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&display=swap" rel="stylesheet" />
</head>
<body>
  <div class="layout">
    <section class="atlas">
      <div class="header">
        <form id="start-form">
          <input id="keyword-input" placeholder="Enter a seed keyword..." />
          <button type="submit">Launch Exploration</button>
          <button type="button" id="confirm-btn" disabled>Confirm Path</button>
        </form>
        <div id="status">No active session · Shift+click a node to select, then Confirm</div>
      </div>
      <svg id="tree" width="100%" height="560" viewBox="0 0 1000 560" preserveAspectRatio="xMinYMin meet"></svg>
    </section>

    <aside class="panel">
      <div class="panel-title">Direction & Persona</div>
      <div id="rounds"></div>
      <div class="panel-title">LLM + Tool Trace</div>
      <div id="trace"></div>
    </aside>
  </div>
  <script src="https://cdn.jsdelivr.net/npm/d3@7"></script>
  <script type="module" src="/client.js"></script>
</body>
</html>`;
}

async function readClientBundle(): Promise<string> {
  const candidates = [
    join(process.cwd(), "dist", "src", "client", "client.js"),
    join(process.cwd(), "dist", "client", "client.js"),
  ];

  for (const filePath of candidates) {
    try {
      return await readFile(filePath, "utf8");
    } catch {
      // Try next candidate path.
    }
  }

  throw new Error("Client bundle not found. Run npm run build first.");
}

export function buildApp() {
  const app = Fastify({ logger: false });

  app.get("/", async (_req, reply) => {
    reply.type("text/html; charset=utf-8").send(htmlShell());
  });

  app.get("/client.js", async (_req, reply) => {
    const script = await readClientBundle();
    reply.type("text/javascript; charset=utf-8").send(script);
  });

  app.post<{ Body: StartSessionRequest }>("/api/start", async (req) => {
    return engine.start(req.body.keyword);
  });

  app.post<{ Body: ExpandRequest }>("/api/expand", async (req) => {
    return engine.expand(req.body.sessionId, req.body.rootNodeId);
  });

  app.post<{ Body: ConfirmRequest }>("/api/confirm", async (req) => {
    return engine.confirm(req.body.sessionId, req.body.nodeId);
  });

  app.get<{ Params: { sessionId: string } }>("/api/session/:sessionId", async (req) => {
    const session = engine.getSession(req.params.sessionId);
    if (!session) {
      throw new Error("Session not found");
    }
    return session;
  });

  app.get<{ Params: { sessionId: string } }>("/api/trace/:sessionId", async (req) => {
    return traceStore.getTimeline(req.params.sessionId);
  });

  app.get<{ Params: { sessionId: string; eventId: string } }>(
    "/api/trace/:sessionId/event/:eventId",
    async (req, reply) => {
      const event = traceStore.getEvent(req.params.sessionId, req.params.eventId);
      if (!event) {
        return reply.status(404).send({ message: "Trace event not found" });
      }
      return event;
    },
  );

  return app;
}
