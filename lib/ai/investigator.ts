import { InvestigationError } from "@/lib/ai/analysis";
import { selectProvider } from "@/lib/ai/providers";
import type { AiAnalysis, Incident, Money } from "@/lib/domain/types";
import { PayPalApiError, paypalRequest } from "@/lib/paypal/client";
import type { PayPalOrder } from "@/lib/paypal/types";
import { proposeActionInDb, RecoveryActionError } from "@/lib/recovery/propose";
import { readDb, withDb } from "@/lib/storage/store";

// Sends an incident plus its evidence to the configured AI provider (Claude or OpenAI)
// and stores the analysis. Recommended actions are only saved as proposals, a person
// still has to approve them.

export async function investigateIncident(incidentId: string): Promise<Incident> {
  const db = await readDb();
  const incident = db.incidents[incidentId];
  if (!incident) throw new InvestigationError("Incident not found", 404);

  let paypalOrder: PayPalOrder | { error: string };
  try {
    paypalOrder = await paypalRequest<PayPalOrder>(
      `/v2/checkout/orders/${encodeURIComponent(incident.orderId)}`
    );
  } catch (error) {
    // still worth investigating, the lookup failure itself is useful info
    paypalOrder = {
      error: error instanceof PayPalApiError ? `${error.status}: ${error.message}` : String(error),
    };
  }

  const evidence = {
    incident: { ...incident, aiAnalysis: undefined },
    paypalOrder,
    localTransaction: db.transactions[incident.orderId] ?? null,
    webhookEvents: Object.values(db.webhookEvents)
      .filter((e) => e.orderId === incident.orderId)
      .sort((a, b) => a.firstReceivedAt.localeCompare(b.firstReceivedAt)),
    recoveryActions: Object.values(db.recoveryActions).filter(
      (a) => a.orderId === incident.orderId
    ),
  };

  const { model, output } = await selectProvider().analyze(
    `Investigate this incident.\n\n<incident_data>\n${JSON.stringify(evidence, null, 2)}\n</incident_data>`
  );

  return withDb((db) => {
    const current = db.incidents[incidentId];
    if (!current) throw new InvestigationError("Incident not found", 404);

    const proposer = `ai:${model}`;
    const proposedActionIds: string[] = [];
    for (const rec of output.recommendedActions) {
      if (rec.type === "MANUAL_INVESTIGATION") continue;

      let amount: Money | undefined;
      if (rec.type === "REFUND_CAPTURE" && rec.refundAmount) {
        const currency = current.financialImpact?.currency ?? output.financialImpact.currency;
        // a partial refund without a known currency must not turn into a full refund
        if (!currency || !/^\d+(\.\d{1,2})?$/.test(rec.refundAmount)) continue;
        amount = { currency, value: rec.refundAmount };
      }

      try {
        const action = proposeActionInDb(db, {
          incidentId,
          type: rec.type,
          proposedBy: proposer,
          rationale: rec.description,
          params: amount ? { amount } : undefined,
        });
        proposedActionIds.push(action.id);
      } catch (error) {
        // policy said no (e.g. order already refunded), keep the advice but skip the proposal
        if (!(error instanceof RecoveryActionError)) throw error;
      }
    }

    const analysis: AiAnalysis = {
      model,
      generatedAt: new Date().toISOString(),
      rootCause: output.rootCause,
      explanation: output.explanation,
      confidence: output.confidence,
      evidenceAssessment: output.evidenceAssessment,
      financialImpact: output.financialImpact,
      customerImpact: output.customerImpact,
      recommendedActions: output.recommendedActions.map(({ type, description, risk }) => ({
        type,
        description,
        risk,
      })),
      proposedActionIds,
    };
    current.aiAnalysis = analysis;
    return current;
  });
}
