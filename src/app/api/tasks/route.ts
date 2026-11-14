// لوحة المهام: إحصائيات + أحدث المهام (تستطيع الواجهة استطلاعها كل ~5 ثوانٍ)
import { NextResponse } from "next/server";
import { taskStats, listRecentTasks, type Attempt } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parse<T>(json: string | null, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const limitRaw = Number.parseInt(searchParams.get("limit") || "20", 10);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(50, limitRaw)) : 20;
  try {
    const [stats, tasks] = await Promise.all([taskStats(), listRecentTasks(limit)]);
    return NextResponse.json({
      stats,
      tasks: tasks.map((t) => {
        const attempts = parse<Attempt[]>(t.attempts_json, []);
        return {
          id: t.id,
          type: t.type,
          model: t.model,
          status: t.status,
          progress: t.progress,
          provider: t.provider,
          prompt: t.prompt.slice(0, 160),
          result_urls: parse<string[]>(t.result_urls_json, []),
          error_message: t.error_message,
          attempts_count: attempts.length,
          created_at: t.created_at,
          completed_at: t.completed_at,
        };
      }),
    });
  } catch (e) {
    return NextResponse.json(
      { error: `تعذر جلب المهام: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 }
    );
  }
}
