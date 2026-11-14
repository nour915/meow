// طبقة Turso — عميل libSQL واحد عبر HTTP (متوافق مع Vercel serverless، لا ملفات SQLite محلية).
// المخطط يُنشأ تلقائيًا عند أول وصول (CREATE TABLE IF NOT EXISTS) فلا حاجة لأداة migrations.
import { createClient, type Client, type Row } from "@libsql/client";

export type { Row };

let _client: Client | null = null;

export function getTurso(): Client {
  if (!_client) {
    const url = process.env.TURSO_DATABASE_URL;
    const authToken = process.env.TURSO_AUTH_TOKEN;
    if (!url || !authToken) {
      throw new Error("متغيرات البيئة TURSO_DATABASE_URL و TURSO_AUTH_TOKEN مطلوبة");
    }
    _client = createClient({ url, authToken });
  }
  return _client;
}

const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    provider TEXT,
    provider_task_id TEXT,
    key_id TEXT,
    model TEXT NOT NULL,
    type TEXT NOT NULL,
    prompt TEXT DEFAULT '',
    params_json TEXT DEFAULT '{}',
    status TEXT NOT NULL,
    progress INTEGER DEFAULT 0,
    result_urls_json TEXT,
    error_message TEXT,
    attempts_json TEXT DEFAULT '[]',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    label TEXT DEFAULT '',
    api_key TEXT NOT NULL,
    status TEXT DEFAULT 'active',
    usage_count INTEGER DEFAULT 0,
    success_count INTEGER DEFAULT 0,
    fail_count INTEGER DEFAULT 0,
    last_used_at TEXT,
    last_checked_at TEXT,
    last_error TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`,
];

let schemaPromise: Promise<void> | null = null;

export function ensureSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const db = getTurso();
      for (const sql of SCHEMA_SQL) await db.execute(sql);
    })().catch((err) => {
      // فشل التهيئة لا يُخزَّن مؤقتًا — المحاولة التالية تعيد المحاولة
      schemaPromise = null;
      throw err;
    });
  }
  return schemaPromise;
}

export async function dbHealthy(): Promise<boolean> {
  try {
    await getTurso().execute("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

/* ---------- المهام ---------- */

export type TaskStatus = "pending" | "processing" | "completed" | "failed";
export type TaskType = "image" | "video" | "merge";

export interface Attempt {
  provider: string;
  keyId: string | null;
  keyLabel?: string;
  ok: boolean;
  errorClass?: string;
  error?: string;
  at: string;
}

export interface TaskRow {
  id: string;
  provider: string | null;
  provider_task_id: string | null;
  key_id: string | null;
  model: string;
  type: TaskType;
  prompt: string;
  params_json: string;
  status: TaskStatus;
  progress: number;
  result_urls_json: string | null;
  error_message: string | null;
  attempts_json: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface NewTask {
  id: string;
  provider: string | null;
  provider_task_id: string | null;
  key_id: string | null;
  model: string;
  type: TaskType;
  prompt: string;
  params_json: string;
  status: TaskStatus;
}

function rowToTask(r: Row): TaskRow {
  return {
    id: String(r.id),
    provider: r.provider == null ? null : String(r.provider),
    provider_task_id: r.provider_task_id == null ? null : String(r.provider_task_id),
    key_id: r.key_id == null ? null : String(r.key_id),
    model: String(r.model),
    type: String(r.type) as TaskType,
    prompt: String(r.prompt ?? ""),
    params_json: String(r.params_json ?? "{}"),
    status: String(r.status) as TaskStatus,
    progress: Number(r.progress ?? 0),
    result_urls_json: r.result_urls_json == null ? null : String(r.result_urls_json),
    error_message: r.error_message == null ? null : String(r.error_message),
    attempts_json: String(r.attempts_json ?? "[]"),
    created_at: String(r.created_at ?? ""),
    updated_at: String(r.updated_at ?? ""),
    completed_at: r.completed_at == null ? null : String(r.completed_at),
  };
}

export async function insertTask(t: NewTask): Promise<void> {
  await ensureSchema();
  // تُسجَّل المهمة قبل أي نداء خارجي — حتى لو انقطع الاتصال تبقى قابلة للتتبع
  await getTurso().execute({
    sql: `INSERT INTO tasks (id, provider, provider_task_id, key_id, model, type, prompt, params_json, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [t.id, t.provider, t.provider_task_id, t.key_id, t.model, t.type, t.prompt, t.params_json, t.status],
  });
}

export async function getTask(id: string): Promise<TaskRow | null> {
  await ensureSchema();
  const rs = await getTurso().execute({ sql: "SELECT * FROM tasks WHERE id = ?", args: [id] });
  return rs.rows.length ? rowToTask(rs.rows[0]) : null;
}

export interface TaskPatch {
  provider?: string | null;
  provider_task_id?: string | null;
  key_id?: string | null;
  status?: TaskStatus;
  progress?: number;
  result_urls_json?: string | null;
  error_message?: string | null;
  params_json?: string;
}

// تحديث جزئي يضيف محاولة إلى attempts_json ويضبط completed_at تلقائيًا عند الاكتمال
export async function updateTask(id: string, patch: TaskPatch, appendAttempt?: Attempt): Promise<TaskRow | null> {
  await ensureSchema();
  const allowed: Record<string, string> = {
    provider: "provider",
    provider_task_id: "provider_task_id",
    key_id: "key_id",
    status: "status",
    progress: "progress",
    result_urls_json: "result_urls_json",
    error_message: "error_message",
    params_json: "params_json",
  };
  const sets: string[] = ["updated_at = datetime('now')"];
  const args: (string | number | null)[] = [];
  for (const [k, col] of Object.entries(allowed)) {
    if (k in patch && (patch as Record<string, unknown>)[k] !== undefined) {
      sets.push(`${col} = ?`);
      args.push((patch as Record<string, unknown>)[k] as string | number | null);
    }
  }
  if (patch.status === "completed") {
    sets.push("completed_at = COALESCE(completed_at, datetime('now'))");
  }
  if (appendAttempt) {
    const cur = await getTask(id);
    let attempts: Attempt[] = [];
    if (cur) {
      try {
        attempts = JSON.parse(cur.attempts_json) as Attempt[];
      } catch {
        attempts = [];
      }
    }
    attempts.push(appendAttempt);
    sets.push("attempts_json = ?");
    args.push(JSON.stringify(attempts));
  }
  args.push(id);
  await getTurso().execute({ sql: `UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, args });
  return getTask(id);
}

export async function listRecentTasks(
  limit: number,
  filters?: { type?: string; status?: string }
): Promise<TaskRow[]> {
  await ensureSchema();
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (filters?.type) {
    where.push("type = ?");
    args.push(filters.type);
  }
  if (filters?.status === "processing") {
    // الاعتماد يشمل pending و processing معًا من وجهة نظر العميل
    where.push("status IN ('pending','processing')");
  } else if (filters?.status) {
    where.push("status = ?");
    args.push(filters.status);
  }
  args.push(limit);
  const rs = await getTurso().execute({
    sql: `SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""}
          ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    args,
  });
  return rs.rows.map(rowToTask);
}

export interface TaskStats {
  total: number;
  completed: number;
  failed: number;
  processing: number;
}

export async function taskStats(): Promise<TaskStats> {
  await ensureSchema();
  const rs = await getTurso().execute(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
            COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
            COALESCE(SUM(CASE WHEN status IN ('pending','processing') THEN 1 ELSE 0 END), 0) AS processing
     FROM tasks`
  );
  const r = rs.rows[0];
  return {
    total: Number(r.total ?? 0),
    completed: Number(r.completed ?? 0),
    failed: Number(r.failed ?? 0),
    processing: Number(r.processing ?? 0),
  };
}

export async function deleteTasks(ids: string[]): Promise<void> {
  await ensureSchema();
  for (const id of ids) {
    await getTurso().execute({ sql: "DELETE FROM tasks WHERE id = ?", args: [id] });
  }
}

/* ---------- المفاتيح ---------- */

export interface KeyRow {
  id: string;
  provider: string;
  label: string;
  api_key: string;
  status: string;
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
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

export async function insertKey(
  provider: string,
  apiKey: string,
  label: string
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  await ensureSchema();
  // رفض التكرار لنفس المزود — إضافة عدة مفاتيح مختلفة لنفس المزود مسموحة (هذا جوهر التبديل التسلسلي)
  const dup = await getTurso().execute({
    sql: "SELECT id FROM api_keys WHERE provider = ? AND api_key = ? LIMIT 1",
    args: [provider, apiKey],
  });
  if (dup.rows.length) {
    return { ok: false, error: "هذا المفتاح مضاف مسبقًا لنفس المزود — لا يمكن تكرار المفتاح." };
  }
  const id = crypto.randomUUID();
  await getTurso().execute({
    sql: `INSERT INTO api_keys (id, provider, label, api_key) VALUES (?, ?, ?, ?)`,
    args: [id, provider, label, apiKey],
  });
  return { ok: true, id };
}

export async function listKeys(): Promise<KeyRow[]> {
  await ensureSchema();
  const rs = await getTurso().execute(
    "SELECT * FROM api_keys ORDER BY created_at ASC, id ASC"
  );
  return rs.rows.map(rowToKey);
}

export async function getKeyById(id: string): Promise<KeyRow | null> {
  await ensureSchema();
  const rs = await getTurso().execute({ sql: "SELECT * FROM api_keys WHERE id = ?", args: [id] });
  return rs.rows.length ? rowToKey(rs.rows[0]) : null;
}

// تعطيل/تنشيط يدوي فقط — أما التحويل التلقائي (disabled/exhausted) فيتم عبر recordKeyAttempt
export async function updateKeyStatus(id: string, status: "active" | "disabled"): Promise<KeyRow | null> {
  await ensureSchema();
  await getTurso().execute({
    sql: "UPDATE api_keys SET status = ? WHERE id = ?",
    args: [status, id],
  });
  return getKeyById(id);
}

export async function deleteKey(id: string): Promise<void> {
  await ensureSchema();
  await getTurso().execute({ sql: "DELETE FROM api_keys WHERE id = ?", args: [id] });
}
