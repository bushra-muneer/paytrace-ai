import { NextRequest, NextResponse } from "next/server";
import { rejectWithoutPasscode } from "@/lib/http/approver";
import { errorResponse, invalidJson, readJsonBody } from "@/lib/http/responses";
import { reconcileAll, reconcileOrder } from "@/lib/reconciliation/reconcile";

// { orderId } for one order, empty body for all of them
// each run calls the PayPal API per order, so it's gated like other actions
export async function POST(request: NextRequest) {
  const denied = rejectWithoutPasscode(request);
  if (denied) return denied;

  const body = await readJsonBody<{ orderId?: unknown }>(request);
  if (!body) return invalidJson();

  try {
    if (typeof body.orderId === "string" && body.orderId) {
      const result = await reconcileOrder(body.orderId);
      return NextResponse.json({ success: true, ...result });
    }

    // one bad order shouldn't fail the whole run, failures are listed in errors
    const { results, errors } = await reconcileAll();
    return NextResponse.json({
      success: true,
      reconciled: results.length,
      inSync: results.filter((r) => r.inSync).length,
      openIncidents: results.flatMap((r) => r.openIncidents),
      errors,
    });
  } catch (error) {
    return errorResponse(error, "Reconciliation failed");
  }
}
