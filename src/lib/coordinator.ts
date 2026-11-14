// منسق التوليد — قلب المشروع:
// 1) تجربة المفاتيح تسلسليًا بترتيب الإضافة حتى نجاح الإنشاء.
// 2) عند أي فشل مفتاح/رصيد في منتصف المهمة: إعادة إنشاء نفس المهمة بنفس task_id على المفتاح التالي.
// 3) المهمة التي تفشل على كل المفاتيح تبقى processing وتُعاد محاولتها مع كل get_task (تهدئة ~45 ثانية).
// 4) نموذج الذكاء الاصطناعي لا يرى أخطاء المفاتيح أو الرصيد أبدًا — التبديل صامت تمامًا من وجهة نظره.
import { randomUUID } from "node:crypto";
import {
  insertTask,
  getTask,
  updateTask,
  listRecentTasks,
  getKeyById,
  type Attempt,
  type TaskRow,
} from "./turso";
import { getKeyPool, classifyProviderError, recordKeyAttempt } from "./keys";
import { ADAPTERS, ProviderError, type CheckResult } from "./providers/types";
import { normalizeModel, MODELS, type ModelDef, type ProviderId } from "./models";
import * as merger from "./merger";
import { waitUntil } from "@vercel/functions";

/* رسائل مشكلات المفتاح/الرصيد التي قد تظهر في منتصف المهمة (قسم 4.3.2) */
const KEY_PATTERN_RE = /insufficient|balance|credit|quota|402|401|unauthorized/i;
/* تهدئة إعادة المحاولة على المفاتيح عند كل get_task */
const POOL_RETRY_COOLDOWN_MS = 45_000;
/* فاصل الاستعلام وبث التقدم */
const POLL_INTERVAL_MS = 3_000;
/* أزمنة التوليد المتوقعة لتقدير النسبة — المزودون لا يعطون نسبة حقيقية للصور/الفيديو */
const EXPECTED_MS: Record<string, number> = { image: 50_000, video: 180_000 };

export type NotifyFn = (progress: number, message: string) => Promise<void> | void;
const noopNotify: NotifyFn = () => {};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function safeParse<T>(json: string | null | undefined, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

// قاعدة ذهبية: لا يصل أي ذكر لمفاتيح أو رصيد إلى العميل أبدًا
function sanitizeClientError(msg: string): string {
  if (KEY_PATTERN_RE.test(msg) || /api.?key|401|403/i.test(msg)) {
    return "تعذر إكمال المهمة على المزود حاليًا — أعد المحاولة بعد قليل.";
  }
  return msg;
}

/* ---------- بناء input لكل نوع ---------- */
// نرسل للمزود فقط الحقول الموثقة؛ القيم الافتراضية تُرسل صراحة لضبط السلوك.
function buildImageInput(params: Record<string, unknown>): Record<string, unknown> {
  const input: Record<string, unknown> = { prompt: String(params.prompt ?? "") };
  input.aspect_ratio = String(params.aspect_ratio || "auto");
  input.resolution = String(params.resolution || "1K");
  if (params.background) input.background = String(params.background);
  if (params.output_format) input.output_format = String(params.output_format);
  return input;
}

function buildVideoInput(params: Record<string, unknown>): Record<string, unknown> {
  const input: Record<string, unknown> = { prompt: String(params.prompt ?? "") };
  if (params.image_url) input.image_url = String(params.image_url);
  if (params.aspect_ratio && params.aspect_ratio !== "auto") input.aspect_ratio = String(params.aspect_ratio);
  input.resolution = String(params.resolution || "480p");
  if (params.duration) input.duration = Number(params.duration);
  return input;
}

/* ---------- صياغة الردود العربية ---------- */
export function processingMessage(taskId: string): string {
  return `⏳ المهمة قيد المعالجة — task_id: ${taskId}\n\nتابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.`;
}

function completedMessage(task: TaskRow | null, urls: string[]): string {
  const links = urls.map((u) => `الرابط المباشر: ${u}`).join("\n\n");
  if (!task) {
    return `✅ اكتملت المهمة بنجاح\n\n${links}`;
  }
  if (task.type === "image") {
    const embed = urls.map((u) => `![image](${u})`).join("\n\n");
    return `✅ تم توليد الصورة بنجاح\n\n${embed}\n\n${links}`;
  }
  if (task.type === "video") {
    return `✅ تم توليد الفيديو بنجاح\n\n${links}`;
  }
  return `✅ تم دمج المقاطع بنجاح\n\n${links}\n\n⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا.`;
}

function failedMessage(task: TaskRow | null): { text: string; isError: true } {
  return { text: `❌ فشلت المهمة: ${task?.error_message || "سبب غير معروف"}`, isError: true };
}

// تقدير نسبة التقدم: حقيقي من الدمج إن وُجد، وإلا تقدير زمني للصور/الفيديو
function estimateProgress(type: string, createdAt: string, real?: number): number {
  if (real != null && real > 0) return Math.max(1, Math.min(99, Math.round(real)));
  const start = Date.parse(createdAt.replace(" ", "T") + "Z");
  const elapsed = Number.isFinite(start) ? Date.now() - start : 0;
  const expected = EXPECTED_MS[type] ?? 60_000;
  return Math.max(5, Math.min(95, Math.round((elapsed / expected) * 95)));
}

function taskUrls(task: TaskRow): string[] {
  return safeParse<string[]>(task.result_urls_json, []);
}

/* ---------- الإنشاء التسلسلي على المفاتيح ---------- */
interface CreateOutcome {
  ok: boolean;
  reason?: "params" | "nokeys";
  error?: string;
  provider?: ProviderId;
  candidateIndex?: number;
}

// يجرب المرشحين بالترتيب بدءًا من startIndex؛ أول نجاح يربط المهمة بالمزود والمفتاح.
// كل محاولة (نجاح أو فشل + فئتها) تُسجل في attempts_json وعدّادات المفتاح تُحدَّث دائمًا.
async function tryCreateOnKeys(
  taskId: string,
  def: ModelDef,
  pool: Awaited<ReturnType<typeof getKeyPool>>,
  startIndex: number,
  input: Record<string, unknown>
): Promise<CreateOutcome> {
  const task = await getTask(taskId);
  const baseParams = task ? safeParse<Record<string, unknown>>(task.params_json, {}) : {};

  for (let i = Math.max(0, startIndex); i < pool.length; i++) {
    const key = pool[i];
    const provider = key.provider as ProviderId;
    const adapter = ADAPTERS[provider];
    if (!adapter) continue;
    const providerModel = def.providerModel[provider] || def.canonical;
    try {
      let outcome: { providerTaskId?: string; urls?: string[] };
      if (def.type === "image" && adapter.createImageSync) {
        // صور متزامنة إن دعمها المزود (CometAPI) — نتيجة فورية بلا providerTaskId
        const r = await adapter.createImageSync(key.api_key, { ...input, providerModel });
        outcome = { urls: r.urls };
      } else {
        const r = await adapter.createTask(key.api_key, providerModel, input);
        outcome = { providerTaskId: r.providerTaskId };
      }
      await recordKeyAttempt(key.id, true, null, null);
      if (outcome.urls) {
        await updateTask(
          taskId,
          {
            provider,
            key_id: key.id,
            status: "completed",
            progress: 100,
            result_urls_json: JSON.stringify(outcome.urls),
          },
          { provider, keyId: key.id, keyLabel: key.label, ok: true, at: new Date().toISOString() }
        );
      } else {
        await updateTask(
          taskId,
          {
            provider,
            provider_task_id: outcome.providerTaskId,
            key_id: key.id,
            status: "processing",
            progress: 5,
            error_message: null,
            params_json: JSON.stringify({ ...baseParams, candidateIndex: i }),
          },
          { provider, keyId: key.id, keyLabel: key.label, ok: true, at: new Date().toISOString() }
        );
      }
      return { ok: true, provider, candidateIndex: i };
    } catch (e) {
      const err =
        e instanceof ProviderError ? e : new ProviderError(0, e instanceof Error ? e.message : String(e));
      const cls = classifyProviderError(err.status, err.message);
      await recordKeyAttempt(key.id, false, cls, err.message);
      await updateTask(
        taskId,
        {},
        {
          provider,
          keyId: key.id,
          keyLabel: key.label,
          ok: false,
          errorClass: cls,
          error: err.message.slice(0, 300),
          at: new Date().toISOString(),
        }
      );
      if (cls === "params") {
        // خطأ معطيات الطلب — تبديل المفاتيح لن يحلّه؛ توقف فورًا
        return { ok: false, reason: "params", error: err.message };
      }
      // disabled / exhausted / provider / temporary → انتقل للمفتاح التالي فورًا
    }
  }
  return { ok: false, reason: "nokeys" };
}

// إعادة إنشاء نفس المهمة بنفس task_id على المفتاح التالي — العميل يرى «قيد المعالجة» فقط
async function failoverRecreate(taskId: string, def: ModelDef): Promise<boolean> {
  const task = await getTask(taskId);
  if (!task) return false;
  const paramsObj = safeParse<Record<string, unknown>>(task.params_json, {});
  const nextIndex = Number(paramsObj.candidateIndex ?? 0) + 1;
  const pool = await getKeyPool(def.providers);
  const input = task.type === "image" ? buildImageInput(paramsObj) : buildVideoInput(paramsObj);
  const created = await tryCreateOnKeys(taskId, def, pool, nextIndex, input);
  if (!created.ok) {
    // كل المفاتيح فشلت — تبقى processing وستُعاد المحاولة مع كل get_task
    await updateTask(taskId, {
      status: "processing",
      error_message: "بانتظار توفر مفتاح صالح…",
      params_json: JSON.stringify({
        ...paramsObj,
        candidateIndex: nextIndex,
        lastPoolAttemptAt: new Date().toISOString(),
      }),
    });
    return false;
  }
  return true;
}

/* ---------- التوليد ---------- */
export interface GenerateArgs {
  type: "image" | "video";
  model?: string;
  prompt: string;
  params: Record<string, unknown>;
  waitSeconds: number;
  notify?: NotifyFn;
}

export async function runGeneration(args: GenerateArgs): Promise<{ text: string; isError?: boolean }> {
  const notify = args.notify ?? noopNotify;
  const def = normalizeModel(args.model);
  if (!def || def.type !== args.type) {
    return {
      text: `❌ موديل غير معروف: ${args.model ?? "(فارغ)"}. المتاح: ${MODELS.map((m) => m.canonical).join("، ")}`,
      isError: true,
    };
  }
  const pool = await getKeyPool(def.providers);
  if (pool.length === 0) {
    return {
      text: `❌ لا توجد مفاتيح نشطة لخدمة ${def.canonical}. أضف مفتاحًا واحدًا على الأقل من واجهة الإدارة، ثم أعد المحاولة.`,
      isError: true,
    };
  }
  const taskId = randomUUID();
  const input = args.type === "image" ? buildImageInput(args.params) : buildVideoInput(args.params);
  const paramsObj: Record<string, unknown> = {
    ...args.params,
    prompt: args.prompt,
    wait_seconds: args.waitSeconds,
    candidateIndex: 0,
    lastPoolAttemptAt: null,
  };
  await insertTask({
    id: taskId,
    provider: null,
    provider_task_id: null,
    key_id: null,
    model: def.canonical,
    type: args.type,
    prompt: args.prompt,
    params_json: JSON.stringify(paramsObj),
    status: "pending",
  });
  const created = await tryCreateOnKeys(taskId, def, pool, 0, input);
  if (!created.ok) {
    if (created.reason === "params") {
      const msg = sanitizeClientError(created.error || "معطيات الطلب غير صالحة");
      await updateTask(taskId, { status: "failed", progress: 100, error_message: msg });
      return failedMessage(await getTask(taskId));
    }
    await updateTask(taskId, {
      status: "processing",
      progress: 0,
      error_message: "بانتظار توفر مفتاح صالح…",
      params_json: JSON.stringify({ ...paramsObj, lastPoolAttemptAt: new Date().toISOString() }),
    });
    return { text: processingMessage(taskId) };
  }
  // صورة متزامنة اكتملت فورًا؟
  const t = await getTask(taskId);
  if (t && t.status === "completed") {
    return { text: completedMessage(t, taskUrls(t)) };
  }
  return waitWindow(taskId, def, args.waitSeconds, notify);
}

// نافذة الانتظار: استعلام كل 3 ثوانٍ مع بث progress notifications عربية
async function waitWindow(
  taskId: string,
  def: ModelDef,
  waitSeconds: number,
  notify: NotifyFn
): Promise<{ text: string; isError?: boolean }> {
  const deadline = Date.now() + Math.max(0, waitSeconds) * 1000;
  let lastNotifyAt = 0;
  for (;;) {
    const task = await getTask(taskId);
    if (!task || task.status === "completed" || task.status === "failed") {
      if (task && task.status === "completed") return { text: completedMessage(task, taskUrls(task)) };
      if (task && task.status === "failed") return failedMessage(task);
      return { text: processingMessage(taskId) };
    }
    if (Date.now() >= deadline) return { text: processingMessage(taskId) };
    if (!task.provider || !task.provider_task_id) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    const provider = task.provider as ProviderId;
    const adapter = ADAPTERS[provider];
    const key = task.key_id ? await getKeyById(task.key_id) : null;
    if (!adapter || !key) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    let r: CheckResult | null = null;
    try {
      r = await adapter.checkTask(key.api_key, task.provider_task_id);
    } catch (e) {
      const err = e instanceof ProviderError ? e : new ProviderError(0, e instanceof Error ? e.message : String(e));
      const cls = classifyProviderError(err.status, err.message);
      if (cls === "temporary") {
        // أخطاء الاستعلام المؤقتة لا تعاقب المفتاح ولا توقف المهمة
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      await recordKeyAttempt(key.id, false, cls, err.message);
      await updateTask(
        taskId,
        {},
        {
          provider,
          keyId: key.id,
          keyLabel: key.label,
          ok: false,
          errorClass: cls,
          error: err.message.slice(0, 300),
          at: new Date().toISOString(),
        }
      );
      // المفتاح صار مرفوضًا/مستنزفًا أو الموديل غير مدعوم أثناء المتابعة → تبديل فوري لنفس المهمة
      await failoverRecreate(taskId, def);
      continue;
    }
    if (r.status === "completed") {
      const urls = r.urls ?? [];
      if (!urls.length) {
        await updateTask(taskId, {
          status: "failed",
          progress: 100,
          error_message: "المزود أعلن الاكتمال دون روابط نتائج",
        });
        return failedMessage(await getTask(taskId));
      }
      await updateTask(
        taskId,
        { status: "completed", progress: 100, result_urls_json: JSON.stringify(urls) },
        { provider, keyId: key.id, keyLabel: key.label, ok: true, at: new Date().toISOString() }
      );
      return { text: completedMessage(await getTask(taskId), urls) };
    }
    if (r.status === "failed") {
      const err = r.error || "فشل المزود دون رسالة";
      if (KEY_PATTERN_RE.test(err)) {
        // فشل في منتصف المهمة بسبب مفتاح/رصيد → استئناف نفس المهمة على المفتاح التالي
        const cls = classifyProviderError(undefined, err);
        await recordKeyAttempt(key.id, false, cls, err);
        await updateTask(
          taskId,
          {},
          {
            provider,
            keyId: key.id,
            keyLabel: key.label,
            ok: false,
            errorClass: cls,
            error: err.slice(0, 300),
            at: new Date().toISOString(),
          }
        );
        await failoverRecreate(taskId, def);
        continue;
      }
      // فشل حقيقي (انتهاك سياسة/معطيات)
      await updateTask(taskId, { status: "failed", progress: 100, error_message: sanitizeClientError(err) });
      return failedMessage(await getTask(taskId));
    }
    // processing: تحديث النسبة في القاعدة + بث إشعار تقدم
    const pct = estimateProgress(task.type, task.created_at, r.progress);
    await updateTask(taskId, { progress: pct });
    const now = Date.now();
    if (now - lastNotifyAt >= POLL_INTERVAL_MS) {
      lastNotifyAt = now;
      await notify(pct, `قيد التوليد… ${pct}%`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

/* ---------- التتبع (get_task) ---------- */
export async function refreshTask(taskId: string): Promise<{ text: string; isError?: boolean }> {
  const task = await getTask(taskId);
  if (!task) {
    return {
      text: `❌ لا توجد مهمة بهذا المعرّف: ${taskId}. تحقق من task_id أو استخدم list_media لعرض المهام المخزنة.`,
      isError: true,
    };
  }
  if (task.type === "merge") return refreshMergeTask(task);
  if (task.status === "completed") return { text: completedMessage(task, taskUrls(task)) };
  if (task.status === "failed") return failedMessage(task);

  const def = normalizeModel(task.model);
  if (!def) return failedMessage(task);

  // 1) لم ينجح الإنشاء بعد: أعِد المحاولة على المفاتيح مع كل get_task (بتهدئة ~45 ثانية)
  if (!task.provider || !task.provider_task_id) {
    const paramsObj = safeParse<Record<string, unknown>>(task.params_json, {});
    const last = paramsObj.lastPoolAttemptAt ? Date.parse(String(paramsObj.lastPoolAttemptAt)) : 0;
    if (last && Date.now() - last < POOL_RETRY_COOLDOWN_MS) return { text: processingMessage(taskId) };
    const pool = await getKeyPool(def.providers);
    const input = task.type === "image" ? buildImageInput(paramsObj) : buildVideoInput(paramsObj);
    const created = await tryCreateOnKeys(taskId, def, pool, Number(paramsObj.candidateIndex ?? 0), input);
    if (!created.ok) {
      if (created.reason === "params") {
        const msg = sanitizeClientError(created.error || "معطيات الطلب غير صالحة");
        await updateTask(taskId, { status: "failed", progress: 100, error_message: msg });
        return failedMessage(await getTask(taskId));
      }
      await updateTask(taskId, {
        params_json: JSON.stringify({ ...paramsObj, lastPoolAttemptAt: new Date().toISOString() }),
      });
      return { text: processingMessage(taskId) };
    }
    const t2 = await getTask(taskId);
    if (t2 && t2.status === "completed") return { text: completedMessage(t2, taskUrls(t2)) };
    return { text: processingMessage(taskId) };
  }

  // 2) المهمة مرتبطة بمزود: حدّث حالتها حية من المزود
  const provider = task.provider as ProviderId;
  const adapter = ADAPTERS[provider];
  const key = task.key_id ? await getKeyById(task.key_id) : null;
  if (!adapter || !key) return { text: processingMessage(taskId) };
  let r: CheckResult;
  try {
    r = await adapter.checkTask(key.api_key, task.provider_task_id);
  } catch (e) {
    const err = e instanceof ProviderError ? e : new ProviderError(0, e instanceof Error ? e.message : String(e));
    const cls = classifyProviderError(err.status, err.message);
    if (cls === "temporary") return { text: processingMessage(taskId) };
    await recordKeyAttempt(key.id, false, cls, err.message);
    await updateTask(
      taskId,
      {},
      {
        provider,
        keyId: key.id,
        keyLabel: key.label,
        ok: false,
        errorClass: cls,
        error: err.message.slice(0, 300),
        at: new Date().toISOString(),
      }
    );
    await failoverRecreate(taskId, def);
    return { text: processingMessage(taskId) };
  }
  if (r.status === "completed") {
    const urls = r.urls ?? [];
    if (!urls.length) {
      await updateTask(taskId, {
        status: "failed",
        progress: 100,
        error_message: "المزود أعلن الاكتمال دون روابط نتائج",
      });
      return failedMessage(await getTask(taskId));
    }
    await updateTask(
      taskId,
      { status: "completed", progress: 100, result_urls_json: JSON.stringify(urls) },
      { provider, keyId: key.id, keyLabel: key.label, ok: true, at: new Date().toISOString() }
    );
    return { text: completedMessage(await getTask(taskId), urls) };
  }
  if (r.status === "failed") {
    const err = r.error || "فشل المزود دون رسالة";
    if (KEY_PATTERN_RE.test(err)) {
      const cls = classifyProviderError(undefined, err);
      await recordKeyAttempt(key.id, false, cls, err);
      await updateTask(
        taskId,
        {},
        {
          provider,
          keyId: key.id,
          keyLabel: key.label,
          ok: false,
          errorClass: cls,
          error: err.slice(0, 300),
          at: new Date().toISOString(),
        }
      );
      await failoverRecreate(taskId, def);
      return { text: processingMessage(taskId) };
    }
    await updateTask(taskId, { status: "failed", progress: 100, error_message: sanitizeClientError(err) });
    return failedMessage(await getTask(taskId));
  }
  const pct = estimateProgress(task.type, task.created_at, r.progress);
  await updateTask(taskId, { progress: pct });
  return { text: processingMessage(taskId) };
}

/* ---------- الدمج (خدمة Video Merger v2) ---------- */
export interface MergeArgs {
  urls?: string[];
  task_ids?: string[];
  waitSeconds: number;
  notify?: NotifyFn;
}

/* قفل في الذاكرة: تنفيذ process مرة واحدة فقط لكل مهمة دمج — يمنع التزامن مع get_task */
const processInFlight = new Set<string>();

async function finalizeMergeDone(taskId: string, videoUrl: string | null, expiresAt?: string): Promise<void> {
  const task = await getTask(taskId);
  const paramsObj = task ? safeParse<Record<string, unknown>>(task.params_json, {}) : {};
  const urls = videoUrl ? [videoUrl] : [];
  await updateTask(taskId, {
    status: urls.length ? "completed" : "failed",
    progress: 100,
    result_urls_json: urls.length ? JSON.stringify(urls) : null,
    error_message: urls.length ? null : "انتهى الدمج دون رابط نتيجة",
    params_json: JSON.stringify({ ...paramsObj, ...(expiresAt ? { expiresAt } : {}) }),
  });
}

// إطلاق process خلفيًا وبمرة واحدة فقط (يُستدعى من runMerge وrefreshMergeTask)
export function fireMergeProcess(taskId: string, jobId: string): void {
  if (processInFlight.has(jobId)) return;
  processInFlight.add(jobId);
  const p = (async () => {
    try {
      const r = await merger.mergerProcess(jobId);
      const raw = String(r.status ?? "");
      if (/^(done|completed|complete|success|succeeded|finished)$/i.test(raw)) {
        const url =
          (r.videoUrl ? String(r.videoUrl) : null) || (r.downloadUrl ? String(r.downloadUrl) : null);
        await finalizeMergeDone(taskId, url, r.expiresAt ? String(r.expiresAt) : undefined);
      }
      // 202 processing → الاستعلام اللاحق (نافذة الانتظار أو get_task) يتكفل بالباقي
    } catch (e) {
      // فشل HTTP معلن من الخدمة = فشل نهائي فوري — لا إعادة محاولة
      const msg = e instanceof Error ? e.message : String(e);
      await updateTask(taskId, { status: "failed", progress: 100, error_message: `فشل الدمج: ${msg}` });
    } finally {
      processInFlight.delete(jobId);
    }
  })();
  // على Vercel نُبقي الوعد حيًا بعد إرسال الرد؛ في التطوير المحلي يكمل في الخلفية
  try {
    waitUntil(p);
  } catch {
    /* بيئة غير Vercel */
  }
}

export async function runMerge(args: MergeArgs): Promise<{ text: string; isError?: boolean }> {
  const notify = args.notify ?? noopNotify;
  const failures: string[] = [];
  const resolved: string[] = [];

  // روابط task_ids أولًا ثم urls المباشرة بنفس ترتيبها
  for (const tid of args.task_ids ?? []) {
    const t = await getTask(String(tid));
    const urls = t && t.status === "completed" ? taskUrls(t) : [];
    if (!urls.length) {
      failures.push(
        `- task_id ${tid}: ${t ? `حالتها «${t.status}»` : "غير موجودة"} — يجب أن تكون مهمة مكتملة لديها روابط نتائج.`
      );
    } else {
      resolved.push(...urls);
    }
  }
  resolved.push(...(args.urls ?? []).map(String));

  if (resolved.length < 2) {
    let text = "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.";
    if (failures.length) text += "\n\nتفاصيل المعرّفات غير الصالحة:\n" + failures.join("\n");
    return { text, isError: true };
  }
  if (resolved.length > 10) {
    return { text: "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).", isError: true };
  }
  if (resolved.some((u) => !/^https?:\/\//i.test(u))) {
    return { text: "❌ كل الروابط يجب أن تكون http/https مباشرة وعامة.", isError: true };
  }
  if (!merger.mergerConfigured()) {
    return {
      text: "❌ خدمة الدمج غير مضبوطة على السيرفر (متغير البيئة MERGER_API_BASE مفقود).",
      isError: true,
    };
  }

  const taskId = randomUUID();
  const paramsObj: Record<string, unknown> = {
    urls: resolved,
    wait_seconds: args.waitSeconds,
    processed: false,
  };
  await insertTask({
    id: taskId,
    provider: "merger",
    provider_task_id: null,
    key_id: null,
    model: "video-merger",
    type: "merge",
    prompt: `دمج ${resolved.length} مقاطع`,
    params_json: JSON.stringify(paramsObj),
    status: "pending",
  });

  const job = await merger.mergerCreateJob(resolved).catch(() => null);
  if (!job) {
    // فشل إنشاء مهمة الدمج (شبكة/خدمة) — تبقى processing وتُعاد المحاولة مع كل get_task
    await updateTask(taskId, { status: "processing", error_message: "بانتظار خدمة الدمج…", progress: 0 });
    return { text: processingMessage(taskId) };
  }
  await updateTask(taskId, { provider_task_id: job.jobId, status: "processing", progress: 5 });
  // علّم processed قبل الإطلاق حتى لا يعيد get_task تنفيذه
  await updateTask(taskId, { params_json: JSON.stringify({ ...paramsObj, processed: true }) });
  fireMergeProcess(taskId, job.jobId);

  // نافذة انتظار قصيرة مع بث تقدم كل 3 ثوانٍ وتحديث القاعدة فورًا كل مرة
  const deadline = Date.now() + Math.max(0, args.waitSeconds) * 1000;
  let lastNotifyAt = 0;
  for (;;) {
    const st = await merger.mergerStatus(job.jobId);
    if (st.status === "completed") {
      await finalizeMergeDone(taskId, st.videoUrl, st.expiresAt);
      return { text: completedMessage((await getTask(taskId)), [st.videoUrl as string]) };
    }
    if (st.status === "failed") {
      // أي خطأ HTTP معلن من الخدمة (4xx/5xx بجسم error) = فشل نهائي فوري
      const msg =
        st.error === "not_found_404"
          ? "مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)"
          : `فشل الدمج: ${st.error ?? "خطأ غير معروف من خدمة الدمج"}`;
      await updateTask(taskId, { status: "failed", progress: 100, error_message: msg });
      return failedMessage(await getTask(taskId));
    }
    // أخطاء شبكتنا نحن (status=null) مؤقتة → استمر بالاستعلام حتى انتهاء النافذة
    const pct = Math.max(10, Math.min(95, st.progress || 0));
    await updateTask(taskId, { progress: pct });
    const now = Date.now();
    if (now - lastNotifyAt >= POLL_INTERVAL_MS) {
      lastNotifyAt = now;
      await notify(pct, `جارٍ الدمج… ${pct}%`);
    }
    await sleep(POLL_INTERVAL_MS);
    if (Date.now() >= deadline) return { text: processingMessage(taskId) };
  }
}

async function refreshMergeTask(task: TaskRow): Promise<{ text: string; isError?: boolean }> {
  if (task.status === "completed") return { text: completedMessage(task, taskUrls(task)) };
  if (task.status === "failed") return failedMessage(task);
  const paramsObj = safeParse<Record<string, unknown>>(task.params_json, {});

  // لا يوجد jobId بعد: أعد إنشاء مهمة الدمج لدى الخدمة
  if (!task.provider_task_id) {
    const urls = Array.isArray(paramsObj.urls) ? (paramsObj.urls as string[]) : [];
    if (!merger.mergerConfigured() || urls.length < 2) return { text: processingMessage(task.id) };
    const job = await merger.mergerCreateJob(urls).catch(() => null);
    if (!job) return { text: processingMessage(task.id) };
    await updateTask(task.id, {
      provider_task_id: job.jobId,
      status: "processing",
      params_json: JSON.stringify({ ...paramsObj, processed: true }),
    });
    fireMergeProcess(task.id, job.jobId);
    return { text: processingMessage(task.id) };
  }

  // نفّذ process الآن إن لم يُنفَّذ بعد (قفل الذاكرة يمنع التكرار)
  if (paramsObj.processed !== true) {
    await updateTask(task.id, { params_json: JSON.stringify({ ...paramsObj, processed: true }) });
    fireMergeProcess(task.id, task.provider_task_id);
  }
  const st = await merger.mergerStatus(task.provider_task_id);
  if (st.status === "completed") {
    await finalizeMergeDone(task.id, st.videoUrl, st.expiresAt);
    return { text: completedMessage(await getTask(task.id), [st.videoUrl as string]) };
  }
  if (st.status === "failed") {
    // 404 من الخدمة → فشل نهائي: المهمة حُذفت أو انتهت صلاحيتها بعد 24 ساعة
    const msg =
      st.error === "not_found_404"
        ? "مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)"
        : `فشل الدمج: ${st.error ?? "خطأ غير معروف من خدمة الدمج"}`;
    await updateTask(task.id, { status: "failed", progress: 100, error_message: msg });
    return failedMessage(await getTask(task.id));
  }
  const pct = Math.max(10, Math.min(95, st.progress || 0));
  await updateTask(task.id, { progress: pct });
  return { text: processingMessage(task.id) };
}

/* ---------- list_media ---------- */
export async function listMedia(filters?: {
  type?: string;
  status?: string;
  limit?: number;
}): Promise<{ text: string }> {
  const limit = Math.max(1, Math.min(50, filters?.limit ?? 10));
  const rows = await listRecentTasks(limit, { type: filters?.type, status: filters?.status });
  if (!rows.length) {
    return { text: "لا توجد مهام مخزنة بعد بهذه الفلاتر — ولّد صورة أو فيديو أولًا ثم عد للاسترجاع." };
  }
  const typeLabel: Record<string, string> = { image: "صورة", video: "فيديو", merge: "دمج" };
  const statusLabel: Record<string, string> = {
    completed: "✅ مكتملة",
    failed: "❌ فاشلة",
    pending: "⏳ جارية",
    processing: "⏳ جارية",
  };
  const lines = rows.map((t, i) => {
    const urls = taskUrls(t);
    const base = `${i + 1}. [${typeLabel[t.type] ?? t.type}] ${t.model} — ${
      statusLabel[t.status] ?? t.status
    } — ${t.created_at} — task_id: ${t.id}`;
    return urls.length ? `${base}\n   الرابط: ${urls.join(" | ")}` : base;
  });
  return { text: `آخر المهام المخزنة (${rows.length}):\n\n${lines.join("\n\n")}` };
}
