import "dotenv/config";

export interface AIConfig {
  apiKey?: string;
  baseURL?: string;
  model: string;
  providerLabel: string;
}

export function getAIConfig(): AIConfig {
  const apiKey =
    process.env.AI_API_KEY ??
    process.env.OPENAI_API_KEY ??
    process.env.DEEPSEEK_API_KEY ??
    process.env.API_KEY;

  const baseURL =
    process.env.AI_BASE_URL ??
    process.env.OPENAI_BASE_URL ??
    process.env.DEEPSEEK_BASE_URL ??
    process.env.API_BASE_URL;

  const model =
    process.env.AI_MODEL ??
    process.env.OPENAI_MODEL ??
    process.env.DEEPSEEK_MODEL ??
    process.env.MODEL ??
    "gpt-4o-mini";

  const providerLabel = inferProviderLabel(baseURL, model);

  return {
    apiKey,
    baseURL,
    model,
    providerLabel,
  };
}

export function isAIConfigured(config = getAIConfig()) {
  return Boolean(config.apiKey);
}

function inferProviderLabel(baseURL: string | undefined, model: string) {
  if (baseURL?.includes("deepseek.com") || model.startsWith("deepseek")) {
    return "DeepSeek";
  }

  if (baseURL?.includes("openai.com") || model.startsWith("gpt-")) {
    return "OpenAI";
  }

  return "OpenAI兼容模型";
}
