// عميل خدمة دمج الفيديو — Video Merger API v2.
// بلا مفاتيح ولا توثيق؛ العنوان من MERGER_API_BASE. المخرجات MP4 (H.264 + AAC) حتى 1080p بجودة CRF 18،
// ولا توجد معاملات resolution/fps — الناتج ثابت. كل الملفات تُحذف تلقائيًا بعد 24 ساعة.
import { ProviderError } from "./providers/types";

const BASE = (process.env.MERGER_API_BASE || "").replace(/\/+$/, "");

export function mergerConfigured(): boolean {
  return BASE.length > 0;
}

export function mergerBase(): string {
  return BASE;
}

interface MergerFetchResult {
  ok: boolean;
  status: number;
  body: Record<string, unknown> | null;
  networkError?: string;
}

// كل الأخطاء الشبكية تعود كـ status=0 — المنسق يعاملها temporary ويواصل الاستعلام
async function mergerFetch(
  path: string,
  init?: RequestInit,
  timeoutMs = 30_000
): Promise<MergerFetchResult> {
  try {
    const res = await fetch(BASE + path, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let body: Record<string, unknown> | null = null;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      /* الجسم ليس JSON */
    }
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      body: null,
      networkError: e instanceof Error ? e.message : String(e),
    };
  }
}

// فحص جهوزية الخدمة: GET /api/config بمهلة 4 ثوانٍ (يُستخدم في /api/health)
export async function mergerHealthy(): Promise<boolean> {
  if (!mergerConfigured()) return false;
  const r = await mergerFetch("/api/config", { method: "GET" }, 4_000);
  return r.ok;
}

export interface MergerJob {
  jobId: string;
  expiresAt?: string;
}

export async function mergerCreateJob(videos: string[]): Promise<MergerJob> {
  const r = await mergerFetch(
    "/api/jobs",
    { method: "POST", body: JSON.stringify({ videos }) },
    30_000
  );
  if (!r.ok || !r.body?.jobId) {
    throw new ProviderError(
      r.status || 500,
      `merger: فشل إنشاء مهمة الدمج (${r.networkError || (r.body?.error as string) || `HTTP ${r.status}`})`
    );
  }
  return {
    jobId: String(r.body.jobId),
    expiresAt: r.body.expiresAt ? String(r.body.expiresAt) : undefined,
  };
}

// التنفيذ متزامن ويستغرق ~10–15 ثانية. نجاح 200 → شكل done، جارية → 202، فشل معلن → ProviderError نهائي.
export async function mergerProcess(jobId: string): Promise<Record<string, unknown>> {
  const r = await mergerFetch(`/api/jobs/${jobId}/process`, { method: "POST" }, 120_000);
  if (r.status === 202) return { status: "processing" };
  if (!r.ok) {
    // مثل مصدر يرفض التحميل: فشل حتمي — تكرار المحاولة يعطي النتيجة نفسها
    throw new ProviderError(
      r.status || 500,
      String(r.body?.error || r.networkError || `HTTP ${r.status}`)
    );
  }
  return r.body ?? {};
}

const DONE_RE = /^(done|completed|complete|success|succeeded|finished)$/i;
const FAILED_RE = /^(error|failed|failure|cancelled|canceled)$/i;

// تحليل دفاعي للحالة: progress قد يأتي كسرًا 0..1 فيُضرب في 100،
// والجسم قد يحمل error بدون status → عاملها failed فورًا.
export function parseMergerStatus(body: Record<string, unknown> | null): {
  status: "processing" | "completed" | "failed" | null;
  progress: number;
  error?: string;
} {
  if (!body) return { status: null, progress: 0 };
  let status: "processing" | "completed" | "failed" | null = null;
  const raw = body.status != null ? String(body.status) : null;
  if (raw) {
    if (DONE_RE.test(raw)) status = "completed";
    else if (FAILED_RE.test(raw)) status = "failed";
    else status = "processing";
  }
  if (!status && body.error) status = "failed";
  let progress = Number(body.progress ?? 0);
  if (!Number.isFinite(progress) || progress < 0) progress = 0;
  if (progress <= 1) progress *= 100;
  return {
    status,
    progress: Math.max(0, Math.min(100, Math.round(progress))),
    error: body.error ? String(body.error) : undefined,
  };
}

export interface MergerStatus {
  status: "processing" | "completed" | "failed" | null;
  progress: number;
  videoUrl: string | null;
  error?: string;
  expiresAt?: string;
  httpStatus: number;
}

export async function mergerStatus(jobId: string): Promise<MergerStatus> {
  const r = await mergerFetch(`/api/jobs/${jobId}`, { method: "GET" }, 15_000);
  if (r.status === 404) {
    // مهمة غير موجودة: حُذفت أو انتهت صلاحيتها بعد 24 ساعة → فشل نهائي
    return { status: "failed", progress: 100, videoUrl: null, error: "not_found_404", httpStatus: 404 };
  }
  const p = parseMergerStatus(r.body);
  const b = (r.body || {}) as Record<string, unknown>;
  // رابط النتيجة: فضّل videoUrl ثم downloadUrl، وإن غابا وبقي jobId فاضبط رابط البث المباشر
  const videoUrl =
    (b.videoUrl ? String(b.videoUrl) : null) ||
    (b.downloadUrl ? String(b.downloadUrl) : null) ||
    `${BASE}/api/jobs/${jobId}/video`;
  return {
    status: p.status,
    progress: p.progress,
    videoUrl,
    error: p.error,
    expiresAt: b.expiresAt ? String(b.expiresAt) : undefined,
    httpStatus: r.status,
  };
}

// حذف فوري (تنظيف اختياري)
export async function mergerDelete(jobId: string): Promise<void> {
  await mergerFetch(`/api/jobs/${jobId}`, { method: "DELETE" }, 10_000);
}
