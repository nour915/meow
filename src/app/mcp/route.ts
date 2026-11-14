// خادم MCP على المسار /mcp — نقل Streamable HTTP عبر SDK الرسمي (McpServer + StreamableHTTPServerTransport).
// الجلسات تُحفظ في ذاكرة نسخة الدالة (تبقى حية طوال دفئها على Vercel)، وعند بداية باردة
// مع جلسة غير معروفة نكمل الشفافية بحالة لاش-session حتى لا يتعطل أي عميل.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { webToNode } from "@/lib/mcp/node-adapter";
import { runGeneration, runMerge, refreshTask, listMedia, type NotifyFn } from "@/lib/coordinator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// نوافذ الانتظار حتى 240 ثانية تحتاج مدة دالة طويلة على Vercel
export const maxDuration = 300;

export const SERVER_INFO = { name: "media-generator-mcp", version: "1.2.0" } as const;

export const SERVER_INSTRUCTIONS = `AI media generation server (kie.ai + CometAPI with automatic sequential multi-key failover, plus video merging).
Workflow: call generate_image or generate_video. If the response contains finished URLs, show them to the user.
If it returns a task_id with status PROCESSING, call get_task with that task_id every ~10 seconds until status is completed (show the URL) or failed (explain why).
IMPORTANT: the server automatically switches API keys in strict order on any failure (exhausted balance, invalid key, rate limits) and continues the SAME task under the same task_id — you will never encounter key/balance errors. Never stop or warn the user about keys or balances; just keep polling get_task until the result appears.
To concatenate several finished clips into one video, call merge_videos with 'urls' (direct links) or 'task_ids' (completed video tasks, in merge order); track it with get_task the same way. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.
Use list_media to recall previously generated media from the database.`;

interface SessionEntry {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

const sessions = new Map<string, SessionEntry>();
const MAX_SESSIONS = 200;

function toToolResult(r: { text: string; isError?: boolean }) {
  return {
    content: [{ type: "text" as const, text: r.text }],
    ...(r.isError ? { isError: true } : {}),
  };
}

// بث إشعارات التقدم عندما يزوّد العميل الطلب بـ _meta.progressToken
function makeNotifier(extra: unknown): NotifyFn {
  const meta = (extra as { _meta?: Record<string, unknown> } | undefined)?._meta;
  const token = meta?.progressToken;
  if (token == null) return () => {};
  const send = (extra as { sendNotification: (n: { method: string; params: unknown }) => Promise<void> })
    .sendNotification;
  return async (progress, message) => {
    try {
      await send({
        method: "notifications/progress",
        params: { progressToken: token, progress, total: 100, message },
      });
    } catch {
      /* العميل قد انقطع — نتجاهل بصمت */
    }
  };
}

function registerTools(server: McpServer): void {
  server.registerTool(
    "generate_image",
    {
      title: "Generate Image",
      description:
        "Generate an image with gpt-image-2-6/flare-text-to-image (automatic failover across all active keys). Returns the finished image URL directly if the task completes within the wait window; otherwise returns a task_id — call get_task every ~10 seconds until status is completed, then show the URL and stop.",
      inputSchema: {
        prompt: z.string().min(1).describe("What to draw. Detailed prompts give better results."),
        model: z
          .enum(["gpt-image-2-6/flare-text-to-image", "gpt-image-2.6/flare-text-to-image"])
          .default("gpt-image-2-6/flare-text-to-image"),
        aspect_ratio: z
          .enum(["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21", "3:1", "1:3"])
          .default("auto"),
        resolution: z.enum(["1K", "2K", "4K"]).default("1K"),
        background: z.enum(["auto", "transparent", "opaque"]).default("auto").describe("Only applied at 1K."),
        output_format: z.enum(["png", "jpeg", "webp", "gif"]).default("png"),
        wait_seconds: z.number().int().min(0).max(240).default(90),
      },
    },
    async (args, extra) => {
      const r = await runGeneration({
        type: "image",
        model: args.model,
        prompt: args.prompt,
        params: args as unknown as Record<string, unknown>,
        waitSeconds: args.wait_seconds,
        notify: makeNotifier(extra),
      });
      return toToolResult(r);
    }
  );

  server.registerTool(
    "generate_video",
    {
      title: "Generate Video",
      description:
        "Generate a video with grok-imagine-video-1-5-preview (native synchronized audio — dialogue/effects/music; optional image-to-video). Video takes minutes: short wait with live progress streaming, then a task_id — track it with get_task every ~10 seconds until completed, then show the URL and stop.",
      inputSchema: {
        prompt: z.string().max(4096).describe("Scene description. Dialogue in the prompt is spoken in the video."),
        image_url: z.string().optional().describe("Optional public image URL as the first frame (image-to-video)."),
        model: z
          .enum(["grok-imagine-video-1-5-preview", "grok-imagine-video-1.5-preview"])
          .default("grok-imagine-video-1-5-preview"),
        aspect_ratio: z.enum(["auto", "1:1", "16:9", "9:16", "3:2", "2:3"]).default("auto"),
        resolution: z.enum(["480p", "720p", "1080p"]).default("480p"),
        enable_audio: z.boolean().default(true),
        duration: z.number().int().min(1).max(15).default(8).describe("Duration in seconds."),
        wait_seconds: z.number().int().min(0).max(240).default(25),
      },
    },
    async (args, extra) => {
      const r = await runGeneration({
        type: "video",
        model: args.model,
        prompt: args.prompt,
        params: args as unknown as Record<string, unknown>,
        waitSeconds: args.wait_seconds,
        notify: makeNotifier(extra),
      });
      return toToolResult(r);
    }
  );

  server.registerTool(
    "merge_videos",
    {
      title: "Merge Videos",
      description:
        "Merge several clips into ONE final video in the given order. Pass 'urls' (public direct video links — e.g. links returned by generate_video) or 'task_ids' (completed video generation tasks; their result URLs are resolved from the database in this order — ideal after generating several clips). Merging is usually quick: short wait with progress streaming, then a merge task_id — track it with get_task. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.",
      inputSchema: {
        urls: z
          .array(z.string())
          .min(2, { message: "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة." })
          .max(10, { message: "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى)." })
          .optional()
          .describe("Public direct video URLs (http/https) in merge order — the first clip starts the final video."),
        task_ids: z
          .array(z.string())
          .min(2, { message: "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة." })
          .max(10, { message: "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى)." })
          .optional()
          .describe("Alternative to urls: task_ids of COMPLETED video generation tasks — their result URLs are merged in this order."),
        wait_seconds: z.number().int().min(0).max(240).default(60),
      },
    },
    async (args, extra) => {
      const r = await runMerge({
        urls: args.urls,
        task_ids: args.task_ids,
        waitSeconds: args.wait_seconds,
        notify: makeNotifier(extra),
      });
      return toToolResult(r);
    }
  );

  server.registerTool(
    "get_task",
    {
      title: "Get Task",
      description:
        "Track any task by its id — image/video generation AND merging (reads the database and live-updates from the provider/merging service while in progress). Poll it every ~10 seconds; when completed you will find the result URLs — show them to the user and stop polling.",
      inputSchema: {
        task_id: z.string(),
      },
    },
    async (args) => {
      const r = await refreshTask(args.task_id);
      return toToolResult(r);
    }
  );

  server.registerTool(
    "list_media",
    {
      title: "List Media",
      description:
        "List the latest stored images/videos/merges with their result URLs from the database (no regeneration) — use it to recall previously generated media.",
      inputSchema: {
        type: z.enum(["image", "video", "merge"]).optional(),
        status: z.enum(["completed", "failed", "processing"]).optional(),
        limit: z.number().int().min(1).max(50).default(10),
      },
    },
    async (args) => {
      const r = await listMedia({ type: args.type, status: args.status, limit: args.limit });
      return toToolResult(r);
    }
  );
}

function buildServer(): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });
  registerTools(server);
  return server;
}

async function createSession(): Promise<SessionEntry> {
  const server = buildServer();
  let entry!: SessionEntry;
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    // تشخيص: اطبع المكدس الكامل لأي خطأ داخلي في النقل (onerror خاصية وليست خيارًا في SDK 1.32)
    onsessioninitialized: (id) => {
      // منع تضخم الخريطة في بيئة serverless: احذف الأقدم عند تجاوز الحد
      if (sessions.size >= MAX_SESSIONS) {
        const oldest = sessions.keys().next().value as string | undefined;
        if (oldest) {
          sessions.get(oldest)?.transport.close();
          sessions.delete(oldest);
        }
      }
      sessions.set(id, entry);
    },
    onsessionclosed: (id) => {
      sessions.delete(id);
    },
  });
  entry = { server, transport };
  transport.onerror = (e) => console.error("[MCP transport error]", e);
  await server.connect(transport);
  return entry;
}

function createStateless(): SessionEntry {
  // حالة لاش-session: تُستخدم لاستكمال طلبات عميل جلسته ضاعت بسبب بداية باردة على Vercel
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  const entry: SessionEntry = { server, transport };
  transport.onerror = (e) => console.error("[MCP stateless transport error]", e);
  void server.connect(transport);
  return entry;
}

async function dispatch(entry: SessionEntry, req: Request, parsedBody?: unknown): Promise<Response> {
  const { req: nodeReq, res, responsePromise } = webToNode(req, parsedBody);
  // نبدأ المعالجة دون انتظار اكتمالها — الاستجابة تتدفق فور كتابة الترويسات (SSE حي)
  void entry.transport
    .handleRequest(nodeReq, res, parsedBody)
    .catch(async () => {
      try {
        (res as unknown as { writeHead: (s: number, h: Record<string, string>) => void }).writeHead(500, {
          "Content-Type": "application/json",
        });
      } catch {}
      try {
        (res as unknown as { end: (b: string) => void }).end(
          JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null })
        );
      } catch {}
    });
  return responsePromise;
}

function authOk(req: Request): boolean {
  const token = process.env.MCP_ACCESS_TOKEN;
  if (!token) return true;
  return (req.headers.get("authorization") || "") === `Bearer ${token}`;
}

function jsonError(status: number, message: string): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", error: { code: status === 401 ? -32001 : -32000, message }, id: null }),
    { status, headers: { "Content-Type": "application/json" } }
  );
}

export async function POST(req: Request): Promise<Response> {
  if (!authOk(req)) {
    return jsonError(401, "مطلوب ترويسة Authorization: Bearer <MCP_ACCESS_TOKEN> للوصول إلى /mcp");
  }
  const raw = await req.text();
  let parsedBody: unknown = null;
  try {
    parsedBody = JSON.parse(raw);
  } catch {
    /* يتركه الـ transport يعيد خطأ التحليل */
  }
  const sid = req.headers.get("mcp-session-id");
  const method =
    parsedBody && typeof parsedBody === "object" && !Array.isArray(parsedBody)
      ? (parsedBody as { method?: string }).method
      : undefined;

  // 1) جلسة معروفة → نقل واعٍ بالجلسة
  if (sid && sessions.has(sid)) {
    return dispatch(sessions.get(sid)!, req, parsedBody ?? undefined);
  }
  // 2) تهيئة جديدة أو طلب أول بلا جلسة → جلسة جديدة
  if (method === "initialize" || !sid) {
    const entry = await createSession();
    return dispatch(entry, req, parsedBody ?? undefined);
  }
  // 3) جلسة غير معروفة (بداية باردة على Vercel) → استكمال شفاف بحالة لاش-session
  return dispatch(createStateless(), req, parsedBody ?? undefined);
}

export async function GET(req: Request): Promise<Response> {
  if (!authOk(req)) return jsonError(401, "مطلوب ترويسة Authorization: Bearer <MCP_ACCESS_TOKEN>");
  const sid = req.headers.get("mcp-session-id");
  if (sid && sessions.has(sid)) {
    return dispatch(sessions.get(sid)!, req);
  }
  return jsonError(405, "SSE مستقل يتطلب جلسة نشطة (أرسل initialize أولًا)");
}

export async function DELETE(req: Request): Promise<Response> {
  if (!authOk(req)) return jsonError(401, "مطلوب ترويسة Authorization: Bearer <MCP_ACCESS_TOKEN>");
  const sid = req.headers.get("mcp-session-id");
  if (sid && sessions.has(sid)) {
    return dispatch(sessions.get(sid)!, req);
  }
  return jsonError(404, "لا توجد جلسة بهذا المعرّف");
}
