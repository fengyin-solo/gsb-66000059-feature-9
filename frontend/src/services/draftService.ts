import { getDefaultCodeByLanguage } from '../types';

/**
 * 未提交代码草稿
 * 按「房间 + 题目」维度持久化在浏览器本地，
 * 切换题目 / 返回房间列表 / 网络中断重进后仍可恢复。
 */
export interface CodeDraft {
  /** 房间 ID */
  roomId: string;
  /** 题目 ID */
  problemId: string;
  /** 草稿语言 */
  language: string;
  /** 草稿代码 */
  code: string;
  /** 最后修改时间 (ISO) */
  updatedAt: string;
}

export interface SaveDraftParams {
  roomId: string;
  problemId: string;
  language: string;
  code: string;
  updatedAt?: string;
}

const STORAGE_KEY_PREFIX = 'code_interview_draft_';
/** 模拟持久化层的网络耗时，便于加载/恢复态展示与失败重试 */
const PERSIST_LATENCY_MS = 120;

const storageKey = (roomId: string, problemId: string) =>
  `${STORAGE_KEY_PREFIX}${roomId}__${problemId}`;

/** 判断代码是否与对应语言的初始模板不同（空白改动不算草稿） */
export const isDifferentFromTemplate = (code: string, language: string): boolean => {
  const template = getDefaultCodeByLanguage(language);
  return code.trim() !== '' && code !== template;
};

const normalizeDraft = (value: unknown): CodeDraft | null => {
  if (!value || typeof value !== 'object') return null;
  const draft = value as Partial<CodeDraft>;
  if (
    typeof draft.roomId !== 'string' ||
    typeof draft.problemId !== 'string' ||
    typeof draft.language !== 'string' ||
    typeof draft.code !== 'string' ||
    typeof draft.updatedAt !== 'string'
  ) {
    return null;
  }
  if (!isDifferentFromTemplate(draft.code, draft.language)) return null;
  return {
    roomId: draft.roomId,
    problemId: draft.problemId,
    language: draft.language,
    code: draft.code,
    updatedAt: draft.updatedAt,
  };
};

/**
 * 读取草稿。数据损坏时会清除无效内容并返回 null；
 * 底层存储不可用时抛出异常，调用方可重试。
 */
export async function getDraft(roomId: string, problemId: string): Promise<CodeDraft | null> {
  await delay(PERSIST_LATENCY_MS);
  return getDraftSync(roomId, problemId);
}

/**
 * 保存草稿。与初始模板一致（或为空）时不写入，而是清除已有草稿。
 */
export async function saveDraft(params: SaveDraftParams): Promise<void> {
  await delay(PERSIST_LATENCY_MS);
  saveDraftSync(params);
}

/**
 * 恢复草稿。
 * 草稿不存在、已损坏或内容与模板一致时抛出异常，由调用方提示并支持重试。
 */
export async function restoreDraft(roomId: string, problemId: string): Promise<CodeDraft> {
  await delay(PERSIST_LATENCY_MS);
  const draft = getDraftSync(roomId, problemId);
  if (!draft) {
    throw new Error('草稿不存在或已失效');
  }
  return draft;
}

export async function deleteDraft(roomId: string, problemId: string): Promise<void> {
  await delay(PERSIST_LATENCY_MS);
  deleteDraftSync(roomId, problemId);
}

/* ---------- 同步版本：供页面隐藏/卸载时立即落盘，避免丢失最后修改 ---------- */

export function getDraftSync(roomId: string, problemId: string): CodeDraft | null {
  try {
    const raw = localStorage.getItem(storageKey(roomId, problemId));
    if (!raw) return null;
    const draft = normalizeDraft(JSON.parse(raw));
    if (!draft) {
      // 无效数据（如旧版本残留）不再继续使用
      localStorage.removeItem(storageKey(roomId, problemId));
    }
    return draft;
  } catch (error) {
    // JSON 解析失败视为损坏数据，清理后视为无草稿
    if (error instanceof SyntaxError) {
      try {
        localStorage.removeItem(storageKey(roomId, problemId));
      } catch {
        /* ignore */
      }
      return null;
    }
    throw error instanceof Error ? error : new Error('读取草稿失败');
  }
}

export function saveDraftSync(params: SaveDraftParams): void {
  const { roomId, problemId, language, code } = params;
  if (!isDifferentFromTemplate(code, language)) {
    deleteDraftSync(roomId, problemId);
    return;
  }
  const draft: CodeDraft = {
    roomId,
    problemId,
    language,
    code,
    updatedAt: params.updatedAt || new Date().toISOString(),
  };
  try {
    localStorage.setItem(storageKey(roomId, problemId), JSON.stringify(draft));
  } catch (error) {
    throw error instanceof Error ? error : new Error('保存草稿失败');
  }
}

export function deleteDraftSync(roomId: string, problemId: string): void {
  try {
    localStorage.removeItem(storageKey(roomId, problemId));
  } catch (error) {
    throw error instanceof Error ? error : new Error('删除草稿失败');
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
