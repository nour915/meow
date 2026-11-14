// تعطيل/تنشيط يدوي وحذف مفتاح — المفتاح الكامل لا يُعاد في أي استجابة
import { NextResponse } from "next/server";
import { getKeyById, updateKeyStatus, deleteKey } from "@/lib/turso";
import { maskKey } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function publicKeyRow(k: NonNullable<Awaited<ReturnType<typeof getKeyById>>>) {
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

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json().catch(() => null)) as { status?: string } | null;
  if (body?.status !== "active" && body?.status !== "disabled") {
    return NextResponse.json({ error: "الحالة المسموحة: active أو disabled (تعطيل/تنشيط يدوي)" }, { status: 400 });
  }
  const k = await updateKeyStatus(id, body.status);
  if (!k) return NextResponse.json({ error: "المفتاح غير موجود" }, { status: 404 });
  return NextResponse.json({ ok: true, key: publicKeyRow(k) });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const k = await getKeyById(id);
  if (!k) return NextResponse.json({ error: "المفتاح غير موجود" }, { status: 404 });
  await deleteKey(id);
  return NextResponse.json({ ok: true });
}
