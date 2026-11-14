// طبقة المفاتيح — قلب سياسة التبديل التسلسلي الصارم.
// التجربة تسلسلية بترتيب الإضافة (created_at ASC, id ASC) — ليست round-robin وليست «الأقل استخدامًا أولًا».
import { getTurso, ensureSchema, type KeyRow, type Row } from "./turso";
import type { ProviderId } from "./models";

export type ErrorClass = "disabled" | "exhausted" | "provider" | "params" | "temporary";

// إخفاء المفتاح إلزامي في كل الاستجابات والسجلات — لا يُعاد المفتاح الكامل أبدًا
export function maskKey(key: string): string {
  if (key.length <= 10) return key.slice(0, 3) + "••••";
  return key.slice(0, 7) + "••••••••" + key.slice(-4);
}

const EXHAUSTED_RE = /insufficient|quota|balance|credit|out of credits|exhausted|充值/i;
const DISABLED_RE = /invalid api key|unauthorized|forbidden|authentication/i;

/* تصنيف موحد لأخطاء المزودين (جدول 4.2 في المواصفة):
   - نفاد الرصيد يُفحص قبل 400 لأن بعض المزودين يرسله بحالة HTTP 400.
   - غير المعروف يُعامل temporary: ننتقل للمفتاح التالي ولا نتوقف أبدًا. */
export function classifyProviderError(status: number | undefined, message: string): ErrorClass {
  if (status === 402 || EXHAUSTED_RE.test(message)) return "exhausted";
  if (status === 401 || status === 403 || DISABLED_RE.test(message)) return "disabled";
  if (/model not found|unsupported model/i.test(message) && (status === 400 || status === 404 || status === 422)) {
    return "provider";
  }
  if (status === 400 || status === 422) return "params";
  // 429 و 5xx وأخطاء الشبكة والمهلة وغير المصنف
  return "temporary";
}

// تجلب كل المفاتيح غير المعطّلة لهذه المزودات بالترتيب الصارم.
// المفتاح المستنزف (exhausted) يبقى في القائمة ولا يُستبعد — الاستثناء الوحيد التعطيل اليدوي (disabled).
export async function getKeyPool(providers: ProviderId[]): Promise<KeyRow[]> {
  await ensureSchema();
  const placeholders = providers.map(() => "?").join(", ");
  const rs = await getTurso().execute({
    sql: `SELECT * FROM api_keys
          WHERE status != 'disabled' AND provider IN (${placeholders})
          ORDER BY created_at ASC, id ASC`,
    args: [...providers],
  });
  return rs.rows.map(rowToKey);
}

function rowToKey(r: Row): KeyRow {
  return {
    id: String(r.id),
    provider: String(r.provider),
    label: String(r.label ?? ""),
    api_key: String(r.api_key),
    status: String(r.status ?? "active"),
    usage_count: Number(r.usage_count ?? 0),
    success_count: Number(r.success_count ?? 0),
    fail_count: Number(r.fail_count ?? 0),
    last_used_at: r.last_used_at == null ? null : String(r.last_used_at),
    last_checked_at: r.last_checked_at == null ? null : String(r.last_checked_at),
    last_error: r.last_error == null ? null : String(r.last_error),
    created_at: String(r.created_at ?? ""),
  };
}

// تحديث عدّادات المفتاح بعد كل محاولة (نجاح أو فشل) مع التحويل التلقائي للحالة:
// 401/403 → disabled (مرفوض)، 402/نفاد → exhausted (يبقى في القاعدة دون عرقلة التالي).
export async function recordKeyAttempt(
  keyId: string,
  ok: boolean,
  errorClass: ErrorClass | null,
  errorMessage: string | null
): Promise<void> {
  await ensureSchema();
  const sets = [
    "usage_count = usage_count + 1",
    "last_used_at = datetime('now')",
    "last_checked_at = datetime('now')",
  ];
  const args: (string | number | null)[] = [];
  if (ok) {
    sets.push("success_count = success_count + 1", "last_error = NULL");
  } else {
    sets.push("fail_count = fail_count + 1", "last_error = ?");
    args.push(errorMessage ?? "unknown");
    if (errorClass === "disabled") sets.push("status = 'disabled'");
    if (errorClass === "exhausted") sets.push("status = 'exhausted'");
  }
  args.push(keyId);
  await getTurso().execute({ sql: `UPDATE api_keys SET ${sets.join(", ")} WHERE id = ?`, args });
}
