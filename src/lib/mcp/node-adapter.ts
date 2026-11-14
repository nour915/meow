// محوّل بين Request/Web Response في Next.js App Router وواجهة Node (IncomingMessage/ServerResponse)
// التي تتوقعها حزمة MCP الرسمية. يدعم البث المباشر (SSE) للأحداث أثناء معالجة الأداة،
// ويحاكي حدث close لتنظيف الجلسات عند انقطاع العميل.
import { Readable, Writable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

// هيكل ShellResponse: الواجهة التي نعرضها للـ transport على شكل ServerResponse فعلي
interface ResShell {
  statusCode: number;
  headersSent: boolean;
  writeHead: (status: number, ...rest: unknown[]) => ResShell;
  write: (chunkOrCb?: unknown, ...rest: unknown[]) => boolean;
  end: (chunkOrCb?: unknown, ...rest: unknown[]) => ResShell;
  on: (event: string, cb: () => void) => ResShell;
  once: (event: string, cb: () => void) => ResShell;
  removeListener: (event: string, cb?: () => void) => ResShell;
  emit: (event: string) => boolean;
  setHeader: (name: string, value: string | string[] | number) => ResShell;
  getHeader: (name: string) => string | undefined;
  removeHeader: (name: string) => ResShell;
  hasHeader: (name: string) => boolean;
  getHeaderNames: () => string[];
  flushHeaders: () => void;
  cork: () => void;
  uncork: () => void;
  socket: unknown;
  connection: unknown;
  aborted: boolean;
  finished: boolean;
  writableEnded: boolean;
}

export interface WebToNodeResult {
  req: IncomingMessage;
  res: ServerResponse;
  // تُحل الاستجابة فور كتابة الترويسات حتى يتدفق SSE مباشرة دون انتظار نهاية المعالجة
  responsePromise: Promise<Response>;
}

export function webToNode(webReq: Request, parsedBody?: unknown): WebToNodeResult {
  const url = new URL(webReq.url);
  const headers: Record<string, string> = {};
  webReq.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });

  /* ---- req ---- */
  const req = new Readable({ read() {} }) as unknown as IncomingMessage;
  Object.assign(req, {
    method: webReq.method,
    url: url.pathname + url.search,
    headers,
    // hono/node-server يقرأ rawHeaders عبر .slice() — يجب أن تكون مصفوفة مسطّاة صالحة
    rawHeaders: Object.entries(headers).flatMap(([k, v]) => [k, v]),
    httpVersion: "1.1",
    httpVersionMajor: "1",
    httpVersionMinor: "1",
    trailers: {},
    rawTrailers: [],
    complete: true,
    aborted: false,
    get: (h: string) => headers[h.toLowerCase()] ?? null,
  });
  const fakeSocket = {
    setTimeout: () => {},
    on: () => {},
    removeListener: () => {},
    destroy: () => {},
  };
  (req as unknown as Record<string, unknown>).socket = fakeSocket;
  (req as unknown as Record<string, unknown>).connection = fakeSocket;

  // ضخ الجسم: عند تمرير parsedBody لا يقرأ الـ transport التدفق أصلًا، لكنه يبقى متاحًا
  (async () => {
    try {
      if (parsedBody !== undefined) {
        req.push(Buffer.from(JSON.stringify(parsedBody)));
        req.push(null);
        return;
      }
      if (webReq.body) {
        const reader = webReq.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          req.push(Buffer.from(value));
        }
      }
      req.push(null);
    } catch {
      try {
        req.destroy(new Error("body stream error"));
      } catch {
        /* تجاهل */
      }
    }
  })();

  /* ---- res ---- */
  const closeListeners: Array<() => void> = [];
  const encoder = new TextEncoder();
  let statusCode = 200;
  const resHeaders: Record<string, string> = {};
  let responseResolved = false;
  let resolveResponse!: (r: Response) => void;
  const responsePromise = new Promise<Response>((resolve) => {
    resolveResponse = resolve;
  });
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      // انقطع العميل — نبّه الـ transport عبر close لتنظيف الجلسة/الاشتراكات
      for (const cb of closeListeners) cb();
    },
  });

  const pushChunk = (chunk: unknown) => {
    if (!controller) return;
    try {
      const data =
        typeof chunk === "string" ? encoder.encode(chunk) : new Uint8Array(chunk as Uint8Array);
      controller.enqueue(data);
    } catch {
      /* تم الإلغاء */
    }
  };

  const tryResolve = () => {
    if (responseResolved) return;
    responseResolved = true;
    const out = new Headers();
    for (const [k, v] of Object.entries(resHeaders)) out.set(k, String(v));
    resolveResponse(new Response(stream, { status: statusCode, headers: out }));
  };

  const closeStream = () => {
    try {
      controller?.close();
    } catch {}
  };

  // غلاف Writable مجرّد — الدوال أدناه تتكفل بكتابة البايتات إلى ReadableStream مباشرة
  const res = new Writable({
    write(chunk: unknown, _enc: unknown, cb: (error?: Error | null) => void) {
      pushChunk(chunk);
      cb();
    },
    final(cb: (error?: Error | null) => void) {
      closeStream();
      cb();
    },
    destroy(_error: Error | null, cb: (error?: Error | null) => void) {
      closeStream();
      cb();
    },
  }) as unknown as ResShell;

  Object.assign<ResShell, Partial<ResShell>>(res, {
    statusCode: 200,
    headersSent: false,
    setHeader(name, value) {
      resHeaders[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
      return res;
    },
    getHeader(name) {
      return resHeaders[name.toLowerCase()];
    },
    removeHeader(name) {
      delete resHeaders[name.toLowerCase()];
      return res;
    },
    hasHeader(name) {
      return name.toLowerCase() in resHeaders;
    },
    getHeaderNames() {
      return Object.keys(resHeaders);
    },
    flushHeaders() {
      tryResolve();
    },
    writeHead(status, ...rest) {
      statusCode = status;
      res.statusCode = status;
      for (const arg of rest) {
        if (Array.isArray(arg)) {
          for (let i = 0; i + 1 < arg.length; i += 2) {
            resHeaders[String(arg[i]).toLowerCase()] = String(arg[i + 1]);
          }
        } else if (arg && typeof arg === "object") {
          for (const [k, v] of Object.entries(arg as Record<string, unknown>)) {
            resHeaders[k.toLowerCase()] = String(v);
          }
        }
      }
      res.headersSent = true;
      tryResolve();
      return res;
    },
    write(chunkOrCb, ...rest) {
      const cb = rest.find((x) => typeof x === "function") as (() => void) | undefined;
      if (typeof chunkOrCb === "string" || Buffer.isBuffer(chunkOrCb) || chunkOrCb instanceof Uint8Array) {
        pushChunk(chunkOrCb);
      } else if (typeof chunkOrCb === "function") {
        (chunkOrCb as () => void)();
      }
      res.headersSent = true;
      tryResolve();
      if (cb) cb();
      return true;
    },
    end(chunkOrCb, ...rest) {
      const cb = rest.find((x) => typeof x === "function") as (() => void) | undefined;
      if (typeof chunkOrCb === "string" || Buffer.isBuffer(chunkOrCb) || chunkOrCb instanceof Uint8Array) {
        pushChunk(chunkOrCb);
      }
      res.headersSent = true;
      tryResolve();
      closeStream();
      for (const listener of closeListeners) listener();
      if (cb) cb();
      return res;
    },
    on(event, cb) {
      if (event === "close" || event === "finish") closeListeners.push(cb);
      return res;
    },
    once(event, cb) {
      return res.on(event, cb);
    },
    removeListener() {
      return res;
    },
    emit(event) {
      if (event === "close" || event === "finish") for (const cb of closeListeners) cb();
      return true;
    },
    cork() {},
    uncork() {},
    socket: fakeSocket,
    connection: fakeSocket,
    aborted: false,
    finished: false,
  });

  return { req, res: res as unknown as ServerResponse, responsePromise };
}
