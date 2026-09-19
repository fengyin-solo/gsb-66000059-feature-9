export interface DiffStats {
  /** 新增行数 */
  added: number;
  /** 删除行数 */
  removed: number;
  /** 变更总行数（新增 + 删除） */
  total: number;
  /** 原始模板行数 */
  originalLines: number;
  /** 当前代码行数 */
  currentLines: number;
}

export type DiffLineType = 'added' | 'removed' | 'unchanged';

export interface DiffLine {
  type: DiffLineType;
  text: string;
  /** 在原文件中的行号（删除/上下文行） */
  oldLineNumber?: number;
  /** 在新文件中的行号（新增/上下文行） */
  newLineNumber?: number;
}

/**
 * 基于 LCS 的行级差异概况。
 * 两侧行数乘积过大时退化为逐行对比，避免长代码下的内存压力。
 */
export function computeLineDiff(original: string, current: string): DiffLine[] {
  const oldLines = original.split('\n');
  const newLines = current.split('\n');

  if (oldLines.length * newLines.length > 250000) {
    return naiveDiff(oldLines, newLines);
  }

  const m = oldLines.length;
  const n = newLines.length;

  // LCS 长度表
  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) {
        lcs[i][j] = lcs[i + 1][j + 1] + 1;
      } else {
        lcs[i][j] = Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
  }

  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  let oldNo = 0;
  let newNo = 0;

  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      oldNo += 1;
      newNo += 1;
      lines.push({ type: 'unchanged', text: newLines[j], oldLineNumber: oldNo, newLineNumber: newNo });
      i += 1;
      j += 1;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      oldNo += 1;
      lines.push({ type: 'removed', text: oldLines[i], oldLineNumber: oldNo });
      i += 1;
    } else {
      newNo += 1;
      lines.push({ type: 'added', text: newLines[j], newLineNumber: newNo });
      j += 1;
    }
  }
  while (i < m) {
    oldNo += 1;
    lines.push({ type: 'removed', text: oldLines[i], oldLineNumber: oldNo });
    i += 1;
  }
  while (j < n) {
    newNo += 1;
    lines.push({ type: 'added', text: newLines[j], newLineNumber: newNo });
    j += 1;
  }

  return lines;
}

function naiveDiff(oldLines: string[], newLines: string[]): DiffLine[] {
  const lines: DiffLine[] = [];
  const minLen = Math.min(oldLines.length, newLines.length);
  let oldNo = 0;
  let newNo = 0;
  for (let k = 0; k < minLen; k++) {
    oldNo += 1;
    newNo += 1;
    if (oldLines[k] === newLines[k]) {
      lines.push({ type: 'unchanged', text: newLines[k], oldLineNumber: oldNo, newLineNumber: newNo });
    } else {
      lines.push({ type: 'removed', text: oldLines[k], oldLineNumber: oldNo });
      lines.push({ type: 'added', text: newLines[k], newLineNumber: newNo });
    }
  }
  for (let k = minLen; k < oldLines.length; k++) {
    oldNo += 1;
    lines.push({ type: 'removed', text: oldLines[k], oldLineNumber: oldNo });
  }
  for (let k = minLen; k < newLines.length; k++) {
    newNo += 1;
    lines.push({ type: 'added', text: newLines[k], newLineNumber: newNo });
  }
  return lines;
}

export function getDiffStats(original: string, current: string): DiffStats {
  const oldLines = original.split('\n');
  const newLines = current.split('\n');
  const diffLines = computeLineDiff(original, current);
  let added = 0;
  let removed = 0;
  for (const line of diffLines) {
    if (line.type === 'added') added += 1;
    else if (line.type === 'removed') removed += 1;
  }
  return {
    added,
    removed,
    total: added + removed,
    originalLines: oldLines.length,
    currentLines: newLines.length,
  };
}
