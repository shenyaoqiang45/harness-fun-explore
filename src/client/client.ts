declare global {
  interface Window {
    d3: any;
  }
}

interface ScoreBreakdown {
  compositeScore: number;
  popularity: number;
}

interface KeywordNode {
  id: string;
  keyword: string;
  parentId: string | null;
  children: string[];
  score: ScoreBreakdown;
  roundId: number;
}

interface TraceEvent {
  id: string;
  roundId: number;
  type: string;
  toolName?: string;
  status?: "ok" | "error";
  summary: string;
  timestamp: string;
}

interface SessionState {
  sessionId: string;
  currentRootNodeId: string;
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

interface DisplayNode {
  id: string;
  keyword: string;
  roundId: number;
  kind: "round-root" | "leaf" | "node";
  popularity?: number;
  children: DisplayNode[];
}

const form = document.getElementById("start-form") as HTMLFormElement;
const input = document.getElementById("keyword-input") as HTMLInputElement;
const confirmBtn = document.getElementById("confirm-btn") as HTMLButtonElement;
const roundsEl = document.getElementById("rounds") as HTMLDivElement;
const traceEl = document.getElementById("trace") as HTMLDivElement;
const statusEl = document.getElementById("status") as HTMLDivElement;

const svg = window.d3.select("#tree");

let currentSessionId = "";
let selectedNodeId = "";
let currentSessionStatus = "";

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

function nodeTree(state: SessionState): DisplayNode {
  const sortedRounds = state.rounds.slice().sort((a, b) => a.roundId - b.roundId);

  if (sortedRounds.length === 0) {
    const root = state.nodes[state.currentRootNodeId];
    return {
      id: root.id,
      keyword: root.keyword,
      roundId: 0,
      kind: "node",
      children: [],
    };
  }

  const firstRound = sortedRounds[0];
  const firstRoot = state.nodes[firstRound.rootNodeId];
  const chainRoot: DisplayNode = {
    id: firstRoot.id,
    keyword: `R${firstRound.roundId} Root: ${firstRoot.keyword}`,
    roundId: firstRound.roundId,
    kind: "round-root",
    children: [],
  };

  let cursor = chainRoot;

  for (let index = 1; index < sortedRounds.length; index += 1) {
    const round = sortedRounds[index];
    const rootNode = state.nodes[round.rootNodeId];
    const nextRoot: DisplayNode = {
      id: rootNode.id,
      keyword: `R${round.roundId} Root: ${rootNode.keyword}`,
      roundId: round.roundId,
      kind: "round-root",
      children: [],
    };
    cursor.children = [nextRoot];
    cursor = nextRoot;
  }

  const lastRound = sortedRounds[sortedRounds.length - 1];
  cursor.children = lastRound.topNodeIds
    .map((nodeId) => state.nodes[nodeId])
    .filter((node): node is KeywordNode => Boolean(node))
    .sort((a, b) => (b.score?.popularity ?? 0) - (a.score?.popularity ?? 0))
    .map((node) => ({
      id: node.id,
      keyword: node.keyword,
      roundId: node.roundId,
      kind: "leaf" as const,
      popularity: node.score?.popularity ?? 0,
      children: [],
    }));

  return chainRoot;
}

function renderTree(state: SessionState): void {
  svg.selectAll("*").remove();
  const d3 = window.d3;

  const data = nodeTree(state);
  const root = d3.hierarchy(data);
  const treeLayout = d3.tree().size([940, 500]);
  treeLayout(root);

  root.descendants().forEach((d: any) => {
    d.y = d.depth * 230;
  });

  const g = svg.append("g").attr("transform", "translate(20,20)");

  g.append("text")
    .attr("x", 0)
    .attr("y", 10)
    .attr("class", "direction-hint")
    .text("探索深度: 左 -> 右");

  g.selectAll("path.link")
    .data(root.links())
    .enter()
    .append("path")
    .attr("class", "link")
    .attr("d", d3.linkHorizontal().x((d: any) => d.y).y((d: any) => d.x));

  const node = g
    .selectAll("g.node")
    .data(root.descendants())
    .enter()
    .append("g")
    .attr("class", "node")
    .attr("transform", (d: any) => `translate(${d.y},${d.x})`)
    .on("click", async (event: MouseEvent, d: any) => {
      if (!currentSessionId || !d?.data?.id) {
        return;
      }

      if (event.shiftKey) {
        selectedNodeId = d.data.id;
        statusEl.textContent = `Selected: ${d.data.keyword} — click Confirm to freeze path`;
        const state = await apiJson<SessionState>(`/api/session/${currentSessionId}`);
        renderTree(state);
        return;
      }

      if (currentSessionStatus === "confirmed") {
        statusEl.textContent = "Session confirmed — start a new exploration to continue";
        return;
      }

      try {
        statusEl.textContent = "Expanding branch...";
        await apiJson("/api/expand", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: currentSessionId, rootNodeId: d.data.id }),
        });
        selectedNodeId = d.data.id;
        await refreshSession();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        statusEl.textContent = `Expand failed: ${message}`;
      }
    });

  node
    .append("circle")
    .attr("r", (d: any) => (d.depth === 0 ? 10 : 7))
    .attr("class", (d: any) => {
      const classes = [];
      if (d.data.id === selectedNodeId) {
        classes.push("selected-node");
      }
      if (d.data.kind === "round-root") {
        classes.push("star-node", "root-node");
      } else if (d.data.kind === "leaf") {
        classes.push("star-node", "leaf-node");
      } else {
        classes.push("star-node");
      }
      return classes.join(" ");
    });

  node
    .append("text")
    .attr("dx", 12)
    .attr("dy", 4)
    .text((d: any) => {
      if (d.data.kind === "leaf") {
        const heat = Math.round((d.data.popularity ?? 0) * 100);
        return `${d.data.keyword}  热度:${heat}`;
      }
      return `${d.data.keyword}`;
    })
    .attr("class", "node-label");
}

function renderRounds(state: SessionState): void {
  roundsEl.innerHTML = "";
  for (const round of state.rounds.slice().reverse()) {
    const card = document.createElement("div");
    card.className = "panel-card";
    card.innerHTML = `
      <div class="panel-title">Round ${round.roundId}</div>
      <div><strong>Direction:</strong> ${round.directionSummary.label}</div>
      <div>${round.directionSummary.reason}</div>
      <div><strong>Persona:</strong> ${round.personaHypothesis.label} (${Math.round(
      round.personaHypothesis.confidence * 100,
    )}%)</div>
      <div>${round.personaHypothesis.reason}</div>
    `;
    roundsEl.appendChild(card);
  }
}

async function renderTrace(): Promise<void> {
  if (!currentSessionId) {
    return;
  }
  const events = await apiJson<TraceEvent[]>(`/api/trace/${currentSessionId}`);
  traceEl.innerHTML = "";

  for (const event of events.slice().reverse().slice(0, 40)) {
    const item = document.createElement("div");
    item.className = "trace-item";
    item.innerHTML = `
      <div class="trace-head">R${event.roundId} · ${event.type}${event.toolName ? ` · ${event.toolName}` : ""}</div>
      <div>${event.summary}</div>
      <div class="trace-time">${new Date(event.timestamp).toLocaleTimeString()}</div>
    `;
    traceEl.appendChild(item);
  }
}

async function refreshSession(): Promise<void> {
  const state = await apiJson<SessionState>(`/api/session/${currentSessionId}`);
  currentSessionStatus = state.status;
  confirmBtn.disabled = state.status === "confirmed" || !selectedNodeId;
  statusEl.textContent =
    state.status === "confirmed"
      ? `Session ${state.sessionId.slice(0, 8)} · confirmed`
      : `Session ${state.sessionId.slice(0, 8)} · ${state.status}`;
  renderTree(state);
  renderRounds(state);
  await renderTrace();
}

confirmBtn.addEventListener("click", async () => {
  if (!currentSessionId || !selectedNodeId) {
    statusEl.textContent = "Shift+click a node to select it, then Confirm";
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
    const state = await apiJson<SessionState>("/api/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keyword }),
    });

    currentSessionId = state.sessionId;
    selectedNodeId = state.currentRootNodeId;
    await refreshSession();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    statusEl.textContent = `Start failed: ${message}`;
  }
});
