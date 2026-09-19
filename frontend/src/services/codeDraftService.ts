import { getDefaultCodeByLanguage } from '../types';

/**
 * 未提交代码的本地草稿。
 * 草稿按 用户 + 题目 维度隔离，随代码编辑自动保存，
 * 在提交成功或主动放弃后清理。
 */
export interface CodeDraft {
  problemId: string;
  userId: string;
  code: string;
  language: string;
  savedAt: string;
}

export interface DraftDiffStats {
  /** 相对初始模板新增的行数 */
  added: number;
  /** 相对初始模板删除的行数 */
  removed: number;
  /** 变更总行数（added + removed） */
  changedLines: number;
  /** 初始模板的行数 */
  templateLines: number;
  /** 草稿的行数 */
  draftLines: number;
}

interface DraftStorageShape {
  version: number;
  drafts: Record<string, CodeDraft>;
}

const STORAGE_PREFIX = 'code-interview:drafts:';
const STORAGE_VERSION = 1;
/** 超过该行数后退化为按行对比，避免 LCS 的 O(n*m) 开销过大 */
const LCS_LINE_LIMIT = 1500;

function getStorage(): Storage {
  if (typeof window === 'undefined' || !window.localStorage) {
    throw new Error('当前环境不支持本地草稿存储');
  }
  return window.localStorage;
}

function storageKey(userId: string): string {
  return `${STORAGE_PREFIX}${userId}`;
}

function readStorage(userId: string): DraftStorageShape {
  const storage = getStorage();
  const raw = storage.getItem(storageKey(userId));
  if (!raw) {
    return { version: STORAGE_VERSION, drafts: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('草稿数据已损坏，读取失败');
  }
  const shape = parsed as Partial<DraftStorageShape>;
  if (!shape || typeof shape !== 'object' || !shape.drafts || typeof shape.drafts !== 'object') {
    throw new Error('草稿数据格式无效，读取失败');
  }
  return { version: STORAGE_VERSION, drafts: shape.drafts as Record<string, CodeDraft> };
}

function writeStorage(userId: string, data: DraftStorageShape): void {
  getStorage().setItem(storageKey(userId), JSON.stringify(data));
}

/** 判断草稿内容是否为有效的可恢复草稿（字段完整、代码非空且与初始模板不同） */
export function isRecoverableDraft(draft: unknown): draft is CodeDraft {
  if (!draft || typeof draft !== 'object') return false;
  const d = draft as Partial<CodeDraft>;
  if (typeof d.problemId !== 'string' || typeof d.userId !== 'string') return false;
  if (typeof d.code !== 'string' || typeof d.language !== 'string') return false;
  if (typeof d.savedAt !== 'string' || isNaN(new Date(d.savedAt).getTime())) return false;
  if (d.code.trim() === '') return false;
  return d.code !== getDefaultCodeByLanguage(d.language);
}

/**
 * 保存（或更新）一道题目的未提交草稿。
 * 代码为空或与该语言的初始模板一致时不产生草稿。
 * 存储失败（如隐私模式、配额已满）时抛出异常，由调用方提示重试。
 */
export function saveDraft(draft: CodeDraft): void {
  if (!isRecoverableDraft(draft)) return;
  const data = readStorage(draft.userId);
  data.drafts[draft.problemId] = { ...draft };
  writeStorage(draft.userId, data);
}

/**
 * 读取指定题目的草稿；不存在时返回 null。
 * 存储不可用或数据损坏时抛出异常，调用方可提示重试。
 */
export function getDraft(userId: string, problemId: string): CodeDraft | null {
  const data = readStorage(userId);
  return data.drafts[problemId] ? { ...data.drafts[problemId] } : null;
}

/** 清理指定题目的草稿；清理失败时抛出异常，调用方可提示重试。 */
export function removeDraft(userId: string, problemId: string): void {
  const data = readStorage(userId);
  if (!data.drafts[problemId]) return;
  delete data.drafts[problemId];
  writeStorage(userId, data);
}

function simpleLineStats(templateLines: string[], draftLines: string[]): DraftDiffStats {
  const minLen = Math.min(templateLines.length, draftLines.length);
  let added = 0;
  let removed = 0;
  for (let i = 0; i < minLen; i++) {
    if (templateLines[i] !== draftLines[i]) {
      added++;
      removed++;
    }
  }
  if (draftLines.length > templateLines.length) {
    added += draftLines.length - templateLines.length;
  } else if (templateLines.length > draftLines.length) {
    removed += templateLines.length - draftLines.length;
  }
  return {
    added,
    removed,
    changedLines: added + removed,
    templateLines: templateLines.length,
    draftLines: draftLines.length,
  };
}

/**
 * 基于 LCS 计算草稿相对初始模板的差异概况（新增/删除行数）。
 * 大文件退化为按行对比，保证浏览器端的性能表现。
 */
export function computeDraftDiff(draft: CodeDraft): DraftDiffStats {
  const templateLines = getDefaultCodeByLanguage(draft.language).split('\n');
  const draftLines = draft.code.split('\n');

  if (templateLines.length > LCS_LINE_LIMIT || draftLines.length > LCS_LINE_LIMIT) {
    return simpleLineStats(templateLines, draftLines);
  }

  const n = templateLines.length;
  const m = draftLines.length;
  const width = m + 1;
  const dp = new Uint32Array((n + 1) * width);

  for (let i = 1; i <= n; i++) {
    const rowOffset = i * width;
    const prevOffset = (i - 1) * width;
    for (let j = 1; j <= m; j++) {
      if (templateLines[i - 1] === draftLines[j - 1]) {
        dp[rowOffset + j] = dp[prevOffset + j - 1] + 1;
      } else {
        dp[rowOffset + j] = Math.max(dp[prevOffset + j], dp[rowOffset + j - 1]);
      }
    }
  }

  let matched = 0;
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (templateLines[i - 1] === draftLines[j - 1]) {
      matched++;
      i--;
      j--;
    } else if (dp[(i - 1) * width + j] >= dp[i * width + j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  return {
    added: m - matched,
    removed: n - matched,
    changedLines: m + n - 2 * matched,
    templateLines: n,
    draftLines: m,
  };
}

/** 草稿的绝对保存时间，用于恢复弹窗展示。 */
export function formatDraftTime(iso: string): string {
  const date = new Date(iso);
  if (isNaN(date.getTime())) return iso;
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}
