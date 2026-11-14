// فحص الصحة العام: قاعدة Turso + الموديلات + جهوزية خدمة الدمج + حالة الحماية
import { NextResponse } from "next/server";
import { ensureSchema, dbHealthy } from "@/lib/turso";
import { MODELS } from "@/lib/models";
import { mergerConfigured, mergerBase, mergerHealthy } from "@/lib/merger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  let dbOk = false;
  try {
    await ensureSchema();
    dbOk = await dbHealthy();
  } catch {
    dbOk = false;
  }
  // merger.healthy = فحص GET {MERGER_API_BASE}/api/config بمهلة 4 ثوانٍ
  const mergerOk = mergerConfigured() ? await mergerHealthy() : false;
  return NextResponse.json({
    ok: dbOk,
    database: dbOk ? "turso-connected" : "turso-error",
    mcpEndpoint: "/mcp",
    models: MODELS.map((m) => ({ canonical: m.canonical, type: m.type, providers: m.providers })),
    merger: { base: mergerBase() || null, healthy: mergerOk },
    authRequired: Boolean(process.env.MCP_ACCESS_TOKEN),
  });
}
