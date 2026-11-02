import { NextRequest, NextResponse } from "next/server";
import { investigateIncident } from "@/lib/ai/investigator";
import { errorResponse } from "@/lib/http/responses";

export const maxDuration = 300; // model calls can be slow

export async function POST(_request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const incident = await investigateIncident(id);
    return NextResponse.json({ success: true, incident });
  } catch (error) {
    return errorResponse(error, `Investigation of ${id} failed`);
  }
}
