// المزود الثاني: CometAPI.
// - الصور: نقطة images المتوافقة مع OpenAI وتعيد الرابط أو b64_json فورًا (متزامنة).
// - الفيديو: نقطة المهام غير المتزامنة بنفس نمط create/check الموحد.
// ملاحظة دفاعية: الشكلان مبنيان على النمط الموحد المذكور في مواصفة المشروع (والتوثيق العام)،
// وسيُراجع شكله الحقيقي تلقائيًا عند إضافة مفتاح CometAPI فعلي — أي شكل غير متوقع يُرمى
// كـ ProviderError فينتقل التبديل التسلسلي للمفتاح/المزود التالي دون توقف.
import { ProviderError, type ProviderAdapter, type CheckResult } from "./types";

const BASE = "https://api.cometapi.com";

function extractMessage(body: Record<string, unknown> | null, text: string, status: number): string {
  const err = body?.error;
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err) {
    return String((err as Record<string, unknown>).message);
  }
  if (body && typeof body.message === "string") return body.message;
  return text.slice(0, 300) || `HTTP ${status}`;
}

async function cometRequest(
  key: string,
  path: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      ...init,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(init.headers || {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new ProviderError(0, `network error: ${e instanceof Error ? e.message : String(e)}`);
  }
  const text = await res.text();
  let body: Record<string, unknown> | null = null;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* ليس JSON */
  }
  if (!res.ok) throw new ProviderError(res.status, extractMessage(body, text, res.status));
  return body ?? {};
}

export const cometapiAdapter: ProviderAdapter = {
  // الصور المتزامنة: OpenAI-compatible /v1/images/generations — تعيد url أو b64_json
  async createImageSync(key: string, input: Record<string, unknown>) {
    const providerModel = String(input.providerModel || input.model || "");
    const aspect = input.aspect_ratio && input.aspect_ratio !== "auto" ? input.aspect_ratio : undefined;
    const body = await cometRequest(
      key,
      "/v1/images/generations",
      {
        method: "POST",
        body: JSON.stringify({
          model: providerModel,
          prompt: input.prompt,
          ...(aspect ? { aspect_ratio: aspect } : {}),
          ...(input.resolution ? { resolution: input.resolution } : {}),
          ...(input.background && input.background !== "auto" ? { background: input.background } : {}),
          ...(input.output_format ? { output_format: input.output_format } : {}),
        }),
      },
      120_000
    );
    const data = body.data as Array<Record<string, unknown>> | undefined;
    const urls: string[] = [];
    for (const item of Array.isArray(data) ? data : []) {
      if (item?.url) urls.push(String(item.url));
      // b64_json → data URI داخل الرد نفسه؛ لا تُنزَّل أي وسائط على سيرفرنا أبدًا
      else if (item?.b64_json) urls.push(`data:image/png;base64,${String(item.b64_json)}`);
    }
    if (!urls.length) throw new ProviderError(500, "cometapi: unexpected image response shape (no url/b64_json)");
    return { urls };
  },

  // الفيديو: مهمة غير متزامنة بنفس نمط create/check الموحد
  async createTask(key: string, model: string, input: Record<string, unknown>) {
    const body = await cometRequest(
      key,
      "/v1/jobs/createTask",
      { method: "POST", body: JSON.stringify({ model, input }) },
      30_000
    );
    const data = body.data as Record<string, unknown> | undefined;
    const taskId = data?.taskId ?? body.taskId ?? body.id;
    if (!taskId) throw new ProviderError(500, "cometapi: unexpected response shape (missing task id)");
    return { providerTaskId: String(taskId) };
  },

  async checkTask(key: string, providerTaskId: string): Promise<CheckResult> {
    const body = await cometRequest(
      key,
      `/v1/jobs/recordInfo?taskId=${encodeURIComponent(providerTaskId)}`,
      { method: "GET" },
      30_000
    );
    const data = (body.data as Record<string, unknown>) || body;
    const rawStatus = String(data.status || data.state || "processing").toLowerCase();
    if (rawStatus === "success" || rawStatus === "completed") {
      let urls: string[] = [];
      if (typeof data.resultJson === "string") {
        try {
          const inner = JSON.parse(data.resultJson) as Record<string, unknown>;
          if (Array.isArray(inner.resultUrls)) urls = inner.resultUrls.map(String);
        } catch {
          /* تفاوت شكل محتمل */
        }
      }
      if (!urls.length && Array.isArray(data.resultUrls)) urls = (data.resultUrls as unknown[]).map(String);
      if (!urls.length && Array.isArray(data.urls)) urls = (data.urls as unknown[]).map(String);
      if (!urls.length && data.videoUrl) urls = [String(data.videoUrl)];
      return { status: "completed", urls };
    }
    if (rawStatus === "fail" || rawStatus === "failed" || rawStatus === "error") {
      return { status: "failed", error: String(data.failMsg || data.error || "cometapi: task failed") };
    }
    return { status: "processing" };
  },
};
