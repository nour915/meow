// طبقة Turso (libSQL) — تخزين كل شيء: المهام، أجزاء المصادر، والفيديو الناتج (Blobs).
// كل Blob يُقسَّم إلى صفوف 2MB (حد HTTP في Turso) ويُقرأ تدفقيًا بصفحات من 8 صفوف.
// لا S3 ولا خدمات خارجية. الجداول تُنشأ بـ CREATE TABLE IF NOT EXISTS.
const { createClient } = require("@libsql/client");
const { Readable } = require("stream");
const { loadEnv } = require("./env");

loadEnv();

let _client = null;
function db() {
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

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    status TEXT DEFAULT 'queued',
    progress INTEGER DEFAULT 0,
    expires_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    error TEXT,
    output_size INTEGER,
    output_duration REAL,
    output_resolution TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS sources (
    job_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL,
    url TEXT,
    name TEXT,
    mime TEXT,
    size INTEGER,
    PRIMARY KEY (job_id, seq)
  )`,
  `CREATE TABLE IF NOT EXISTS source_chunks (
    job_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    chunk INTEGER NOT NULL,
    data BLOB,
    PRIMARY KEY (job_id, seq, chunk)
  )`,
  `CREATE TABLE IF NOT EXISTS output_chunks (
    job_id TEXT NOT NULL,
    chunk INTEGER NOT NULL,
    data BLOB,
    PRIMARY KEY (job_id, chunk)
  )`,
];

let schemaPromise = null;
function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      for (const sql of SCHEMA) await db().execute(sql);
    })().catch((e) => {
      schemaPromise = null;
      throw e;
    });
  }
  return schemaPromise;
}

const CHUNK_BYTES = 2 * 1024 * 1024; // صفوف 2MB (حد HTTP في Turso)
const PAGE_ROWS = 8; // صفحات قراءة/كتابة من 8 صفوف

/* ---------- المهام ---------- */

async function insertJob(jobId, expiresAt, status) {
  await db().execute({
    sql: "INSERT INTO jobs (id, expires_at, status) VALUES (?, ?, ?)",
    args: [jobId, expiresAt, status || "queued"],
  });
}

function mapJob(r) {
  return {
    id: String(r.id),
    status: String(r.status || "queued"),
    progress: Number(r.progress || 0),
    expires_at: r.expires_at == null ? null : String(r.expires_at),
    created_at: String(r.created_at || ""),
    error: r.error == null ? null : String(r.error),
    output_size: r.output_size == null ? null : Number(r.output_size),
    output_duration: r.output_duration == null ? null : Number(r.output_duration),
    output_resolution: r.output_resolution == null ? null : String(r.output_resolution),
  };
}

async function getJob(id) {
  const rs = await db().execute({ sql: "SELECT * FROM jobs WHERE id = ?", args: [id] });
  return rs.rows.length ? mapJob(rs.rows[0]) : null;
}

async function updateJob(id, patch) {
  const sets = ["updated_at = datetime('now')"];
  const args = [];
  const cols = {
    status: "status",
    progress: "progress",
    error: "error",
    output_size: "output_size",
    output_duration: "output_duration",
    output_resolution: "output_resolution",
  };
  for (const [k, col] of Object.entries(cols)) {
    if (patch[k] !== undefined) {
      sets.push(`${col} = ?`);
      args.push(patch[k]);
    }
  }
  args.push(id);
  await db().execute({ sql: `UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`, args });
  return getJob(id);
}

// حذف شامل فوري: jobs + sources + source_chunks + output_chunks في batch واحد
async function deleteJobAll(id) {
  await db().batch(
    [
      { sql: "DELETE FROM output_chunks WHERE job_id = ?", args: [id] },
      { sql: "DELETE FROM source_chunks WHERE job_id = ?", args: [id] },
      { sql: "DELETE FROM sources WHERE job_id = ?", args: [id] },
      { sql: "DELETE FROM jobs WHERE id = ?", args: [id] },
    ],
    "write"
  );
}

// التنظيف التلقائي: كل مهمة تنتهي صلاحيتها (24 ساعة) تُحذف بكل صفوفها
async function purgeExpired() {
  const rs = await db().execute("SELECT id FROM jobs WHERE expires_at IS NOT NULL AND expires_at < datetime('now')");
  let deleted = 0;
  for (const r of rs.rows) {
    try {
      await deleteJobAll(String(r.id));
      deleted++;
    } catch {
      /* نكمل مع البقية */
    }
  }
  return deleted;
}

/* ---------- المصادر ---------- */

async function insertSources(jobId, sources) {
  const rows = sources.map((s, i) => ({
    sql: "INSERT INTO sources (job_id, seq, kind, url, name, mime, size) VALUES (?, ?, ?, ?, ?, ?, ?)",
    args: [jobId, i, s.kind, s.url || null, s.name || null, s.mime || null, s.size || 0],
  }));
  if (rows.length) await db().batch(rows, "write");
}

async function listSources(jobId) {
  const rs = await db().execute({
    sql: "SELECT * FROM sources WHERE job_id = ? ORDER BY seq ASC",
    args: [jobId],
  });
  return rs.rows.map((r) => ({
    seq: Number(r.seq),
    kind: String(r.kind),
    url: r.url == null ? null : String(r.url),
    name: r.name == null ? null : String(r.name),
    mime: r.mime == null ? null : String(r.mime),
    size: Number(r.size || 0),
  }));
}

async function getSource(jobId, seq) {
  const rs = await db().execute({
    sql: "SELECT * FROM sources WHERE job_id = ? AND seq = ?",
    args: [jobId, seq],
  });
  return rs.rows.length
    ? { seq: Number(rs.rows[0].seq), kind: String(rs.rows[0].kind), url: rs.rows[0].url ? String(rs.rows[0].url) : null, name: rs.rows[0].name ? String(rs.rows[0].name) : null, size: Number(rs.rows[0].size || 0) }
    : null;
}

/* ---------- Blobs المقسمة ---------- */

// كتابة Buffer إلى صفوف 2MB — بدفعات 8 صفوف لكل طلب HTTP
async function writeBlob(kind, jobId, seq, data) {
  const client = db();
  const rows = [];
  for (let off = 0, i = 0; off < data.length; off += CHUNK_BYTES, i++) {
    const slice = data.subarray(off, Math.min(off + CHUNK_BYTES, data.length));
    rows.push(
      kind === "output"
        ? { sql: "INSERT INTO output_chunks (job_id, chunk, data) VALUES (?, ?, ?)", args: [jobId, i, slice] }
        : { sql: "INSERT INTO source_chunks (job_id, seq, chunk, data) VALUES (?, ?, ?, ?)", args: [jobId, seq, i, slice] }
    );
  }
  for (let i = 0; i < rows.length; i += PAGE_ROWS) {
    await client.batch(rows.slice(i, i + PAGE_ROWS), "write");
  }
}

async function putChunk(jobId, seq, chunk, data) {
  await db().execute({
    sql: "INSERT INTO source_chunks (job_id, seq, chunk, data) VALUES (?, ?, ?, ?) ON CONFLICT(job_id, seq, chunk) DO UPDATE SET data = excluded.data",
    args: [jobId, seq, chunk, data],
  });
}

async function sourceBytesTotal(jobId, seq) {
  const rs = await db().execute({
    sql: "SELECT COALESCE(SUM(length(data)), 0) AS total, COUNT(*) AS n FROM source_chunks WHERE job_id = ? AND seq = ?",
    args: [jobId, seq],
  });
  return { total: Number(rs.rows[0].total || 0), chunks: Number(rs.rows[0].n || 0) };
}

// قراءة تدفقية بتقليم أول/آخر جزء حسب المدى المطلوب (لدعم Range في بث الفيديو)
function readBlobStream(kind, jobId, seq, start, end) {
  const table = kind === "output" ? "output_chunks" : "source_chunks";
  let chunk = start == null ? 0 : Math.floor(start / CHUNK_BYTES);
  const stream = new Readable({
    highWaterMark: 4 * 1024 * 1024,
    async read() {
      try {
        const sql =
          table === "output_chunks"
            ? `SELECT chunk, data FROM output_chunks WHERE job_id = ? AND chunk >= ? ORDER BY chunk ASC LIMIT ${PAGE_ROWS}`
            : `SELECT chunk, data FROM source_chunks WHERE job_id = ? AND seq = ? AND chunk >= ? ORDER BY chunk ASC LIMIT ${PAGE_ROWS}`;
        const args = table === "output_chunks" ? [jobId, chunk] : [jobId, seq, chunk];
        const rs = await db().execute({ sql, args });
        if (!rs.rows.length) {
          this.push(null);
          return;
        }
        for (const row of rs.rows) {
          const idx = Number(row.chunk);
          const chunkStart = idx * CHUNK_BYTES;
          chunk = idx + 1;
          const buf = Buffer.from(row.data);
          let lo = 0;
          let hi = buf.length;
          if (start != null) lo = Math.max(lo, start - chunkStart);
          if (end != null) hi = Math.min(hi, end + 1 - chunkStart);
          if (hi > lo) this.push(buf.subarray(lo, hi));
          if (end != null && chunkStart + buf.length > end) {
            this.push(null);
            return;
          }
        }
      } catch (e) {
        this.destroy(e);
      }
    },
  });
  return stream;
}

module.exports = {
  db,
  ensureSchema,
  insertJob,
  getJob,
  updateJob,
  deleteJobAll,
  purgeExpired,
  insertSources,
  listSources,
  getSource,
  writeBlob,
  putChunk,
  sourceBytesTotal,
  readBlobStream,
  CHUNK_BYTES,
};
