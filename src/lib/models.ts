// سجل الموديلات — أسماء ثابتة قابلة للتجاوز بمتغيرات البيئة، مع قبول الصيغ البديلة بالنقاط
// (gpt-image-2.6/... ← → gpt-image-2-6/...) وتوحيدها قبل الإرسال للمزود.

export type ProviderId = "kie" | "cometapi";
export type TaskProvider = ProviderId | "merger";
export type MediaType = "image" | "video" | "merge";

export interface ModelDef {
  canonical: string; // الاسم كما يراه عميل MCP
  aliases: string[]; // صيغ بديلة نقبلها ونوحّدها
  type: MediaType;
  providers: ProviderId[]; // من يستطيع خدمته — تُجرَّب مفاتيحهم كلها بالترتيب
  providerModel: Record<ProviderId, string>; // اسم الموديل كما يُرسل لكل مزود
}

const DEFAULT_IMAGE = "gpt-image-2-6/flare-text-to-image";
const DEFAULT_VIDEO = "grok-imagine-video-1-5-preview";

export const IMAGE_MODEL: ModelDef = {
  canonical: process.env.KIE_IMAGE_MODEL || DEFAULT_IMAGE,
  aliases: [DEFAULT_IMAGE, "gpt-image-2.6/flare-text-to-image"],
  type: "image",
  providers: ["kie", "cometapi"],
  providerModel: {
    kie: process.env.KIE_IMAGE_MODEL || DEFAULT_IMAGE,
    cometapi: process.env.COMETAPI_IMAGE_MODEL || "gpt-image-2.6-flare-text-to-image",
  },
};

export const VIDEO_MODEL: ModelDef = {
  canonical: process.env.KIE_VIDEO_MODEL || DEFAULT_VIDEO,
  aliases: [DEFAULT_VIDEO, "grok-imagine-video-1.5-preview"],
  type: "video",
  providers: ["kie", "cometapi"],
  providerModel: {
    kie: process.env.KIE_VIDEO_MODEL || DEFAULT_VIDEO,
    cometapi: process.env.COMETAPI_VIDEO_MODEL || DEFAULT_VIDEO,
  },
};

export const MODELS: ModelDef[] = [IMAGE_MODEL, VIDEO_MODEL];

export function normalizeModel(name: string | undefined): ModelDef | undefined {
  if (!name) return undefined;
  const clean = name.trim().toLowerCase();
  for (const m of MODELS) {
    if (m.canonical.toLowerCase() === clean) return m;
    if (m.aliases.some((a) => a.toLowerCase() === clean)) return m;
  }
  // توحيد الصيغ بالنقاط: gpt-image-2.6 → gpt-image-2-6 و grok-imagine-video-1.5 → grok-imagine-video-1-5
  const dashed = clean.replace(/(\d)\.(\d)/g, "$1-$2");
  for (const m of MODELS) {
    if (m.canonical.toLowerCase() === dashed) return m;
    if (m.aliases.some((a) => a.toLowerCase() === dashed)) return m;
  }
  return undefined;
}
