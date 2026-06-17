import { loadConfig } from "./config.js";

export type MaileryAiProvider = "cerebras" | "groq";

export const DEFAULT_CEREBRAS_AGENT_MODEL = "zai-glm-4.7";
export const DEFAULT_GROQ_AGENT_MODEL = "qwen/qwen3-32b";
export const DEFAULT_GROQ_EMAIL_AGENT_MODEL = "llama-3.3-70b-versatile";

export function normalizeMaileryAiProvider(value: string | undefined): MaileryAiProvider {
  const provider = value?.trim().toLowerCase();
  if (provider === "groq") return "groq";
  if (!provider || provider === "cerebras") return "cerebras";
  throw new Error(`Unsupported AI provider "${value}". Use cerebras or groq.`);
}

export function resolveMaileryAiDefaults(opts?: {
  provider?: MaileryAiProvider;
  model?: string | null;
  defaultProvider?: MaileryAiProvider;
  defaultGroqModel?: string;
  defaultCerebrasModel?: string;
}): { provider: MaileryAiProvider; model: string } {
  const config = loadConfig();
  const fallbackProvider = opts?.defaultProvider ?? "cerebras";
  const provider = normalizeMaileryAiProvider(
    opts?.provider
      ?? (config["ai_provider"] as string | undefined)
      ?? (config["agent_provider"] as string | undefined)
      ?? fallbackProvider,
  );
  const model = opts?.model
    ?? (provider === "cerebras"
      ? (config["cerebras_model"] as string | undefined) ?? (config["ai_model"] as string | undefined) ?? opts?.defaultCerebrasModel ?? DEFAULT_CEREBRAS_AGENT_MODEL
      : (config["groq_model"] as string | undefined) ?? (config["ai_model"] as string | undefined) ?? opts?.defaultGroqModel ?? DEFAULT_GROQ_AGENT_MODEL);
  return { provider, model };
}

export function getMaileryAiApiKey(provider: MaileryAiProvider): string {
  const config = loadConfig();
  const key = provider === "cerebras"
    ? process.env["CEREBRAS_API_KEY"] ?? (config["cerebras_api_key"] as string | undefined)
    : process.env["GROQ_API_KEY"] ?? (config["groq_api_key"] as string | undefined);
  if (!key) {
    const env = provider === "cerebras" ? "CEREBRAS_API_KEY" : "GROQ_API_KEY";
    const configKey = provider === "cerebras" ? "cerebras_api_key" : "groq_api_key";
    throw new Error(`${provider} credential is not configured (${env}). Set ${env} or run: mailery config set ${configKey} <key>`);
  }
  return key;
}

export async function createMaileryAiModel(provider: MaileryAiProvider, model: string): Promise<unknown> {
  const apiKey = getMaileryAiApiKey(provider);
  if (provider === "cerebras") {
    const { createCerebras } = await import("@ai-sdk/cerebras");
    return createCerebras({ apiKey })(model);
  }
  const { createGroq } = await import("@ai-sdk/groq");
  return createGroq({ apiKey })(model);
}
