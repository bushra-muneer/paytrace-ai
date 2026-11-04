import { NextRequest, NextResponse } from "next/server";
import type { Money, RecoveryActionType } from "@/lib/domain/types";
import { rejectWithoutPasscode } from "@/lib/http/approver";
import { errorResponse, invalidJson, readJsonBody } from "@/lib/http/responses";
import { proposeAction } from "@/lib/recovery/actions";
import { isAutomatedActor } from "@/lib/recovery/propose";

const TYPES: ReadonlySet<string> = new Set<RecoveryActionType>([
  "SYNC_LOCAL_STATUS",
  "CREATE_LOCAL_RECORD",
  "REFUND_CAPTURE",
]);

// manual proposal, e.g. { type: "REFUND_CAPTURE", actor, rationale, amount: { currency, value } }
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const denied = rejectWithoutPasscode(request);
  if (denied) return denied;

  const { id } = await ctx.params;
  const body = await readJsonBody<{ type?: string; actor?: string; rationale?: string; amount?: Money }>(request);
  if (!body) return invalidJson();

  if (body.actor && isAutomatedActor(body.actor.trim())) {
    return NextResponse.json({ success: false, error: `"${body.actor}" is reserved for automated proposals` }, { status: 400 });
  }

  if (!body.type || !TYPES.has(body.type) || !body.actor?.trim() || !body.rationale?.trim()) {
    return NextResponse.json(
      { success: false, error: `type (${[...TYPES].join(", ")}), actor and rationale are required` },
      { status: 400 }
    );
  }
  if (body.amount && !/^\d+(\.\d{1,2})?$/.test(body.amount.value ?? "")) {
    return NextResponse.json({ success: false, error: "amount.value must be a decimal like 5.00" }, { status: 400 });
  }

  try {
    const action = await proposeAction({
      incidentId: id,
      type: body.type as RecoveryActionType,
      proposedBy: body.actor.trim(),
      rationale: body.rationale.trim(),
      params: body.amount ? { amount: body.amount } : undefined,
    });
    return NextResponse.json({ success: true, action });
  } catch (error) {
    return errorResponse(error, "Propose action failed");
  }
}
