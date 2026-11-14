// اختبار وحدة لطبقة المفاتيح والتصنيف ضد قاعدة Turso الحقيقية
// تشغيل: bun scripts/test-keys-unit.ts
import { classifyProviderError, getKeyPool, recordKeyAttempt } from "../src/lib/keys";
import { insertKey, deleteKey, getKeyById } from "../src/lib/turso";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra?: string) {
  if (cond) {
    passed++;
    console.log(`✓ ${name}`);
  } else {
    failed++;
    console.log(`✗ ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

async function main() {
  /* 1) تصنيف الأخطاء — جدول 4.2 */
  check("402 → exhausted", classifyProviderError(402, "error") === "exhausted");
  check(
    "رسالة نفاد رصيد بحالة 400 → exhausted (نفاد الرصيد قبل فحص 400)",
    classifyProviderError(400, "insufficient balance") === "exhausted"
  );
  check("quota → exhausted", classifyProviderError(undefined, "quota exceeded") === "exhausted");
  check("充值 → exhausted", classifyProviderError(undefined, "please 充值 first") === "exhausted");
  check("401 → disabled", classifyProviderError(401, "x") === "disabled");
  check("403 → disabled", classifyProviderError(403, "x") === "disabled");
  check(
    "invalid api key → disabled",
    classifyProviderError(undefined, "Invalid API key provided") === "disabled"
  );
  check(
    "model not found + 400 → provider",
    classifyProviderError(400, "model not found") === "provider"
  );
  check(
    "model not found + 404 → provider",
    classifyProviderError(404, "unsupported model") === "provider"
  );
  check("400 عام → params", classifyProviderError(400, "bad field") === "params");
  check("422 → params", classifyProviderError(422, "validation") === "params");
  check("429 → temporary", classifyProviderError(429, "rate limit") === "temporary");
  check("500 → temporary", classifyProviderError(500, "internal") === "temporary");
  check("شبكة (0) → temporary", classifyProviderError(0, "network error: timeout") === "temporary");
  check(
    "غير معروف → temporary (لا نوقف أبدًا)",
    classifyProviderError(undefined, "weird error") === "temporary"
  );

  /* 2) مفتاح مستنزف (402): يظهر exhausted ويبقى في القاعدة دون عرقلة التالي */
  const added = await insertKey("kie", "UNITTEST-402-KEY-000000", "اختبار مستنزف");
  check("إضافة مفتاح الاختبار", added.ok);
  if (added.ok) {
    await recordKeyAttempt(added.id, false, "exhausted", "HTTP 402 insufficient balance");
    const k = await getKeyById(added.id);
    check("الحالة صارت exhausted", k?.status === "exhausted");
    check("العدّادات تحدثت", k?.fail_count === 1 && k?.usage_count === 1);
    const pool = await getKeyPool(["kie"]);
    check(
      "المفتاح المستنزف يبقى في القائمة (لا يُستبعد)",
      pool.some((x) => x.id === added.id)
    );
    // مفتاح disabled يُستبعد من القائمة
    await recordKeyAttempt(added.id, false, "disabled", "401");
    const pool2 = await getKeyPool(["kie"]);
    check(
      "المفتاح المعطّل يُستبعد من القائمة",
      !pool2.some((x) => x.id === added.id)
    );
    await deleteKey(added.id);
    console.log("✓ تنظيف مفتاح الاختبار");
  }

  console.log(`\nالنتيجة: ${passed} ناجح، ${failed} فاشل`);
  if (failed > 0) process.exit(1);
  process.exit(0);
}

main().catch((e) => {
  console.error("فشل تشغيل الاختبار:", e);
  process.exit(1);
});
