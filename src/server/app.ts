import { readFile } from "node:fs/promises";
import { join } from "node:path";
import Fastify from "fastify";
import type {
  BacktraceRequest,
  ConfirmRequest,
  EvidenceProviderId,
  EvidenceProviderInfo,
  ExpandRequest,
  LlmProviderId,
  LlmProviderInfo,
  StartSessionRequest,
} from "../shared/types.js";
import { ExplorationEngine, type EngineBinding, type EngineDeps } from "./engine.js";
import {
  createEvidenceProvider,
  listAvailableEvidenceProviders,
  resolveDefaultEvidenceProvider,
} from "./evidence-providers.js";
import {
  createEngineDeps,
  listAvailableLlmProviders,
  resolveDefaultLlmProvider,
  type LlmEnvConfig,
} from "./providers.js";
import { TraceStore } from "./trace-store.js";

function readLlmEnvConfig(): LlmEnvConfig {
  return {
    minimaxApiKey: process.env.MINIMAX_API_KEY,
    minimaxBaseUrl: process.env.MINIMAX_BASE_URL,
    minimaxModel: process.env.MINIMAX_MODEL,
    apiKey: process.env.KIMI_API_KEY,
    baseUrl: process.env.KIMI_BASE_URL,
    model: process.env.KIMI_MODEL,
    deepseekApiKey: process.env.DEEPSEEK_API_KEY,
    deepseekChatUrl: process.env.DEEPSEEK_CHAT_COMPLETIONS_URL,
    deepseekModel: process.env.DEEPSEEK_MODEL,
  };
}

function createProductionBinding(): EngineBinding {
  const envConfig = readLlmEnvConfig();
  const available = listAvailableLlmProviders(envConfig);
  if (available.length === 0) {
    throw new Error(
      "No LLM API key configured. Set KIMI_API_KEY, DEEPSEEK_API_KEY, or MINIMAX_API_KEY.",
    );
  }

  const defaultProvider = resolveDefaultLlmProvider(process.env.LLM_PROVIDER, available);
  const availableEvidenceProviders = listAvailableEvidenceProviders();
  const defaultEvidenceProvider = resolveDefaultEvidenceProvider(
    process.env.EVIDENCE_PROVIDER,
    availableEvidenceProviders,
  );

  return {
    defaultProvider,
    defaultEvidenceProvider,
    resolve(session: { llmProvider: LlmProviderId; evidenceProvider: EvidenceProviderId }) {
      const searchEvidence = createEvidenceProvider(session.evidenceProvider, {
        openAlexMailto: process.env.OPENALEX_MAILTO,
        semanticScholarApiKey: process.env.SEMANTIC_SCHOLAR_API_KEY,
      });
      return createEngineDeps({ ...envConfig, provider: session.llmProvider, searchEvidence });
    },
  };
}

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
    .atlas { padding: 16px; overflow: auto; }
    #tree { display: block; width: 100%; min-height: 360px; }
    .panel { padding: 12px; max-height: calc(100vh - 32px); overflow: auto; }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
    }
    #start-form { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    #keyword-input, #llm-provider, #evidence-provider {
      border: 1px solid rgba(212, 179, 111, 0.45);
      border-radius: 10px;
      background: rgba(7, 16, 34, 0.8);
      color: var(--text);
      padding: 10px;
    }
    #keyword-input { width: 280px; }
    #llm-provider, #evidence-provider { min-width: 170px; cursor: pointer; }
    button {
      border: 1px solid rgba(212, 179, 111, 0.6);
      border-radius: 10px;
      background: linear-gradient(145deg, #273252, #13233f);
      color: var(--text);
      padding: 10px 14px;
      cursor: pointer;
    }
    #status { color: var(--muted); }
    .link { fill: none; stroke: var(--line); stroke-width: 1.4; }
    .spine-link { stroke: var(--gold); stroke-opacity: 0.85; }
    .tree-link { stroke: var(--gold); stroke-opacity: 0.75; fill: none; }
    .turn-link { stroke: var(--gold); stroke-opacity: 0.55; stroke-dasharray: 6 4; }
    .leaf-link { stroke: var(--line); stroke-opacity: 0.7; }
    .star-node { fill: #dbe8ff; stroke: var(--gold); stroke-width: 2; }
    .selected-node { stroke: #64c7ff; stroke-width: 3.2; }
    .highlighted-node { stroke: #ff9de2; stroke-width: 3.4; filter: drop-shadow(0 0 4px rgba(255, 157, 226, 0.8)); }
    .confirmed-node { fill: #ffe5a9; stroke: #f0bf62; stroke-width: 3; }
    .root-node { fill: #ffe5a9; stroke: #f0bf62; stroke-width: 2.4; }
    .leaf-node { fill: #b8e8ff; stroke: #64c7ff; stroke-width: 2; }
    .clicked-leaf-node {
      fill: #ffd27a;
      stroke: #f0bf62;
      stroke-width: 3;
      filter: drop-shadow(0 0 6px rgba(255, 210, 122, 0.7));
    }
    .off-path-node { opacity: 0.55; }
    .node-label { fill: var(--text); font-size: 11px; pointer-events: none; }
    .spine-label { font-size: 10px; fill: #dce8fb; }
    .leaf-label { fill: #c8daf5; font-size: 10px; }
    .direction-hint { fill: #9fb2d6; font-size: 12px; }
    .path-breadcrumb {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      margin-bottom: 10px;
      font-size: 12px;
      color: var(--muted);
    }
    .path-breadcrumb button {
      padding: 4px 10px;
      font-size: 12px;
      border-radius: 999px;
    }
    .path-breadcrumb button.current {
      border-color: var(--gold);
      color: var(--gold);
      cursor: default;
      opacity: 0.95;
    }
    .path-sep { color: rgba(159, 178, 214, 0.6); user-select: none; }
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
      cursor: pointer;
    }
    .trace-item-active {
      border-left-color: #ff9de2;
      background: rgba(40, 20, 50, 0.75);
    }
    .trace-filter-hint {
      font-size: 12px;
      color: var(--muted);
      margin-bottom: 8px;
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }
    .evidence-row { margin-top: 4px; color: var(--muted); font-size: 12px; }
    .trace-head { color: var(--gold); margin-bottom: 4px; }
    .trace-keyword {
      color: #9fd4ff;
      font-size: 13px;
      font-weight: 500;
      margin-bottom: 4px;
    }
    .trace-time { color: var(--muted); margin-top: 3px; }
    .round-progress {
      margin-bottom: 12px;
      padding: 10px 12px;
      border: 1px solid rgba(212, 179, 111, 0.25);
      border-radius: 10px;
      background: rgba(6, 14, 29, 0.55);
    }
    .round-progress[hidden] { display: none; }
    .round-progress-track {
      height: 6px;
      border-radius: 999px;
      background: rgba(126, 155, 197, 0.25);
      overflow: hidden;
      margin-bottom: 10px;
    }
    .round-progress-fill {
      height: 100%;
      width: 0%;
      border-radius: inherit;
      background: linear-gradient(90deg, #d4b36f, #64c7ff);
      transition: width 0.35s ease;
    }
    .round-progress-steps {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 8px;
      list-style: none;
      margin: 0;
      padding: 0;
      font-size: 11px;
      color: var(--muted);
    }
    .round-progress-steps li {
      text-align: center;
      padding: 4px 6px;
      border-radius: 8px;
      border: 1px solid transparent;
      transition: color 0.2s, border-color 0.2s, background 0.2s;
    }
    .round-progress-steps li.is-active {
      color: var(--gold);
      border-color: rgba(212, 179, 111, 0.45);
      background: rgba(212, 179, 111, 0.08);
    }
    .round-progress-steps li.is-done {
      color: #b8e8ff;
    }
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
          <select id="llm-provider" aria-label="LLM provider">
            <option value="">Loading models...</option>
          </select>
          <select id="evidence-provider" aria-label="Evidence database">
            <option value="">Loading databases...</option>
          </select>
          <button type="submit">Launch Exploration</button>
          <button type="button" id="confirm-btn" disabled>Confirm Path</button>
        </form>
        <div id="status">No active session · Shift+click select · Ctrl+click filter trace</div>
      </div>
      <div id="round-progress" class="round-progress" hidden>
        <div class="round-progress-track" aria-hidden="true">
          <div id="round-progress-fill" class="round-progress-fill"></div>
        </div>
        <ol class="round-progress-steps" id="round-progress-steps">
          <li data-step="1">① 扩展关键词</li>
          <li data-step="2">② 检索证据</li>
          <li data-step="3">③ 方向与画像</li>
        </ol>
      </div>
      <div id="path-breadcrumb" class="path-breadcrumb" hidden></div>
      <svg id="tree" width="100%" preserveAspectRatio="xMinYMin meet"></svg>
    </section>

    <aside class="panel">
      <div class="panel-title">Direction & Persona</div>
      <div id="rounds"></div>
      <div class="panel-title">LLM + Tool Trace</div>
      <div id="trace"></div>
    </aside>
  </div>
  <script src="https://cdn.jsdelivr.net/npm/d3@7"></script>
  <script type="module">
    import("/client.js").catch((error) => {
      const status = document.getElementById("status");
      if (status) {
        status.textContent =
          "Client bundle failed to load — run npm run build, then restart the server. " +
          (error?.message ?? "unknown error");
      }
    });
  </script>
</body>
</html>`;
}

async function readClientBundle(): Promise<string> {
  return readDistModule(["client", "client.js"]);
}

async function readDistModule(segments: string[]): Promise<string> {
  const filePath = join(process.cwd(), "dist", "src", ...segments);
  return readFile(filePath, "utf8");
}

export function buildApp(options?: { deps?: EngineDeps }) {
  const traceStore = new TraceStore();
  const availableProviders: LlmProviderInfo[] = options?.deps
    ? [{ id: "kimi", label: "Test model", model: "mock" }]
    : listAvailableLlmProviders(readLlmEnvConfig());
  const availableEvidenceProviders: EvidenceProviderInfo[] = listAvailableEvidenceProviders();
  const defaultProvider: LlmProviderId = options?.deps
    ? "kimi"
    : resolveDefaultLlmProvider(process.env.LLM_PROVIDER, availableProviders);
  const defaultEvidenceProvider: EvidenceProviderId = resolveDefaultEvidenceProvider(
    process.env.EVIDENCE_PROVIDER,
    availableEvidenceProviders,
  );
  const binding: EngineBinding = options?.deps ?? createProductionBinding();
  const engine = new ExplorationEngine(binding, traceStore);
  const app = Fastify({ logger: false });

  app.get("/", async (_req, reply) => {
    reply.type("text/html; charset=utf-8").send(htmlShell());
  });

  app.get("/client.js", async (_req, reply) => {
    try {
      const script = await readClientBundle();
      reply.type("text/javascript; charset=utf-8").send(script);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Client bundle not found";
      reply.status(503).send(`throw new Error(${JSON.stringify(message)});`);
    }
  });

  app.get<{ Params: { file: string } }>("/shared/:file", async (req, reply) => {
    const fileName = req.params.file;
    if (!fileName.endsWith(".js") || fileName.includes("..") || fileName.includes("/")) {
      reply.status(400).send("Invalid module path");
      return;
    }

    try {
      const script = await readDistModule(["shared", fileName]);
      reply.type("text/javascript; charset=utf-8").send(script);
    } catch {
      reply.status(404).send("Module not found");
    }
  });

  app.get("/api/llm-providers", async () => ({
    providers: availableProviders,
    defaultProvider,
  }));

  app.get("/api/evidence-providers", async () => ({
    providers: availableEvidenceProviders,
    defaultProvider: defaultEvidenceProvider,
  }));

  app.post<{ Body: StartSessionRequest }>("/api/start", async (req, reply) => {
    const provider = req.body.llmProvider ?? engine.getDefaultProvider();
    if (!availableProviders.some((item) => item.id === provider)) {
      return reply.status(400).send({ message: `LLM provider unavailable: ${provider}` });
    }
    const evidenceProvider = req.body.evidenceProvider ?? engine.getDefaultEvidenceProvider();
    if (!availableEvidenceProviders.some((item) => item.id === evidenceProvider)) {
      return reply.status(400).send({ message: `Evidence provider unavailable: ${evidenceProvider}` });
    }
    const session = engine.createSession(req.body.keyword, provider, evidenceProvider);
    engine.scheduleExpand(session.sessionId, session.rootNodeId);
    return engine.getSession(session.sessionId);
  });

  app.post<{ Body: ExpandRequest }>("/api/expand", async (req) => {
    engine.scheduleExpand(req.body.sessionId, req.body.rootNodeId);
    const session = engine.getSession(req.body.sessionId);
    if (!session) {
      throw new Error("Session not found");
    }
    return session;
  });

  app.post<{ Body: BacktraceRequest }>("/api/backtrace", async (req) => {
    return engine.backtrace(req.body.sessionId, req.body.nodeId);
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
