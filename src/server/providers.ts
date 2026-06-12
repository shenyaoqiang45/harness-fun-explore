import type {
  DirectionSummary,
  LlmProviderId,
  LlmProviderInfo,
  PersonaHypothesis,
  RoundResult,
} from "../shared/types.js";
import type { EngineDeps } from "./engine.js";

type LlmProvider = "auto" | LlmProviderId;

interface LlmOptions {
  provider?: LlmProvider;
  minimaxApiKey?: string;
  minimaxBaseUrl?: string;
  minimaxModel?: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  deepseekApiKey?: string;
  deepseekChatUrl?: string;
  deepseekModel?: string;
  userAgent?: string;
  searchEvidence: EngineDeps["searchEvidence"];
}

export type LlmEnvConfig = Omit<LlmOptions, "provider" | "searchEvidence">;

function describeProvider(
  config: LlmEnvConfig,
  provider: LlmProviderId,
  label: string,
): LlmProviderInfo | null {
  try {
    const { model } = resolveLlmConfig({
      ...config,
      provider,
      searchEvidence: async () => [],
    });
    return { id: provider, label, model };
  } catch {
    return null;
  }
}

export function listAvailableLlmProviders(config: LlmEnvConfig): LlmProviderInfo[] {
  const providers: LlmProviderInfo[] = [];
  const kimiKey = config.apiKey?.trim();

  if (kimiKey) {
    const kimiLabel = kimiKey.startsWith("sk-kimi-") ? "Kimi Coding" : "Kimi Moonshot";
    const kimi = describeProvider(config, "kimi", kimiLabel);
    if (kimi) {
      providers.push(kimi);
    }
  }

  const deepseek = describeProvider(config, "deepseek", "DeepSeek Flash");
  if (deepseek) {
    providers.push(deepseek);
  }

  const minimax = describeProvider(config, "minimax", "MiniMax");
  if (minimax) {
    providers.push(minimax);
  }

  return providers;
}

export function resolveDefaultLlmProvider(
  envProvider: string | undefined,
  available: LlmProviderInfo[],
): LlmProviderId {
  if (
    envProvider &&
    envProvider !== "auto" &&
    available.some((provider) => provider.id === envProvider)
  ) {
    return envProvider as LlmProviderId;
  }
  return available[0]?.id ?? "kimi";
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

async function callChatJson(args: {
  apiKey: string;
  chatCompletionsUrl: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  userAgent?: string;
  disableThinking?: boolean;
}): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${args.apiKey}`,
  };

  if (args.userAgent) {
    headers["user-agent"] = args.userAgent;
  }

  const body: Record<string, unknown> = {
    model: args.model,
    temperature: args.temperature ?? 0.3,
    messages: [
      { role: "system", content: args.systemPrompt },
      { role: "user", content: args.userPrompt },
    ],
    response_format: { type: "json_object" },
  };

  if (args.model.startsWith("deepseek-v4")) {
    body.thinking = { type: "disabled" };
  }

  const response = await fetch(args.chatCompletionsUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LLM API failed with ${response.status}: ${body.slice(0, 200)}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("LLM API returned empty content");
  }

  return extractJsonObject(content);
}

function resolveLlmConfig(options: LlmOptions): {
  apiKey: string;
  chatCompletionsUrl: string;
  model: string;
  userAgent?: string;
  fixedTemperature?: number;
} {
  const provider = options.provider ?? "auto";
  const useDeepSeek = provider === "deepseek";
  const useMiniMax =
    provider === "minimax" ||
    (provider === "auto" && Boolean(options.minimaxApiKey) && !useDeepSeek);

  if (useDeepSeek) {
    const apiKey = options.deepseekApiKey;
    if (!apiKey) {
      throw new Error("LLM API key required. Set DEEPSEEK_API_KEY when LLM_PROVIDER=deepseek.");
    }
    return {
      apiKey,
      chatCompletionsUrl:
        options.deepseekChatUrl ?? "https://api.deepseek.com/chat/completions",
      model: options.deepseekModel ?? "deepseek-v4-flash",
    };
  }

  const apiKey = useMiniMax ? options.minimaxApiKey : options.apiKey;
  if (!apiKey) {
    throw new Error(
      "LLM API key required. Set KIMI_API_KEY, DEEPSEEK_API_KEY, or MINIMAX_API_KEY — mock LLM is not supported.",
    );
  }

  const isKimiCodeKey = Boolean(apiKey.startsWith("sk-kimi-"));
  const moonshotDefaultUrl = "https://api.moonshot.cn/v1";
  const moonshotDefaultModel = "moonshot-v1-8k";
  const usesMoonshotDefaults =
    (!options.baseUrl || options.baseUrl === moonshotDefaultUrl) &&
    (!options.model || options.model === moonshotDefaultModel);
  const baseUrl = useMiniMax
    ? options.minimaxBaseUrl ?? "https://api.minimax.chat/v1"
    : isKimiCodeKey && usesMoonshotDefaults
      ? "https://api.kimi.com/coding/v1"
      : (options.baseUrl ??
        (isKimiCodeKey ? "https://api.kimi.com/coding/v1" : moonshotDefaultUrl));
  const model = useMiniMax
    ? options.minimaxModel ?? "MiniMax-M3"
    : isKimiCodeKey && usesMoonshotDefaults
      ? "kimi-for-coding"
      : (options.model ?? (isKimiCodeKey ? "kimi-for-coding" : moonshotDefaultModel));
  const userAgent = useMiniMax
    ? options.userAgent
    : options.userAgent ?? (isKimiCodeKey ? "claude-cli/1.0 (external)" : undefined);

  return {
    apiKey,
    chatCompletionsUrl: `${baseUrl}/chat/completions`,
    model,
    userAgent,
    fixedTemperature: isKimiCodeKey ? 1 : undefined,
  };
}

export function createEngineDeps(options: LlmOptions): EngineDeps {
  const { apiKey, chatCompletionsUrl, model, userAgent, fixedTemperature } =
    resolveLlmConfig(options);
  const searchEvidence = options.searchEvidence;

  return {
    searchEvidence,

    async expandKeywords(seed: string): Promise<string[]> {
      const payload = await callChatJson({
        apiKey,
        chatCompletionsUrl,
        model,
        userAgent,
        systemPrompt:
          "You generate keyword candidates for recursive topic exploration. Return strict JSON with an array field named keywords.",
        userPrompt: `Seed keyword: ${seed}\nReturn exactly 10 concise related keywords in Chinese.`,
        temperature: fixedTemperature ?? 0.5,
      });

      const keywords = Array.isArray(payload.keywords) ? payload.keywords : [];
      const normalized = keywords
        .map((item) => String(item).trim())
        .filter((item) => item.length > 0)
        .slice(0, 10);

      if (normalized.length < 10) {
        throw new Error(
          `LLM returned only ${normalized.length} keywords for "${seed}"; expected 10.`,
        );
      }

      return normalized;
    },

    async summarizeRound(
      rootKeyword: string,
      topKeywords: string[],
      priorRounds: RoundResult[],
    ): Promise<{ directionSummary: DirectionSummary; personaHypothesis: PersonaHypothesis }> {
      const recent = priorRounds.slice(-3).map((round) => ({
        roundId: round.roundId,
        direction: round.directionSummary.label,
      }));

      const payload = await callChatJson({
        apiKey,
        chatCompletionsUrl,
        model,
        userAgent,
        systemPrompt:
          "You summarize exploration direction and infer a temporary user persona. Return strict JSON with fields directionLabel, directionReason, personaLabel, personaConfidence (0-1 number), personaReason in Chinese except personaConfidence.",
        userPrompt: `Root keyword: ${rootKeyword}\nTop branches: ${topKeywords.join(", ")}\nPrior rounds: ${JSON.stringify(recent)}\nReturn a short direction summary and a conservative persona hypothesis.`,
        temperature: fixedTemperature ?? 0.3,
      });

      const rawConfidence = Number(payload.personaConfidence ?? 0.65);
      const confidence = Number.isFinite(rawConfidence)
        ? Math.max(0, Math.min(1, rawConfidence))
        : 0.65;

      return {
        directionSummary: {
          label: String(payload.directionLabel ?? "方向探索中").slice(0, 40),
          reason: String(payload.directionReason ?? "模型正在根据候选词持续收敛方向").slice(0, 160),
        },
        personaHypothesis: {
          label: String(payload.personaLabel ?? "探索型用户").slice(0, 40),
          confidence,
          reason: String(payload.personaReason ?? "用户持续点击分支并收敛方向").slice(0, 160),
        },
      };
    },
  };
}
