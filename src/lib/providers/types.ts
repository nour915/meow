// تعريف موحد لمزودي التوليد. أي خطأ يُرمى كـ ProviderError ليُصنَّف في طبقة المفاتيح.
import type { ProviderId } from "../models";
import { kieAdapter } from "./kie";
import { cometapiAdapter } from "./cometapi";

export class ProviderError extends Error {
  constructor(
    public status: number, // حالة HTTP أو 0 لأخطاء الشبكة/المهلة
    message: string
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface CheckResult {
  status: "processing" | "completed" | "failed";
  urls?: string[];
  error?: string;
  progress?: number;
}

export interface ProviderAdapter {
  // مهمة غير متزامنة (فيديو، وبعض الصور): تعيد providerTaskId
  createTask(key: string, model: string, input: Record<string, unknown>): Promise<{ providerTaskId: string }>;
  // صور متزامنة إن كان المزود يدعمها (CometAPI تعيد النتيجة فورًا)
  createImageSync?(key: string, input: Record<string, unknown>): Promise<{ urls: string[] }>;
  // استعلام حالة مهمة جارية
  checkTask(key: string, providerTaskId: string): Promise<CheckResult>;
}

export const ADAPTERS: Record<ProviderId, ProviderAdapter> = {
  kie: kieAdapter,
  cometapi: cometapiAdapter,
};
