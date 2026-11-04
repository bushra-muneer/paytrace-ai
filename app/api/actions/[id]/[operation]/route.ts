import { NextRequest, NextResponse } from "next/server";
import { rejectWithoutPasscode } from "@/lib/http/approver";
import { errorResponse, invalidJson, readJsonBody } from "@/lib/http/responses";
import { approveAction, executeAction, rejectAction } from "@/lib/recovery/actions";

// POST /api/actions/:id/(approve|reject|execute) with { actor, note?, acknowledgeFinancialImpact? }
// The actor name is self-declared; PAYTRACE_APPROVER_PASSCODE is the only gate for now.
export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string; operation: string }> }
) {
  const denied = rejectWithoutPasscode(request);
  if (denied) return denied;

  const { id, operation } = await ctx.params;
  const body = await readJsonBody<{ actor?: string; note?: string; acknowledgeFinancialImpact?: boolean }>(request);
  if (!body) return invalidJson();

  const actor = body.actor?.trim() ?? "";

  try {
    switch (operation) {
      case "approve":
        return NextResponse.json({
          success: true,
          action: await approveAction(id, {
            actor,
            note: body.note,
            acknowledgeFinancialImpact: body.acknowledgeFinancialImpact === true,
          }),
        });
      case "reject":
        return NextResponse.json({ success: true, action: await rejectAction(id, { actor, note: body.note }) });
      case "execute": {
        const action = await executeAction(id, actor);
        return NextResponse.json({
          success: action.status === "EXECUTED",
          action,
          error: action.error ?? undefined,
        });
      }
      default:
        return NextResponse.json({ success: false, error: "Unknown operation" }, { status: 404 });
    }
  } catch (error) {
    return errorResponse(error, `Action ${operation} failed`);
  }
}
