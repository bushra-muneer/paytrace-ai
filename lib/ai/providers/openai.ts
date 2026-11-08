import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { AnalysisSchema, InvestigationError, SYSTEM_PROMPT, type AnalysisProvider } from "@/lib/ai/analysis";

// set PAYTRACE_OPENAI_MODEL to whichever model your account uses
const MODEL = process.env.PAYTRACE_OPENAI_MODEL || "gpt-4.1";

let client: OpenAI | null = null;

export const openaiProvider: AnalysisProvider = {
  name: "openai",
  async analyze(evidenceText) {
    // lazy so the app still starts without an API key
    client ??= new OpenAI();

    let response;
    try {
      response = await client.responses.parse({
        model: MODEL,
        instructions: SYSTEM_PROMPT,
        input: evidenceText,
        text: { format: zodTextFormat(AnalysisSchema, "incident_analysis") },
      });
    } catch (error) {
      if (error instanceof OpenAI.AuthenticationError) {
        throw new InvestigationError("OpenAI credentials are missing or invalid (set OPENAI_API_KEY)", 503);
      }
      if (error instanceof OpenAI.RateLimitError) {
        // OpenAI sends 429 both for real rate limits and for an account with no credit left
        if (error.code === "insufficient_quota") {
          throw new InvestigationError(
            "OpenAI account has no credit (insufficient_quota). Add billing at platform.openai.com/settings/organization/billing",
            402
          );
        }
        throw new InvestigationError(`OpenAI rate limit reached; retry shortly (${error.message})`, 429);
      }
      if (error instanceof OpenAI.APIError) {
        throw new InvestigationError(`OpenAI API error ${error.status}: ${error.message}`, 502);
      }
      throw new InvestigationError(`OpenAI API unavailable: ${error instanceof Error ? error.message : String(error)}`, 503);
    }

    const refused = response.output.some(
      (item) => item.type === "message" && item.content.some((part) => part.type === "refusal")
    );
    if (refused) throw new InvestigationError("The model declined to analyse this incident", 422);
    if (!response.output_parsed) {
      throw new InvestigationError(`No structured analysis returned (status: ${response.status})`, 502);
    }
    return { model: response.model, output: response.output_parsed };
  },
};
