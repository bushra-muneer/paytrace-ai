import { NextRequest, NextResponse } from "next/server";
import { investigateIncident } from "@/lib/ai/investigator";
import { rejectWithoutPasscode } from "@/lib/http/approver";
import { errorResponse } from "@/lib/http/responses";

export const maxDuration = 300; // model calls can be slow

export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  // each run costs API credits, so a public demo shouldn't let anyone trigger it
  const denied = rejectWithoutPasscode(request);
  if (denied) return denied;

  const { id } = await ctx.params;
  try {
    const incident = await investigateIncident(id);
    return NextResponse.json({ success: true, incident });
  } catch (error) {
    return errorResponse(error, `Investigation of ${id} failed`);
  }
}
