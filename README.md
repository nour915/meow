# MCP Media Generator + Video Merger

مشروعان يعملان معًا في مستودع واحد (monorepo):

1. **MCP Media Generator** (الجذر) — خادم MCP على Next.js 16 لتوليد الصور (`gpt-image-2-6/flare-text-to-image`) والفيديو (`grok-imagine-video-1-5-preview` بصوت متزامن أصلي) ودمج المقاطع، عبر **5 أدوات MCP**، مع لوحة إدارة عربية RTL كاملة.
2. **video-merger/** — خدمة دمج فيديو مستقلة (Node.js خالص CommonJS على Vercel Serverless + Turso + ffmpeg) بواجهة عربية داكنة و API عامة للمطورين.

**قواعد جوهرية محفوظة:** لا يُنزَّل أي ملف وسائط على السيرفر (روابط فقط) — المفاتيح تُجرَّب بترتيب إضافتها التسلسلي الصارم مع تبديل فوري تلقائي عند أي خطأ/نفاد رصيد دون توقف — نموذج الذكاء الاصطناعي لا يرى أخطاء المفاتيح أو الرصيد أبدًا — المفاتيح مخفية دائمًا (`maskKey`) — لا أسرار في Git.

---

## بنية المستودع

```
/                        ← مشروع Next.js (MCP Media Generator) — Vercel Root Directory: /
├── src/lib/turso.ts         طبقة Turso + المخطط (tasks, api_keys)
├── src/lib/keys.ts          المفاتيح: الترتيب التسلسلي + تصنيف الأخطاء + maskKey
├── src/lib/models.ts        سجل الموديلات مع الصيغ البديلة (نقاط/شرطات)
├── src/lib/providers/       مزودا kie.ai وCometAPI (نمط Jobs الموحد + images متزامنة)
├── src/lib/coordinator.ts   منسق التوليد والدمج والتبديل التسلسلي
├── src/lib/merger.ts        عميل خدمة الدمج (تحليل دفاعي للحالة)
├── src/app/mcp/route.ts     خادم MCP (SDK الرسمي + Streamable HTTP)
├── src/app/api/             health / keys / tasks
├── src/app/page.tsx         لوحة الإدارة العربية (مدير مفاتيح + مهام + ربط)
└── scripts/test-keys-unit.ts اختبار وحدة تصنيف الأخطاء (20 اختبارًا)

video-merger/            ← خدمة الدمج — Vercel Root Directory: video-merger
├── api/                     jobs / upload / config / cron (Vercel Serverless)
├── lib/                     db (Blobs مقسمة 2MB) + merge (ffmpeg) + env + http
├── public/index.html        الواجهة العربية (سحب وإفلات + إعادة ترتيب + تقدم حي)
├── scripts/                 dev-server (محاكي Vercel) + اختبار وحدات + اختبار HTTP
└── vercel.json              maxDuration 300 + cron يومي للتنظيف
```

---

## 1) إنشاء قاعدة Turso (مجانية)

كلا المشروعين يستخدمان **نفس قاعدة Turso** (الجداول مختلفة فلا تعارض: `tasks/api_keys` للتوليد و`jobs/sources/*_chunks` للدمج).

```bash
# ثبّت CLI ثم سجّل الدخول
curl -sSfL https://get.tur.so/install.sh | bash
turso auth login

# أنشئ القاعدة
turso db create media-generator

# اجلب الرابط والتوكن (بصلاحيات كتابة)
turso db show media-generator --url
turso db tokens create media-generator
```

ستحصل على قيمتين: `TURSO_DATABASE_URL` (تبدأ بـ `libsql://`) و`TURSO_AUTH_TOKEN`.

## 2) التشغيل المحلي

### مشروع MCP (الجذر)

```bash
cp .env.example .env.local          # وضع القيم الحقيقية
bun install                         # أو npm install
bun run dev                         # http://localhost:3000
```

### خدمة الدمج

```bash
cd video-merger
cp .env.example .env                # نفس قيمتي Turso
npm install                         # ينزّل ffmpeg-static وffprobe-static
npm run dev                         # http://localhost:3011
```

> خادم التطوير المحلي للدمج يحاكي Vercel: يحلّل المسارات الديناميكية ويعبئها في `req.query` مثل المنصة تمامًا.

### اختبارات

```bash
# المشروع الرئيسي (يشغّل التطوير أولًا)
bun scripts/test-keys-unit.ts       # 20 اختبارًا لطبقة المفاتيح والتصنيف

# خدمة الدمج
cd video-merger
npm run test:unit                   # 12 اختبارًا: ffmpeg + تخزين Turso + sha256 + Range + حدود
npm run test:http                   # 30 اختبارًا ضد الخادم المحلي: دمج روابط/مختلط/Range 206/404/413/405...
```

---

## 3) النشر على Vercel (خطوة بخطوة)

### أ) ربط المستودع

1. ارفع المستودع إلى GitHub (مفعل مسبقًا).
2. من لوحة Vercel: **Add New → Project** واختر المستودع.

### ب) المشروع الأول — MCP Media Generator

- **Root Directory:** `./` (اتركه فارغًا)
- Framework Preset: يُكتشف تلقائيًا (Next.js)
- أضف متغيرات البيئة (**Settings → Environment Variables**):

| المتغير | القيمة | إلزامي |
|---|---|---|
| `TURSO_DATABASE_URL` | `libsql://<db>-<org>.turso.io` | نعم |
| `TURSO_AUTH_TOKEN` | توكن Turso بكتابة | نعم |
| `MERGER_API_BASE` | رابط مشروع الدمج بعد نشره: `https://<video-merger>.vercel.app` | نعم |
| `MCP_ACCESS_TOKEN` | أي نص عشوائي طويل لحماية `/mcp` بـ Bearer | اختياري |
| `KIE_IMAGE_MODEL` / `KIE_VIDEO_MODEL` / `COMETAPI_IMAGE_MODEL` / `COMETAPI_VIDEO_MODEL` | تجاوز أسماء الموديلات | اختياري |

- Deploy.

### ج) المشروع الثاني — خدمة الدمج

- **Add New → Project** من نفس المستودع مرة أخرى.
- **Root Directory:** `video-merger`
- Framework Preset: Other
- أضف المتغيرين:

| المتغير | القيمة |
|---|---|
| `TURSO_DATABASE_URL` | نفس القيمة أعلاه |
| `TURSO_AUTH_TOKEN` | نفس القيمة أعلاه |

- متغيرات الحدود اختيارية: `MAX_SOURCES=10`, `SOURCE_MAX_MB=200`, `OUTPUT_MAX_MB=150`, `MAX_TOTAL_DURATION_SEC=600`, `FFMPEG_PRESET=medium`.
- Deploy، ثم انسخ رابطه (`https://....vercel.app`) وضعه في `MERGER_API_BASE` بمشروع MCP وأعد النشر.

> ترتيب النشر المقترح: انشر خدمة الدمج أولًا، ثم المشروع الرئيسي.

### د) التحقق بعد النشر

```bash
curl https://<main-app>.vercel.app/api/health
# {"ok":true,"database":"turso-connected","merger":{"healthy":true,...}}

curl https://<main-app>.vercel.app/mcp -X POST \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
```

---

## 4) أدوات MCP الخمس

| الأداة | الوظيفة |
|---|---|
| `generate_image` | توليد صورة (مع `aspect_ratio/resolution/background/output_format`) — تعيد الرابط فورًا إن اكتملت خلال نافذة الانتظار وإلا `task_id` |
| `generate_video` | توليد فيديو بصوت متزامن (image-to-video اختياري، مدة 1–15 ثانية) |
| `merge_videos` | دمج 2–10 مقاطع بالترتيب عبر `urls` أو `task_ids` لمهام مكتملة — الناتج يُحذف بعد ~24 ساعة |
| `get_task` | تتبع أي مهمة (توليد/دمج) — استعلام كل ~10 ثوانٍ حتى الاكتمال |
| `list_media` | استرجاع آخر الوسائط المخزنة بروابطها |

### ربط العملاء (من لوحة الإدارة جاهزًا للنسخ)

- **ChatGPT:** Settings → Connectors → Create → Custom MCP server → ضع `https://<app>.vercel.app/mcp` في Server URL.
- **Claude Desktop** (`claude_desktop_config.json`):
```json
{"mcpServers":{"media-generator":{"type":"http","url":"https://<app>.vercel.app/mcp"}}}
```
- **Cursor / Windsurf / Cline** (`mcp.json`):
```json
{"mcpServers":{"media-generator":{"url":"https://<app>.vercel.app/mcp"}}}
```
- إن ضُبط `MCP_ACCESS_TOKEN` أضف `"headers": {"Authorization": "Bearer <token>"}`.

### اختبار بروتوكول MCP بـ curl

```bash
# 1) تهيئة جلسة
curl -sS -X POST https://<app>/mcp -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
# → خذ mcp-session-id من ترويسة الاستجابة

# 2) قائمة الأدوات
curl -sS -X POST https://<app>/mcp -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' -H 'mcp-session-id: <SID>' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# 3) توليد صورة
curl -sS -X POST https://<app>/mcp -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' -H 'mcp-session-id: <SID>' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"generate_image","arguments":{"prompt":"a red cube"}}}'
```

---

## 5) API خدمة الدمج (عام، بلا تسجيل، CORS مفتوح، أخطاء بصيغة `{"error":"..."}`)

| Method | Endpoint | الوظيفة |
|---|---|---|
| `POST` | `/api/jobs` | إنشاء مهمة: `{"videos":[...]}` أو `{"sources":[{"kind":"url|file",...}]}` → `201` مع `jobId/statusUrl/processUrl/expiresAt` و`uploads[]` للملفات |
| `POST` | `/api/upload?job=&seq=&chunk=` | رفع أجزاء ثنائية ≤4MB (`application/octet-stream`) مع إعادة محاولة ×3 من الواجهة |
| `POST` | `/api/jobs/{id}/process` | تنفيذ الدمج كاملًا (متزامن ~10–15 ثانية) → `{"status":"done","videoUrl","downloadUrl","size","duration","resolution","expiresAt"}` — جارية = `202` |
| `GET` | `/api/jobs/{id}` | الحالة + التقدم 0–100 + الرابط عند الاكتمال |
| `GET` | `/api/jobs/{id}/video` | بث MP4 بدعم Range (206) — `?download=1` للتحميل |
| `DELETE` | `/api/jobs/{id}` | حذف فوري شامل (كل الصفوف في batch واحد) |
| `GET` | `/api/config` | الحدود العامة + version |
| `GET` | `/api/cron` | حذف المهام المنتهية (Cron يومي `0 3 * * *` في vercel.json) |

### أمثلة curl

```bash
BASE=https://<video-merger>.vercel.app

# دمج مقطعين من روابط مباشرة
curl -X POST $BASE/api/jobs -H 'Content-Type: application/json' \
  -d '{"videos":["https://www.w3schools.com/html/mov_bbb.mp4","https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4"]}'

curl -X POST $BASE/api/jobs/JOB_ID/process     # → done + videoUrl
curl -o merged.mp4 "$BASE/api/jobs/JOB_ID/video?download=1"
curl -X DELETE $BASE/api/jobs/JOB_ID           # تنظيف اختياري
```

### جودة الدمج (ثابتة عالية)

- توحيد كل المصادر: `scale + pad` إلى أكبر دقة بين المدخلات (حد أقصى 1920×1080، أبعاد زوجية) + `fps=30` + `setsar=1` + `yuv420p` ثم `concat`.
- مصدر بلا صوت يُعوَّض بمسار صامت `anullsrc` بنفس مدته بدل الفشل.
- الترميز: `libx264 CRF 18` + `AAC 192k/44100Hz` + `+faststart` — MP4 يعمل فورًا على الويب.
- التقدم: `0–40` سحب المصادر، `40–90` ترميز (من `out_time_us`)، `100` اكتمال — يُكتب في القاعدة فورًا.

## 6) الحدود

| الحد | القيمة | المتغير |
|---|---|---|
| أقصى عدد مقاطع | 10 | `MAX_SOURCES` |
| أقصى حجم لكل مصدر | 200MB | `SOURCE_MAX_MB` |
| أقصى حجم للناتج | 150MB | `OUTPUT_MAX_MB` |
| مجموع مدد المقاطع | 600 ثانية | `MAX_TOTAL_DURATION_SEC` |
| حجم جزء الرفع | 4MB (حد طلب Vercel ≈ 4.5MB) | — |
| مدة الاحتفاظ بالمخرجات | 24 ساعة ثم حذف تلقائي (كسول + cron) | — |
| نافذة انتظار الأدوات | 0–240 ثانية (الافتراضي: صور 90 / فيديو 25 / دمج 60) | — |

## 7) ملاحظات الخطة المجانية

- **Vercel Hobby:** `maxDuration` حتى 300 ثانية مع Fluid compute (مضبوط في `vercel.json`)، وحد حجم الطلب ≈ 4.5MB (سبب تقسيم الرفع إلى أجزاء 4MB). الخدمة لا تعتمد على أي ملف محلي دائم — `/tmp` فقط أثناء المعالجة.
- **Turso Free:** مساحة تخزين محدودة (~5GB) — الـ Blobs تستهلك منها، والحذف التلقائي بعد 24 ساعة ينظّفها؛ راقب الاستهلاك من لوحة Turso. حذف المهام فورًا متاح عبر `DELETE /api/jobs/{id}`.
- **kie.ai:** الرصيد يُستهلك لكل توليد — التبديل التسلسلي بين عدة مفاتيح يحميك من التوقف عند نفاد أحدها (أضف عدة مفاتيح من لوحة الإدارة).

## 8) الأمان

- `.env*` مستثنى من Git منذ أول commit — لا أسرار في المستودع. `.env.example` بقيم وهمية فقط.
- المفاتيح تُخزَّن في Turso وتُعرض **مقنّعة دائمًا** (`ABCD123••••••••WXYZ`) ولا يعاد المفتاح الكامل في أي استجابة.
- يمكنك حماية `/mcp` بتوكن Bearer عبر `MCP_ACCESS_TOKEN`.
- **مهم:** إذا سبق أن شاركت مفاتيح (GitHub/Turso/kie) في محادثة أو ملف نصي، **دوّرها (rotate)** وأنشئ توكنات جديدة.
