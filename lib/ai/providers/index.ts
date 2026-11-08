import { InvestigationError, type AnalysisProvider } from "@/lib/ai/analysis";
import { anthropicProvider } from "@/lib/ai/providers/anthropic";
import { openaiProvider } from "@/lib/ai/providers/openai";

const PROVIDERS = { anthropic: anthropicProvider, openai: openaiProvider };

// PAYTRACE_AI_PROVIDER picks one explicitly. Otherwise use whichever key is set, Claude first.
export function aiProviderName(): AnalysisProvider["name"] | null {
  const chosen = process.env.PAYTRACE_AI_PROVIDER?.toLowerCase();
  if (chosen === "anthropic" || chosen === "openai") return chosen;
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.OPENAI_API_KEY) return "openai";
  return null;
}

export function selectProvider(): AnalysisProvider {
  const name = aiProviderName();
  if (!name) {
    throw new InvestigationError("No AI provider configured: set ANTHROPIC_API_KEY or OPENAI_API_KEY", 503);
  }
  return PROVIDERS[name];
}
