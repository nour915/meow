// المزود الأساسي: kie.ai عبر Jobs API الموحد وفق التوثيق الرسمي (docs.kie.ai).
// الانتباه: في استجابة recordInfo حقل resultJson نص JSON داخل JSON ويحتاج JSON.parse ثانيًا.
import { ProviderError, type ProviderAdapter, type CheckResult } from "./types";

const BASE = "https://api.kie.ai";
const TIMEOUT_MS = 30_000;

async function kieRequest(key: string, path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      ...init,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(init?.headers || {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // انقطاع شبكة/مهلة — status=0 يُصنَّف لاحقًا كـ temporary
    throw new ProviderError(0, `network error: ${msg}`);
  }
  const text = await res.text();
  let body: Record<string, unknown> | null = null;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* الجسم ليس JSON */
  }
  // kie يعيد {"code":200,...} — أي كود آخر أو حالة HTTP غير ناجحة = خطأ مزود
  const code = body && typeof body.code === "number" ? body.code : res.status;
  if (code !== 200) {
    const msg =
      (body && ((body.msg as string) || (body.message as string))) ||
      text.slice(0, 300) ||
      `HTTP ${res.status}`;
    throw new ProviderError(code || res.status, String(msg));
  }
  return body ?? {};
}

export const kieAdapter: ProviderAdapter = {
  async createTask(key: string, model: string, input: Record<string, unknown>) {
    const body = await kieRequest(key, "/api/v1/jobs/createTask", {
      method: "POST",
      body: JSON.stringify({ model, input }),
    });
    const data = body.data as Record<string, unknown> | undefined;
    const taskId = data?.taskId;
    if (!taskId) {
      // شكل غير متوقع — يُصنَّف temporary فينتقل للمفتاح التالي دون توقف
      throw new ProviderError(500, "kie: unexpected response shape (missing data.taskId)");
    }
    return { providerTaskId: String(taskId) };
  },

  async checkTask(key: string, providerTaskId: string): Promise<CheckResult> {
    const body = await kieRequest(
      key,
      `/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(providerTaskId)}`
    );
    const data = (body.data as Record<string, unknown>) || {};
    const state = String(data.state || "waiting");
    if (state === "success") {
      let urls: string[] = [];
      if (typeof data.resultJson === "string") {
        try {
          const inner = JSON.parse(data.resultJson) as Record<string, unknown>;
          if (Array.isArray(inner.resultUrls)) urls = inner.resultUrls.map(String);
        } catch {
          /* resultJson تالف — نعاملها كمعالجة مستمرة بدل فشل خاطئ */
        }
      } else if (Array.isArray(data.resultUrls)) {
        urls = (data.resultUrls as unknown[]).map(String);
      }
      return { status: "completed", urls };
    }
    if (state === "fail") {
      return {
        status: "failed",
        error: String(data.failMsg || data.errorMessage || "kie: task failed without a message"),
      };
    }
    // waiting | queuing | generating — النسبة تُقدَّر في المنسق حسب الزمن المنقضي
    return { status: "processing" };
  },
};
