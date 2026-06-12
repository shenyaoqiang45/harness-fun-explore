import {
  buildFrontierDisplayTree,
  buildPathBreadcrumb,
  isCurrentRootBacktraceTarget,
  parentBacktraceNodeId,
} from "../shared/display-tree.js";
import {
  buildTreeLayout,
  computeViewBox,
  treeLinkPath,
  type PlacedNode,
  type TreeLink,
} from "../shared/tree-layout.js";

declare global {
  interface Window {
    d3: any;
  }
}

interface EvidenceItem {
  source: string;
  title: string;
}

interface ScoreBreakdown {
  compositeScore: number;
  popularity: number;
  semanticRelevance: number;
  sourceAuthority: number;
}

interface KeywordNode {
  id: string;
  keyword: string;
  parentId: string | null;
  children: string[];
  score: ScoreBreakdown;
  roundId: number;
  evidence: EvidenceItem[];
}

interface TraceEvent {
  id: string;
  roundId: number;
  type: string;
  toolName?: string;
  status?: "ok" | "error";
  summary: string;
  timestamp: string;
  payload?: Record<string, unknown>;
}

interface LlmProviderInfo {
  id: string;
  label: string;
  model: string;
}

interface EvidenceProviderInfo {
  id: string;
  label: string;
}

interface SessionState {
  sessionId: string;
  llmProvider: string;
  evidenceProvider: string;
  rootNodeId: string;
  currentRootNodeId: string;
  confirmedPath: string[];
  nodes: Record<string, KeywordNode>;
  rounds: Array<{
    roundId: number;
    rootNodeId: string;
    topNodeIds: string[];
    directionSummary: { label: string; reason: string };
    personaHypothesis: { label: string; confidence: number; reason: string };
  }>;
  status: string;
}

const form = document.getElementById("start-form") as HTMLFormElement;
const input = document.getElementById("keyword-input") as HTMLInputElement;
const providerSelect = document.getElementById("llm-provider") as HTMLSelectElement;
const evidenceProviderSelect = document.getElementById("evidence-provider") as HTMLSelectElement;
const confirmBtn = document.getElementById("confirm-btn") as HTMLButtonElement;
const roundsEl = document.getElementById("rounds") as HTMLDivElement;
const traceEl = document.getElementById("trace") as HTMLDivElement;
const statusEl = document.getElementById("status") as HTMLDivElement;
const breadcrumbEl = document.getElementById("path-breadcrumb") as HTMLDivElement;
const roundProgressEl = document.getElementById("round-progress") as HTMLDivElement;
const roundProgressFillEl = document.getElementById("round-progress-fill") as HTMLDivElement;
const roundProgressStepsEl = document.getElementById("round-progress-steps") as HTMLOListElement;

const svg = window.d3.select("#tree");

let currentSessionId = "";
let selectedNodeId = "";
let highlightedNodeId = "";
let clickedLeafId = "";
let activeTraceEventId = "";
let traceRoundFilter: number | null = null;
let currentSessionStatus = "";
let currentSessionState: SessionState | null = null;
let traceEvents: TraceEvent[] = [];
let availableProviders: LlmProviderInfo[] = [];
let availableEvidenceProviders: EvidenceProviderInfo[] = [];
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function traceRoundEvents(trace: TraceEvent[], roundId: number): TraceEvent[] {
  return trace.filter((event) => event.roundId === roundId);
}

function hasToolStart(events: TraceEvent[], toolName: string): boolean {
  return events.some((event) => event.toolName === toolName && event.type === "tool-call-start");
}

function hasToolEnd(events: TraceEvent[], toolName: string): boolean {
  return events.some(
    (event) => event.toolName === toolName && event.type === "tool-call-end" && event.status === "ok",
  );
}

function deriveRoundProgress(trace: TraceEvent[], roundId: number): { step: number; percent: number } {
  const events = traceRoundEvents(trace, roundId);
  const evidenceStarts = events.filter(
    (event) => event.toolName === "searchEvidence" && event.type === "tool-call-start",
  ).length;
  const evidenceEnds = events.filter(
    (event) => event.toolName === "searchEvidence" && event.type === "tool-call-end",
  ).length;

  if (hasToolEnd(events, "summarizeRound")) {
    return { step: 3, percent: 100 };
  }
  if (hasToolStart(events, "summarizeRound")) {
    return { step: 3, percent: 82 };
  }
  if (hasToolEnd(events, "expandKeywords")) {
    const evidenceRatio = Math.min(1, evidenceEnds / Math.max(evidenceStarts, 10));
    return { step: 2, percent: 34 + evidenceRatio * 46 };
  }
  if (hasToolStart(events, "expandKeywords")) {
    return { step: 1, percent: 18 };
  }
  return { step: 1, percent: 6 };
}

function renderRoundProgress(trace: TraceEvent[], roundId: number): void {
  const { step, percent } = deriveRoundProgress(trace, roundId);
  roundProgressFillEl.style.width = `${percent}%`;

  for (const item of roundProgressStepsEl.querySelectorAll("li")) {
    const itemStep = Number(item.getAttribute("data-step"));
    item.classList.remove("is-active", "is-done");
    if (itemStep < step) {
      item.classList.add("is-done");
    } else if (itemStep === step) {
      item.classList.add("is-active");
    }
  }
}

function showRoundProgress(): void {
  roundProgressEl.hidden = false;
  roundProgressFillEl.style.width = "0%";
  for (const item of roundProgressStepsEl.querySelectorAll("li")) {
    item.classList.remove("is-active", "is-done");
  }
  roundProgressStepsEl.querySelector('li[data-step="1"]')?.classList.add("is-active");
}

function hideRoundProgress(): void {
  roundProgressEl.hidden = true;
}

async function waitForRoundComplete(sessionId: string): Promise<SessionState> {
  showRoundProgress();
  const targetRoundId = (currentSessionState?.rounds.length ?? 0) + 1;

  while (true) {
    const [state, trace] = await Promise.all([
      apiJson<SessionState>(`/api/session/${sessionId}`),
      apiJson<TraceEvent[]>(`/api/trace/${sessionId}`),
    ]);

    currentSessionState = state;
    currentSessionStatus = state.status;
    traceEvents = trace;

    renderRoundProgress(trace, targetRoundId);
    renderTracePanel();

    const targetRoundDone = state.rounds.some((round) => round.roundId === targetRoundId);
    if (
      targetRoundDone &&
      (state.status === "await-user-click" || state.status === "confirmed")
    ) {
      hideRoundProgress();
      return state;
    }

    if (state.status === "error") {
      hideRoundProgress();
      const failed = trace.find((event) => event.type === "tool-call-error");
      throw new Error(failed?.summary ?? "Round failed");
    }

    await sleep(350);
  }
}

function providerLabel(providerId: string): string {
  const provider = availableProviders.find((item) => item.id === providerId);
  return provider ? `${provider.label} · ${provider.model}` : providerId;
}

function evidenceProviderLabel(providerId: string): string {
  const provider = availableEvidenceProviders.find((item) => item.id === providerId);
  return provider?.label ?? providerId;
}

async function loadLlmProviders(): Promise<void> {
  const data = await apiJson<{ providers: LlmProviderInfo[]; defaultProvider: string }>(
    "/api/llm-providers",
  );
  availableProviders = data.providers;
  providerSelect.innerHTML = "";

  for (const provider of data.providers) {
    const option = document.createElement("option");
    option.value = provider.id;
    option.textContent = `${provider.label} · ${provider.model}`;
    providerSelect.appendChild(option);
  }

  const saved = localStorage.getItem("llm-provider");
  const initial =
    saved && data.providers.some((provider) => provider.id === saved)
      ? saved
      : data.defaultProvider;
  if (initial) {
    providerSelect.value = initial;
  }
}

providerSelect.addEventListener("change", () => {
  localStorage.setItem("llm-provider", providerSelect.value);
});

async function loadEvidenceProviders(): Promise<void> {
  const data = await apiJson<{ providers: EvidenceProviderInfo[]; defaultProvider: string }>(
    "/api/evidence-providers",
  );
  availableEvidenceProviders = data.providers;
  evidenceProviderSelect.innerHTML = "";

  for (const provider of data.providers) {
    const option = document.createElement("option");
    option.value = provider.id;
    option.textContent = provider.label;
    evidenceProviderSelect.appendChild(option);
  }

  const saved = localStorage.getItem("evidence-provider");
  const initial =
    saved && data.providers.some((provider) => provider.id === saved)
      ? saved
      : data.defaultProvider;
  if (initial) {
    evidenceProviderSelect.value = initial;
  }
}

evidenceProviderSelect.addEventListener("change", () => {
  localStorage.setItem("evidence-provider", evidenceProviderSelect.value);
});

void Promise.all([loadLlmProviders(), loadEvidenceProviders()]).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  providerSelect.innerHTML = "";
  const option = document.createElement("option");
  option.value = "";
  option.textContent = "Models unavailable";
  providerSelect.appendChild(option);
  providerSelect.disabled = true;
  evidenceProviderSelect.innerHTML = "";
  const evidenceOption = document.createElement("option");
  evidenceOption.value = "";
  evidenceOption.textContent = "Databases unavailable";
  evidenceProviderSelect.appendChild(evidenceOption);
  evidenceProviderSelect.disabled = true;
  statusEl.textContent = `Failed to load providers: ${message}`;
});

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(url, init);
  if (!resp.ok) {
    let detail = `${resp.status} ${resp.statusText}`;
    try {
      const body = (await resp.json()) as { message?: string };
      if (body?.message) {
        detail = body.message;
      }
    } catch {
      // Ignore JSON parse failures and keep fallback detail.
    }
    throw new Error(detail);
  }
  return (await resp.json()) as T;
}

function resolveNodeIdForTrace(event: TraceEvent): string | undefined {
  if (!currentSessionState) {
    return undefined;
  }

  const payload = event.payload ?? {};
  const explicit = payload.nodeId ?? payload.rootNodeId ?? payload.confirmedNodeId;
  if (typeof explicit === "string" && currentSessionState.nodes[explicit]) {
    return explicit;
  }

  const round = currentSessionState.rounds.find((item) => item.roundId === event.roundId);

  if (event.type === "round-checkpoint" && Array.isArray(payload.confirmedPath)) {
    return (payload.confirmedPath as string[]).at(-1);
  }

  if (event.toolName === "searchEvidence" && typeof payload.keyword === "string") {
    const match = Object.values(currentSessionState.nodes).find(
      (node) => node.keyword === payload.keyword && node.roundId === event.roundId,
    );
    return match?.id;
  }

  if (event.toolName === "expandKeywords" || event.type === "llm-output") {
    return round?.rootNodeId;
  }

  if (event.type === "round-checkpoint") {
    return round?.rootNodeId;
  }

  return round?.rootNodeId;
}

function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) {
    return text;
  }
  return `${text.slice(0, maxLen - 1)}…`;
}

function spineDisplayLabel(keyword: string): string {
  return truncateText(keyword, 26);
}

function leafDisplayLabel(keyword: string, heat: number): string {
  const parts = keyword.trim().split(/\s+/);
  const tail = parts.length > 2 ? parts.slice(-2).join(" ") : keyword;
  return `${truncateText(tail, 20)} · ${heat}`;
}

function nodeLabel(node: PlacedNode): string {
  if (node.kind === "leaf") {
    const heat = Math.round((node.popularity ?? 0) * 100);
    return leafDisplayLabel(node.keyword, heat);
  }
  return spineDisplayLabel(node.keyword);
}

function labelPlacement(node: PlacedNode, leafNodes: PlacedNode[]): {
  dx: number;
  dy: number;
  anchor: "start" | "middle" | "end";
  baseline: "auto" | "hanging" | "middle";
  className: string;
} {
  if (node.kind === "leaf") {
    const leafIndex = leafNodes.findIndex((item) => item.id === node.id);
    const below = leafIndex % 2 === 0;
    return {
      dx: 0,
      dy: below ? 18 : -16,
      anchor: "middle",
      baseline: below ? "hanging" : "auto",
      className: "node-label leaf-label",
    };
  }

  return {
    dx: 0,
    dy: -16,
    anchor: "middle",
    baseline: "auto",
    className: "node-label spine-label",
  };
}

function nodeRadius(node: PlacedNode, chainHeadId: string): number {
  if (node.kind === "leaf") {
    return 7;
  }
  return node.id === chainHeadId ? 10 : 8;
}

async function handleNodeClick(event: MouseEvent, node: PlacedNode, state: SessionState): Promise<void> {
  if (!currentSessionId) {
    return;
  }

  if (event.ctrlKey) {
    traceRoundFilter = node.roundId;
    highlightedNodeId = node.id;
    activeTraceEventId = "";
    renderTree(state);
    renderTracePanel();
    statusEl.textContent = `Trace filtered to round ${node.roundId}`;
    return;
  }

  if (event.shiftKey) {
    selectedNodeId = node.id;
    highlightedNodeId = node.id;
    statusEl.textContent = `Selected: ${node.keyword} — click Confirm Path to freeze`;
    renderTree(state);
    return;
  }

  if (currentSessionStatus === "confirmed") {
    statusEl.textContent = "Session confirmed — start a new exploration to continue";
    return;
  }

  const shouldBacktrace =
    isCurrentRootBacktraceTarget(state, node.id) && node.kind !== "leaf";

  try {
    if (shouldBacktrace) {
      const targetId = parentBacktraceNodeId(state);
      if (!targetId) {
        return;
      }
      statusEl.textContent = "Backtracing to earlier layer...";
      traceRoundFilter = null;
      await apiJson("/api/backtrace", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: currentSessionId, nodeId: targetId }),
      });
      selectedNodeId = targetId;
      highlightedNodeId = targetId;
      activeTraceEventId = "";
      await refreshSession();
      statusEl.textContent = `Backtraced — pick a leaf to explore again`;
      return;
    }

    if (node.kind === "leaf") {
      clickedLeafId = node.id;
    }
    selectedNodeId = node.id;
    highlightedNodeId = node.id;
    renderTree(state);

    statusEl.textContent = "Expanding branch...";
    confirmBtn.disabled = true;
    traceRoundFilter = null;
    const kickoff = await apiJson<SessionState>("/api/expand", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: currentSessionId, rootNodeId: node.id }),
    });
    currentSessionState = kickoff;
    currentSessionStatus = kickoff.status;
    activeTraceEventId = "";
    await waitForRoundComplete(currentSessionId);
    await refreshSession();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    statusEl.textContent = shouldBacktrace ? `Backtrace failed: ${message}` : `Expand failed: ${message}`;
  }
}

function renderBreadcrumb(state: SessionState): void {
  const crumbs = buildPathBreadcrumb(state);
  breadcrumbEl.innerHTML = "";

  if (crumbs.length <= 1) {
    breadcrumbEl.hidden = true;
    return;
  }

  breadcrumbEl.hidden = false;
  crumbs.forEach((crumb, index) => {
    if (index > 0) {
      const sep = document.createElement("span");
      sep.className = "path-sep";
      sep.textContent = "→";
      breadcrumbEl.appendChild(sep);
    }

    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = truncateText(crumb.keyword, 24);
    btn.title = crumb.keyword;
    if (crumb.isCurrent) {
      btn.className = "current";
      btn.disabled = true;
    } else {
      btn.addEventListener("click", () => {
        void backtraceToNode(crumb.id);
      });
    }
    breadcrumbEl.appendChild(btn);
  });
}

async function backtraceToNode(nodeId: string): Promise<void> {
  if (!currentSessionId || currentSessionStatus === "confirmed") {
    return;
  }

  try {
    statusEl.textContent = "Backtracing...";
    traceRoundFilter = null;
    await apiJson("/api/backtrace", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: currentSessionId, nodeId }),
    });
    selectedNodeId = nodeId;
    highlightedNodeId = nodeId;
    activeTraceEventId = "";
    await refreshSession();
    statusEl.textContent = "Backtraced — pick a leaf to explore again";
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    statusEl.textContent = `Backtrace failed: ${message}`;
  }
}

function renderTree(state: SessionState): void {
  svg.selectAll("*").remove();
  const confirmed = new Set(state.confirmedPath ?? []);
  renderBreadcrumb(state);
  const data = buildFrontierDisplayTree(state);
  const { nodes, links } = buildTreeLayout(data);
  const { viewBox, pixelHeight } = computeViewBox(nodes);
  const chainHeadId = data.id;
  const leafNodes = nodes.filter((node) => node.kind === "leaf");

  const svgNode = document.getElementById("tree");
  if (svgNode) {
    svgNode.setAttribute("viewBox", viewBox);
    svgNode.style.height = `${pixelHeight}px`;
  }

  const g = svg.append("g");

  g.append("text")
    .attr("x", nodes[0]?.x ?? 0)
    .attr("y", (nodes[0]?.y ?? 0) - 32)
    .attr("class", "direction-hint")
    .text("Current root + leaves · click leaf to expand · click root to step back · breadcrumb to jump · Shift select · Ctrl filter");

  g.selectAll("path.link")
    .data(links)
    .enter()
    .append("path")
    .attr("class", "link tree-link")
    .attr("d", (link: TreeLink) => treeLinkPath(link));

  const node = g
    .selectAll("g.node")
    .data(nodes)
    .enter()
    .append("g")
    .attr("class", "node")
    .attr("data-node-id", (d: PlacedNode) => d.id)
    .attr("transform", (d: PlacedNode) => `translate(${d.x},${d.y})`)
    .on("click", (event: MouseEvent, d: PlacedNode) => {
      void handleNodeClick(event, d, state);
    });

  node
    .append("circle")
    .attr("r", (d: PlacedNode) => nodeRadius(d, chainHeadId))
    .attr("class", (d: PlacedNode) => {
      const classes = [];
      if (d.id === selectedNodeId) {
        classes.push("selected-node");
      }
      if (d.id === highlightedNodeId && d.id !== clickedLeafId) {
        classes.push("highlighted-node");
      }
      if (d.id === clickedLeafId) {
        classes.push("clicked-leaf-node");
      }
      if (confirmed.has(d.id)) {
        classes.push("confirmed-node");
      }
      if (d.kind === "leaf") {
        classes.push("star-node", "leaf-node");
      } else if (d.id === chainHeadId) {
        classes.push("star-node", "root-node");
      } else {
        classes.push("star-node");
      }
      return classes.join(" ");
    });

  node.each(function (this: SVGGElement, d: PlacedNode) {
    const placement = labelPlacement(d, leafNodes);
    const label = window.d3
      .select(this)
      .append("text")
      .attr("class", placement.className)
      .attr("text-anchor", placement.anchor)
      .attr("dominant-baseline", placement.baseline)
      .attr("dx", placement.dx)
      .attr("dy", placement.dy)
      .text(nodeLabel(d));
    label.append("title").text(d.keyword);
  });
}

function formatScore(score: ScoreBreakdown): string {
  return `rel ${Math.round(score.semanticRelevance * 100)} · pop ${Math.round(score.popularity * 100)} · auth ${Math.round(score.sourceAuthority * 100)} · composite ${Math.round(score.compositeScore * 100)}`;
}

function renderRounds(state: SessionState): void {
  roundsEl.innerHTML = "";

  if (state.confirmedPath.length > 0) {
    const pathCard = document.createElement("div");
    pathCard.className = "panel-card";
    const labels = state.confirmedPath
      .map((id) => state.nodes[id]?.keyword ?? id.slice(0, 8))
      .join(" → ");
    pathCard.innerHTML = `
      <div class="panel-title">Confirmed Path</div>
      <div>${labels}</div>
    `;
    roundsEl.appendChild(pathCard);
  }

  for (const round of state.rounds.slice().reverse()) {
    const card = document.createElement("div");
    card.className = "panel-card";

    const evidenceLines = round.topNodeIds
      .map((nodeId) => state.nodes[nodeId])
      .filter((node): node is KeywordNode => Boolean(node))
      .sort((a, b) => b.score.compositeScore - a.score.compositeScore)
      .map((node) => {
        const source = node.evidence[0]?.source ?? "n/a";
        return `<div class="evidence-row"><strong>${node.keyword}</strong> — ${formatScore(node.score)} · ${source}</div>`;
      })
      .join("");

    card.innerHTML = `
      <div class="panel-title">Round ${round.roundId}</div>
      <div><strong>Direction:</strong> ${round.directionSummary.label}</div>
      <div>${round.directionSummary.reason}</div>
      <div><strong>Persona:</strong> ${round.personaHypothesis.label} (${Math.round(
      round.personaHypothesis.confidence * 100,
    )}%)</div>
      <div>${round.personaHypothesis.reason}</div>
      <div class="panel-title" style="margin-top:8px">Evidence (Top 5)</div>
      ${evidenceLines}
    `;
    roundsEl.appendChild(card);
  }
}

function traceCandidateKeyword(event: TraceEvent): string | null {
  if (event.toolName !== "searchEvidence") {
    return null;
  }
  const keyword = event.payload?.keyword;
  return typeof keyword === "string" && keyword.length > 0 ? keyword : null;
}

function renderTracePanel(): void {
  traceEl.innerHTML = "";

  const filtered = traceEvents
    .filter((event) => traceRoundFilter === null || event.roundId === traceRoundFilter)
    .slice()
    .reverse()
    .slice(0, 40);

  if (traceRoundFilter !== null) {
    const hint = document.createElement("div");
    hint.className = "trace-filter-hint";
    hint.textContent = `Showing round ${traceRoundFilter} only · Ctrl+click another node or clear below`;
    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.textContent = "Clear filter";
    clearBtn.addEventListener("click", () => {
      traceRoundFilter = null;
      renderTracePanel();
    });
    hint.appendChild(clearBtn);
    traceEl.appendChild(hint);
  }

  for (const event of filtered) {
    const item = document.createElement("div");
    item.className = "trace-item";
    if (event.id === activeTraceEventId) {
      item.classList.add("trace-item-active");
    }
    const head = document.createElement("div");
    head.className = "trace-head";
    head.textContent = `R${event.roundId} · ${event.type}${event.toolName ? ` · ${event.toolName}` : ""}`;
    item.appendChild(head);

    const candidateKeyword = traceCandidateKeyword(event);
    if (candidateKeyword) {
      const keywordEl = document.createElement("div");
      keywordEl.className = "trace-keyword";
      keywordEl.textContent = `候选词 · ${candidateKeyword}`;
      item.appendChild(keywordEl);
    }

    const summary = document.createElement("div");
    summary.textContent = event.summary;
    item.appendChild(summary);

    const time = document.createElement("div");
    time.className = "trace-time";
    time.textContent = new Date(event.timestamp).toLocaleTimeString();
    item.appendChild(time);
    item.addEventListener("click", () => {
      activeTraceEventId = event.id;
      const nodeId = resolveNodeIdForTrace(event);
      if (nodeId) {
        highlightedNodeId = nodeId;
        if (currentSessionState) {
          renderTree(currentSessionState);
        }
      }
      renderTracePanel();
    });
    traceEl.appendChild(item);
  }
}

async function loadTrace(): Promise<void> {
  if (!currentSessionId) {
    return;
  }
  traceEvents = await apiJson<TraceEvent[]>(`/api/trace/${currentSessionId}`);
  renderTracePanel();
}

async function refreshSession(): Promise<void> {
  const state = await apiJson<SessionState>(`/api/session/${currentSessionId}`);
  currentSessionState = state;
  currentSessionStatus = state.status;
  confirmBtn.disabled = state.status === "confirmed" || !selectedNodeId;
  const providerText = providerLabel(state.llmProvider);
  const evidenceText = evidenceProviderLabel(state.evidenceProvider);
  statusEl.textContent =
    state.status === "confirmed"
      ? `Session ${state.sessionId.slice(0, 8)} · ${providerText} · ${evidenceText} · confirmed`
      : `Session ${state.sessionId.slice(0, 8)} · ${providerText} · ${evidenceText} · ${state.status}`;
  renderTree(state);
  renderRounds(state);
  await loadTrace();
}

confirmBtn.addEventListener("click", async () => {
  if (!currentSessionId || !selectedNodeId) {
    statusEl.textContent = "Shift+click a node to select it, then Confirm Path";
    return;
  }

  try {
    statusEl.textContent = "Confirming path...";
    await apiJson("/api/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: currentSessionId, nodeId: selectedNodeId }),
    });
    await refreshSession();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    statusEl.textContent = `Confirm failed: ${message}`;
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const keyword = input.value.trim();
  if (!keyword) {
    return;
  }

  try {
    statusEl.textContent = "Starting exploration...";
    providerSelect.disabled = true;
    evidenceProviderSelect.disabled = true;
    confirmBtn.disabled = true;
    input.disabled = true;
    form.querySelector('button[type="submit"]')?.setAttribute("disabled", "true");
    traceRoundFilter = null;
    activeTraceEventId = "";
    highlightedNodeId = "";
    clickedLeafId = "";
    const kickoff = await apiJson<SessionState>("/api/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        keyword,
        llmProvider: providerSelect.value || undefined,
        evidenceProvider: evidenceProviderSelect.value || undefined,
      }),
    });

    currentSessionId = kickoff.sessionId;
    selectedNodeId = kickoff.currentRootNodeId;
    highlightedNodeId = kickoff.currentRootNodeId;
    await waitForRoundComplete(currentSessionId);
    await refreshSession();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    statusEl.textContent = `Start failed: ${message}`;
  } finally {
    input.disabled = false;
    form.querySelector('button[type="submit"]')?.removeAttribute("disabled");
    providerSelect.disabled = availableProviders.length === 0;
    evidenceProviderSelect.disabled = availableEvidenceProviders.length === 0;
  }
});
