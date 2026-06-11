import type { DirectionSummary, PersonaHypothesis, RoundResult } from "../shared/types.js";
import { defaultEngineDeps, type EngineDeps } from "./engine.js";

interface KimiOptions {
  provider?: "auto" | "minimax" | "kimi";
  minimaxApiKey?: string;
  minimaxBaseUrl?: string;
  minimaxModel?: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  userAgent?: string;
}

function extractJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error("No JSON object found in model response");
    }
    return JSON.parse(match[0]) as Record<string, unknown>;
  }
}

async function callKimiJson(args: {
  apiKey: string;
  baseUrl: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  userAgent?: string;
}): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${args.apiKey}`,
  };

  if (args.userAgent) {
    headers["user-agent"] = args.userAgent;
  }

  const response = await fetch(`${args.baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: args.model,
      temperature: args.temperature ?? 0.3,
      messages: [
        { role: "system", content: args.systemPrompt },
        { role: "user", content: args.userPrompt },
      ],
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Kimi API failed with ${response.status}: ${body.slice(0, 200)}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("Kimi API returned empty content");
  }

  return extractJsonObject(content);
}

export function createEngineDeps(options: KimiOptions): EngineDeps {
  const provider = options.provider ?? "auto";
  const useMiniMax =
    provider === "minimax" ||
    (provider === "auto" && Boolean(options.minimaxApiKey));

  const apiKey = useMiniMax ? options.minimaxApiKey : options.apiKey;
  const isKimiCodeKey = Boolean(apiKey?.startsWith("sk-kimi-"));
  const baseUrl = useMiniMax
    ? options.minimaxBaseUrl ?? "https://api.minimax.chat/v1"
    : options.baseUrl ??
      (isKimiCodeKey ? "https://api.kimi.com/coding/v1" : "https://api.moonshot.cn/v1");
  const model = useMiniMax
    ? options.minimaxModel ?? "MiniMax-M3"
    : options.model ?? (isKimiCodeKey ? "kimi-for-coding" : "moonshot-v1-8k");
  const userAgent = useMiniMax
    ? options.userAgent
    : options.userAgent ?? (isKimiCodeKey ? "claude-cli/1.0 (external)" : undefined);

  if (!apiKey) {
    return defaultEngineDeps;
  }

  return {
    searchEvidence: defaultEngineDeps.searchEvidence,

    async expandKeywords(seed: string): Promise<string[]> {
      const payload = await callKimiJson({
        apiKey,
        baseUrl,
        model,
        userAgent,
        systemPrompt:
          "You generate keyword candidates for recursive topic exploration. Return strict JSON with an array field named keywords.",
        userPrompt: `Seed keyword: ${seed}\nReturn exactly 10 concise related keywords in Chinese.`,
        temperature: 0.5,
      });

      const keywords = Array.isArray(payload.keywords) ? payload.keywords : [];
      const normalized = keywords
        .map((item) => String(item).trim())
        .filter((item) => item.length > 0)
        .slice(0, 10);

      if (normalized.length < 10) {
        const backup = await defaultEngineDeps.expandKeywords(seed);
        return [...normalized, ...backup].slice(0, 10);
      }

      return normalized;
    },

    async summarizeDirection(rootKeyword: string, topKeywords: string[]): Promise<DirectionSummary> {
      const payload = await callKimiJson({
        apiKey,
        baseUrl,
        model,
        userAgent,
        systemPrompt:
          "You summarize exploration direction. Return strict JSON with fields label and reason in Chinese.",
        userPrompt: `Root keyword: ${rootKeyword}\nTop branches: ${topKeywords.join(", ")}\nSummarize direction in 1 short label and 1 short reason.`,
        temperature: 0.3,
      });

      const label = String(payload.label ?? "方向探索中").slice(0, 40);
      const reason = String(payload.reason ?? "模型正在根据候选词持续收敛方向").slice(0, 160);
      return { label, reason };
    },

    async inferPersona(rounds: RoundResult[]): Promise<PersonaHypothesis> {
      const recent = rounds.slice(-3).map((round) => ({
        roundId: round.roundId,
        direction: round.directionSummary.label,
      }));

      const payload = await callKimiJson({
        apiKey,
        baseUrl,
        model,
        userAgent,
        systemPrompt:
          "You infer a temporary user persona from exploration behavior. Return strict JSON with label, confidence, reason in Chinese.",
        userPrompt: `Recent rounds: ${JSON.stringify(recent)}\nReturn a conservative persona hypothesis.`,
        temperature: 0.2,
      });

      const rawConfidence = Number(payload.confidence ?? 0.65);
      const confidence = Number.isFinite(rawConfidence)
        ? Math.max(0, Math.min(1, rawConfidence))
        : 0.65;

      return {
        label: String(payload.label ?? "探索型用户").slice(0, 40),
        confidence,
        reason: String(payload.reason ?? "用户持续点击分支并收敛方向").slice(0, 160),
      };
    },
  };
}
