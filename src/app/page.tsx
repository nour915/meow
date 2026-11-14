"use client";

// لوحة الإدارة العربية RTL — ثلاث بطاقات: مدير المفاتيح، لوحة المهام، ربط السيرفر.
// تُحدَّث المهام تلقائيًا كل ~5 ثوانٍ والصحة والمفاتيح كل ~15 ثانية.
import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";

/* ---------- الأنواع ---------- */
interface HealthData {
  ok: boolean;
  database: string;
  mcpEndpoint: string;
  models: { canonical: string; type: string; providers: string[] }[];
  merger: { base: string | null; healthy: boolean };
  authRequired: boolean;
}

interface KeyData {
  id: string;
  provider: string;
  label: string;
  maskedKey: string;
  status: string;
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_error: string | null;
  created_at: string;
}

interface TaskData {
  id: string;
  type: string;
  model: string;
  status: string;
  progress: number;
  provider: string | null;
  prompt: string;
  result_urls: string[];
  error_message: string | null;
  attempts_count: number;
  created_at: string;
  completed_at: string | null;
}

interface TasksData {
  stats: { total: number; completed: number; failed: number; processing: number };
  tasks: TaskData[];
}

const TOOLS = [
  { name: "generate_image", desc: "توليد صورة من وصف نصي عبر gpt-image-2-6/flare-text-to-image" },
  { name: "generate_video", desc: "توليد فيديو بصوت متزامن أصلي مع image-to-video اختياري" },
  { name: "merge_videos", desc: "دمج عدة مقاطع بالترتيب عبر روابط مباشرة أو task_ids لمهام مكتملة" },
  { name: "get_task", desc: "تتبع أي مهمة (توليد أو دمج) بمعرّفها حتى اكتمالها" },
  { name: "list_media", desc: "استرجاع آخر الوسائط المخزنة بروابطها دون إعادة توليد" },
];

const TYPE_LABEL: Record<string, string> = { image: "صورة", video: "فيديو", merge: "دمج" };
const STATUS_LABEL: Record<string, string> = {
  completed: "مكتملة",
  failed: "فاشلة",
  processing: "جارية",
  pending: "جارية",
};

function statusBadgeClass(status: string): string {
  switch (status) {
    case "completed":
    case "active":
      return "bg-emerald-100 text-emerald-800 border-emerald-200";
    case "failed":
      return "bg-red-100 text-red-800 border-red-200";
    case "exhausted":
      return "bg-amber-100 text-amber-800 border-amber-200";
    default:
      return "bg-zinc-200 text-zinc-700 border-zinc-300";
  }
}

function fmtTime(s: string | null): string {
  if (!s) return "—";
  const d = new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString("ar-EG", { dateStyle: "short", timeStyle: "short" });
}

export default function Dashboard() {
  const [origin, setOrigin] = useState("");
  const [health, setHealth] = useState<HealthData | null>(null);
  const [keys, setKeys] = useState<KeyData[]>([]);
  const [tasks, setTasks] = useState<TasksData | null>(null);

  // نموذج إضافة مفتاح
  const [provider, setProvider] = useState("kie");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [keyMsg, setKeyMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busyKey, setBusyKey] = useState(false);

  // نسخ
  const [copied, setCopied] = useState<string | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const fetchHealth = useCallback(async () => {
    try {
      const r = await fetch("/api/health", { cache: "no-store" });
      setHealth(await r.json());
    } catch {
      /* تجاهل دورة فاشلة */
    }
  }, []);

  const fetchKeys = useCallback(async () => {
    try {
      const r = await fetch("/api/keys", { cache: "no-store" });
      const j = await r.json();
      setKeys(j.keys ?? []);
    } catch {
      /* تجاهل */
    }
  }, []);

  const fetchTasks = useCallback(async () => {
    try {
      const r = await fetch("/api/tasks?limit=20", { cache: "no-store" });
      setTasks(await r.json());
    } catch {
      /* تجاهل */
    }
  }, []);

  useEffect(() => {
    fetchHealth();
    fetchKeys();
    fetchTasks();
    const t1 = setInterval(fetchTasks, 5000); // لوحة المهام تتحدث تلقائيًا كل ~5 ثوانٍ
    const t2 = setInterval(() => {
      fetchHealth();
      fetchKeys();
    }, 15000);
    return () => {
      clearInterval(t1);
      clearInterval(t2);
    };
  }, [fetchHealth, fetchKeys, fetchTasks]);

  async function addKey() {
    setBusyKey(true);
    setKeyMsg(null);
    try {
      const r = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, label, api_key: apiKey }),
      });
      const j = await r.json();
      if (r.ok) {
        setKeyMsg({ ok: true, text: "تمت إضافة المفتاح بنجاح — سيُجرَّب أولًا حسب ترتيب الإضافة." });
        setApiKey("");
        setLabel("");
        fetchKeys();
        fetchHealth();
      } else {
        setKeyMsg({ ok: false, text: j.error || "فشل الإضافة" });
      }
    } catch {
      setKeyMsg({ ok: false, text: "تعذر الاتصال بالسيرفر" });
    } finally {
      setBusyKey(false);
    }
  }

  async function toggleKey(k: KeyData) {
    const next = k.status === "disabled" ? "active" : "disabled";
    await fetch(`/api/keys/${k.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: next }),
    });
    fetchKeys();
  }

  async function removeKey(k: KeyData) {
    if (!window.confirm(`حذف المفتاح ${k.maskedKey}؟`)) return;
    await fetch(`/api/keys/${k.id}`, { method: "DELETE" });
    fetchKeys();
  }

  function copy(text: string, id: string) {
    const done = () => {
      setCopied(id);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(null), 1800);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(done);
    } else {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      done();
    }
  }

  const mcpUrl = origin ? `${origin}/mcp` : "";
  const authHeaders = health?.authRequired
    ? `,\n        "headers": { "Authorization": "Bearer <MCP_ACCESS_TOKEN>" }`
    : "";
  const chatgptJson = `{\n  "mcpServers": {\n    "media-generator": {\n      "url": "${mcpUrl}"${authHeaders}\n    }\n  }\n}`;
  const claudeJson = `{\n  "mcpServers": {\n    "media-generator": {\n      "type": "http",\n      "url": "${mcpUrl}"${authHeaders}\n    }\n  }\n}`;
  const cursorJson = chatgptJson;

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b bg-white">
        <div className="mx-auto max-w-6xl px-4 py-5 flex flex-wrap items-center gap-3">
          <div className="flex-1 min-w-[240px]">
            <h1 className="text-xl font-extrabold">MCP Media Generator</h1>
            <p className="text-sm text-zinc-500">
              خادم MCP لتوليد الصور والفيديو بالذكاء الاصطناعي ودمج المقاطع — مع تبديل مفاتيح تسلسلي تلقائي
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              className={`border ${health?.ok ? "bg-emerald-100 text-emerald-800 border-emerald-200" : "bg-red-100 text-red-800 border-red-200"}`}
            >
              <span
                className={`inline-block w-2 h-2 rounded-full me-1.5 ${health?.ok ? "bg-emerald-500" : "bg-red-500"}`}
              />
              {health?.ok ? "Turso متصل" : "غير متصل"}
            </Badge>
            <Badge
              className={`border ${health?.merger?.healthy ? "bg-emerald-100 text-emerald-800 border-emerald-200" : "bg-amber-100 text-amber-800 border-amber-200"}`}
            >
              خدمة الدمج: {health?.merger?.healthy ? "جاهزة" : "غير متاحة"}
            </Badge>
            {health?.authRequired ? (
              <Badge className="bg-zinc-200 text-zinc-700 border border-zinc-300">محمي بـ Bearer token</Badge>
            ) : null}
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 space-y-6">
        {/* أ) مدير المفاتيح */}
        <Card>
          <CardHeader>
            <CardTitle>مدير المفاتيح</CardTitle>
            <CardDescription>
              أضف عدة مفاتيح لكل مزود — التجربة تسلسلية (أول مفتاح ثم التالي ثم التالي) مع تبديل فوري تلقائي
              عند أي خطأ أو نفاد رصيد دون توقف.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-col md:flex-row gap-2">
              <Select value={provider} onValueChange={setProvider}>
                <SelectTrigger className="md:w-44">
                  <SelectValue placeholder="المزود" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="kie">kie.ai</SelectItem>
                  <SelectItem value="cometapi">CometAPI</SelectItem>
                </SelectContent>
              </Select>
              <Input
                placeholder="تسمية اختيارية (مثال: الحساب الأساسي)"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                className="md:w-64"
              />
              <Input
                placeholder="الصق مفتاح API هنا"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className="flex-1 font-mono"
                dir="ltr"
              />
              <Button onClick={addKey} disabled={busyKey || !apiKey.trim()}>
                {busyKey ? "جارٍ الإضافة…" : "إضافة المفتاح"}
              </Button>
            </div>
            {keyMsg ? (
              <p className={`text-sm ${keyMsg.ok ? "text-emerald-700" : "text-red-700"}`}>{keyMsg.text}</p>
            ) : null}

            <div className="max-h-96 overflow-y-auto space-y-2 rounded-md border p-2">
              {keys.length === 0 ? (
                <p className="text-sm text-zinc-500 p-3">لا توجد مفاتيح بعد — أضف أول مفتاح من النموذج أعلاه.</p>
              ) : (
                keys.map((k) => (
                  <div
                    key={k.id}
                    className="flex flex-col md:flex-row md:items-center gap-2 md:gap-3 rounded-md border bg-white p-3"
                  >
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <Badge variant="outline" className="font-mono text-xs" dir="ltr">
                        {k.maskedKey}
                      </Badge>
                      <Badge variant="secondary" className="text-xs">
                        {k.provider === "kie" ? "kie.ai" : "CometAPI"}
                      </Badge>
                      <Badge className={`border text-xs ${statusBadgeClass(k.status)}`}>
                        {k.status === "active" ? "نشط" : k.status === "exhausted" ? "مستنزف الرصيد" : "معطّل"}
                      </Badge>
                      {k.label ? <span className="text-xs text-zinc-500 truncate">{k.label}</span> : null}
                    </div>
                    <div className="text-xs text-zinc-600 whitespace-nowrap" dir="rtl">
                      استخدام: {k.usage_count} — نجاح: {k.success_count} — فشل: {k.fail_count}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Button variant="outline" size="sm" onClick={() => toggleKey(k)}>
                        {k.status === "disabled" ? "تنشيط" : "تعطيل"}
                      </Button>
                      <Button variant="destructive" size="sm" onClick={() => removeKey(k)}>
                        حذف
                      </Button>
                    </div>
                    {k.last_error ? (
                      <p className="text-xs text-red-600 md:col-span-4 truncate" dir="auto" title={k.last_error}>
                        آخر خطأ: {k.last_error}
                      </p>
                    ) : null}
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>

        {/* ب) لوحة المهام */}
        <Card>
          <CardHeader>
            <CardTitle>لوحة المهام</CardTitle>
            <CardDescription>تتحدث تلقائيًا كل ~5 ثوانٍ</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                { label: "إجمالي", value: tasks?.stats.total ?? 0, cls: "bg-zinc-100 text-zinc-800" },
                { label: "مكتملة", value: tasks?.stats.completed ?? 0, cls: "bg-emerald-50 text-emerald-800" },
                { label: "فاشلة", value: tasks?.stats.failed ?? 0, cls: "bg-red-50 text-red-800" },
                { label: "جارية", value: tasks?.stats.processing ?? 0, cls: "bg-amber-50 text-amber-800" },
              ].map((s) => (
                <div key={s.label} className={`rounded-lg border p-3 text-center ${s.cls}`}>
                  <div className="text-2xl font-extrabold">{s.value}</div>
                  <div className="text-xs">{s.label}</div>
                </div>
              ))}
            </div>

            <div className="max-h-96 overflow-y-auto space-y-2 rounded-md border p-2">
              {!tasks || tasks.tasks.length === 0 ? (
                <p className="text-sm text-zinc-500 p-3">
                  لا توجد مهام بعد — ستظهر هنا كل عمليات التوليد والدمج فور بدئها.
                </p>
              ) : (
                tasks.tasks.map((t) => (
                  <div key={t.id} className="rounded-md border bg-white p-3 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="secondary" className="text-xs">
                        {TYPE_LABEL[t.type] ?? t.type}
                      </Badge>
                      <Badge className={`border text-xs ${statusBadgeClass(t.status)}`}>
                        {STATUS_LABEL[t.status] ?? t.status}
                      </Badge>
                      <span className="font-mono text-xs text-zinc-500" dir="ltr">
                        {t.model}
                      </span>
                      <span className="text-xs text-zinc-400">{fmtTime(t.created_at)}</span>
                      {t.attempts_count > 1 ? (
                        <Badge variant="outline" className="text-xs">
                          المحاولات: {t.attempts_count}
                        </Badge>
                      ) : null}
                    </div>
                    {t.prompt ? (
                      <p className="text-sm text-zinc-600 line-clamp-2" title={t.prompt}>
                        {t.prompt}
                      </p>
                    ) : null}
                    {t.status === "processing" || t.status === "pending" ? (
                      <div className="flex items-center gap-2">
                        <Progress value={t.progress} className="h-2" />
                        <span className="text-xs text-zinc-500 w-10 text-center">{t.progress}%</span>
                      </div>
                    ) : null}
                    {t.status === "failed" && t.error_message ? (
                      <p className="text-xs text-red-600" dir="auto">
                        {t.error_message}
                      </p>
                    ) : null}
                    {t.result_urls.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5">
                        {t.result_urls.map((u, i) => (
                          <a key={i} href={u} target="_blank" rel="noreferrer">
                            <Button variant="outline" size="sm" className="text-xs">
                              فتح الرابط {t.result_urls.length > 1 ? `(${i + 1})` : ""}
                            </Button>
                          </a>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>

        {/* ج) ربط السيرفر */}
        <Card>
          <CardHeader>
            <CardTitle>ربط السيرفر</CardTitle>
            <CardDescription>
              انسخ الإعداد الجاهز لأي عميل MCP — نفس الرابط يعمل مع الجميع
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-2 items-center">
              <Input value={mcpUrl} readOnly dir="ltr" className="font-mono flex-1" />
              <Button variant="outline" onClick={() => copy(mcpUrl, "url")}>
                {copied === "url" ? "تم النسخ" : "نسخ"}
              </Button>
            </div>

            <Tabs defaultValue="chatgpt">
              <TabsList>
                <TabsTrigger value="chatgpt">ChatGPT / GPT Agents</TabsTrigger>
                <TabsTrigger value="claude">Claude Desktop</TabsTrigger>
                <TabsTrigger value="cursor">Cursor / Windsurf / Cline</TabsTrigger>
              </TabsList>
              <TabsContent value="chatgpt" className="space-y-2">
                <p className="text-xs text-zinc-500">
                  في ChatGPT: Settings ← Connectors ← Create ← Custom MCP server وضع الرابط في «Server URL».
                </p>
                <pre className="rounded-md bg-zinc-900 text-zinc-100 p-3 text-xs overflow-x-auto" dir="ltr">
                  {chatgptJson}
                </pre>
                <Button variant="outline" size="sm" onClick={() => copy(chatgptJson, "chatgpt")}>
                  {copied === "chatgpt" ? "تم النسخ" : "نسخ JSON"}
                </Button>
              </TabsContent>
              <TabsContent value="claude" className="space-y-2">
                <p className="text-xs text-zinc-500">
                  ضعه في ملف claude_desktop_config.json ثم أعد تشغيل التطبيق.
                </p>
                <pre className="rounded-md bg-zinc-900 text-zinc-100 p-3 text-xs overflow-x-auto" dir="ltr">
                  {claudeJson}
                </pre>
                <Button variant="outline" size="sm" onClick={() => copy(claudeJson, "claude")}>
                  {copied === "claude" ? "تم النسخ" : "نسخ JSON"}
                </Button>
              </TabsContent>
              <TabsContent value="cursor" className="space-y-2">
                <p className="text-xs text-zinc-500">نفس صيغة mcp.json — ضعها في إعدادات MCP للمحرر.</p>
                <pre className="rounded-md bg-zinc-900 text-zinc-100 p-3 text-xs overflow-x-auto" dir="ltr">
                  {cursorJson}
                </pre>
                <Button variant="outline" size="sm" onClick={() => copy(cursorJson, "cursor")}>
                  {copied === "cursor" ? "تم النسخ" : "نسخ JSON"}
                </Button>
              </TabsContent>
            </Tabs>

            <div className="flex flex-wrap gap-2">
              {TOOLS.map((t) => (
                <div
                  key={t.name}
                  className="rounded-full border bg-zinc-50 px-3 py-1.5 text-xs max-w-full"
                  title={t.desc}
                >
                  <span className="font-mono font-bold" dir="ltr">
                    {t.name}
                  </span>
                  <span className="text-zinc-500"> — {t.desc}</span>
                </div>
              ))}
            </div>

            <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              الفيديو يحتاج دقائق: يعيد السيرفر task_id فورًا، ويتابَع تلقائيًا بـ get_task كل 10 ثوانٍ — وعند
              اكتمال المهمة يُعرض الرابط في الدردشة ويتوقف. أثناء الانتظار يُبَث تقدم حي (Progress notifications)
              حتى لا تنقطع العملية.
            </div>

            {health?.models?.length ? (
              <div className="text-xs text-zinc-500 space-y-1">
                <p className="font-semibold text-zinc-700">الموديلات المدمجة:</p>
                {health.models.map((m) => (
                  <p key={m.canonical} className="font-mono" dir="ltr">
                    {m.canonical} ({m.type} — {m.providers.join(" + ")})
                  </p>
                ))}
              </div>
            ) : null}
          </CardContent>
        </Card>
      </main>

      <footer className="border-t bg-white">
        <div className="mx-auto max-w-6xl px-4 py-3 text-xs text-zinc-400">
          MCP Media Generator — روابط فقط ولا تنزيل أي وسائط على السيرفر — المفاتيح مخفية دائمًا في كل
          الاستجابات.
        </div>
      </footer>
    </div>
  );
}
