// إدارة المفاتيح للواجهة — القائمة كاملة مع إخفاء المفاتيح دائمًا (maskKey)
import { NextResponse } from "next/server";
import { insertKey, listKeys, type KeyRow } from "@/lib/turso";
import { maskKey } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function publicKeyRow(k: KeyRow) {
  return {
    id: k.id,
    provider: k.provider,
    label: k.label,
    maskedKey: maskKey(k.api_key),
    status: k.status,
    usage_count: k.usage_count,
    success_count: k.success_count,
    fail_count: k.fail_count,
    last_used_at: k.last_used_at,
    last_checked_at: k.last_checked_at,
    last_error: k.last_error,
    created_at: k.created_at,
  };
}

export async function GET() {
  try {
    const rows = await listKeys();
    return NextResponse.json({ keys: rows.map(publicKeyRow) });
  } catch (e) {
    return NextResponse.json(
      { error: `تعذر جلب المفاتيح: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as
    | { provider?: string; api_key?: string; label?: string }
    | null;
  const provider = body?.provider;
  const apiKey = body?.api_key;
  const label = String(body?.label ?? "").slice(0, 60);
  if (provider !== "kie" && provider !== "cometapi") {
    return NextResponse.json({ error: "المزود غير صالح — القيم المسموحة: kie أو cometapi" }, { status: 400 });
  }
  if (!apiKey || typeof apiKey !== "string" || apiKey.trim().length < 4) {
    return NextResponse.json({ error: "المفتاح مطلوب ويجب أن يكون نصًا صالحًا (4 أحرف على الأقل)" }, { status: 400 });
  }
  try {
    const r = await insertKey(provider, apiKey.trim(), label);
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 409 });
    return NextResponse.json({ ok: true, id: r.id }, { status: 201 });
  } catch (e) {
    return NextResponse.json(
      { error: `تعذر إضافة المفتاح: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 }
    );
  }
}
