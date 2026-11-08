import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { AnalysisSchema, InvestigationError, SYSTEM_PROMPT, type AnalysisProvider } from "@/lib/ai/analysis";

const MODEL = process.env.PAYTRACE_AI_MODEL || "claude-opus-5-5";

let client: Anthropic | null = null;

export const anthropicProvider: AnalysisProvider = {
  name: "anthropic",
  async analyze(evidenceText) {
    // lazy so the app still starts without an API key
    client ??= new Anthropic();

    let response;
    try {
      response = await client.beta.messages.parse({
        model: MODEL,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "high", format: betaZodOutputFormat(AnalysisSchema) },
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: evidenceText }],
      });
    } catch (error) {
      if (error instanceof Anthropic.AuthenticationError) {
        throw new InvestigationError("Claude API credentials are missing or invalid (set ANTHROPIC_API_KEY)", 503);
      }
      if (error instanceof Anthropic.RateLimitError) {
        throw new InvestigationError("Claude API rate limit reached; retry shortly", 429);
      }
      if (error instanceof Anthropic.APIError) {
        throw new InvestigationError(`Claude API error ${error.status}: ${error.message}`, 502);
      }
      throw new InvestigationError(`Claude API unavailable: ${error instanceof Error ? error.message : String(error)}`, 503);
    }

    if (response.stop_reason === "refusal") {
      throw new InvestigationError("The model declined to analyse this incident", 422);
    }
    if (!response.parsed_output) {
      throw new InvestigationError(`No structured analysis returned (stop_reason: ${response.stop_reason})`, 502);
    }
    return { model: response.model, output: response.parsed_output };
  },
};
