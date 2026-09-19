import React, { useMemo, useState } from 'react';
import { LANGUAGE_CONFIGS, getLanguageConfig } from '../types';
import { CodeDraft } from '../services/draftService';
import { computeLineDiff, getDiffStats } from '../utils/diff';
import { getTimeAgo, formatDateTime } from '../utils/format';

interface DraftRecoveryDialogProps {
  draft: CodeDraft;
  /** 当前语言的初始模板，用于计算差异概况 */
  templateCode: string;
  /** 是否正在读取/恢复草稿 */
  restoring: boolean;
  /** 恢复失败时的错误信息（展示后可重试） */
  error: string | null;
  onRestore: () => void;
  onUseTemplate: () => void;
}

const MAX_DIFF_PREVIEW_LINES = 200;

export const DraftRecoveryDialog: React.FC<DraftRecoveryDialogProps> = ({
  draft,
  templateCode,
  restoring,
  error,
  onRestore,
  onUseTemplate,
}) => {
  const [showFullDiff, setShowFullDiff] = useState(false);
  const langConfig = getLanguageConfig(draft.language);
  const langLabel = LANGUAGE_CONFIGS.find((l) => l.value === draft.language)?.label || draft.language;

  const stats = useMemo(
    () => getDiffStats(templateCode, draft.code),
    [templateCode, draft.code],
  );

  const diffLines = useMemo(
    () => computeLineDiff(templateCode, draft.code),
    [templateCode, draft.code],
  );

  const previewLines = showFullDiff ? diffLines : diffLines.slice(0, MAX_DIFF_PREVIEW_LINES);
  const hiddenCount = diffLines.length - MAX_DIFF_PREVIEW_LINES;

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      background: 'rgba(0, 0, 0, 0.65)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 2000,
    }}>
      <div style={{
        background: '#252526',
        borderRadius: '10px',
        width: '640px',
        maxWidth: '92vw',
        maxHeight: '88vh',
        display: 'flex',
        flexDirection: 'column',
        border: '1px solid #444',
        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.6)',
        overflow: 'hidden',
      }}>
        {/* 头部 */}
        <div style={{
          padding: '18px 22px 14px',
          borderBottom: '1px solid #3a3a3a',
          background: 'rgba(255, 152, 0, 0.06)',
        }}>
          <h3 style={{ margin: '0 0 10px 0', color: '#fff', fontSize: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span>📝</span>
            检测到未提交的代码草稿
          </h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
            <span style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              padding: '3px 10px',
              borderRadius: '6px',
              background: langConfig.bgColor,
              border: `1px solid ${langConfig.borderColor}`,
              color: '#fff',
              fontSize: '12px',
              fontWeight: 600,
            }}>
              <span style={{
                display: 'inline-flex',
                width: '18px',
                height: '18px',
                borderRadius: '4px',
                background: langConfig.color,
                color: '#1e1e1e',
                fontSize: '9px',
                fontWeight: 800,
                fontFamily: 'monospace',
                alignItems: 'center',
                justifyContent: 'center',
              }}>
                {langConfig.icon}
              </span>
              {langLabel}
            </span>
            <span style={{ color: '#aaa', fontSize: '12px' }} title={formatDateTime(draft.updatedAt)}>
              最后修改：<span style={{ color: '#ddd' }}>{formatDateTime(draft.updatedAt)}</span>
              <span style={{ color: '#777', marginLeft: '6px' }}>（{getTimeAgo(draft.updatedAt)}）</span>
            </span>
          </div>
        </div>

        {/* 差异概况 */}
        <div style={{ padding: '14px 22px', flex: 1, overflowY: 'auto', minHeight: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px', flexWrap: 'wrap' }}>
            <span style={{ color: '#ccc', fontSize: '13px' }}>与初始模板的差异：</span>
            <span style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              padding: '3px 10px',
              borderRadius: '5px',
              background: 'rgba(76, 175, 80, 0.12)',
              border: '1px solid rgba(76, 175, 80, 0.35)',
              fontSize: '12px',
              fontFamily: 'monospace',
              fontWeight: 600,
            }}>
              <span style={{ color: '#4caf50' }}>+{stats.added}</span>
              <span style={{ color: '#f44336' }}>-{stats.removed}</span>
            </span>
            <span style={{ color: '#888', fontSize: '12px' }}>
              共 {stats.total} 行变更
            </span>
            <span style={{ color: '#666', fontSize: '11px' }}>
              模板 {stats.originalLines} 行 → 草稿 {stats.currentLines} 行
            </span>
          </div>

          <div style={{
            background: '#1e1e1e',
            border: '1px solid #3a3a3a',
            borderRadius: '6px',
            maxHeight: '240px',
            overflow: 'auto',
            fontFamily: 'Consolas, Monaco, "Courier New", monospace',
            fontSize: '12px',
            lineHeight: 1.55,
          }}>
            {previewLines.map((line, idx) => {
              const color = line.type === 'added' ? '#4caf50' : line.type === 'removed' ? '#f44336' : '#888';
              const bg = line.type === 'added'
                ? 'rgba(76, 175, 80, 0.08)'
                : line.type === 'removed'
                  ? 'rgba(244, 67, 54, 0.08)'
                  : 'transparent';
              const sign = line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' ';
              const lineNo = line.type === 'added' ? line.newLineNumber : line.oldLineNumber;
              return (
                <div
                  key={idx}
                  style={{
                    display: 'flex',
                    background: bg,
                    whiteSpace: 'pre',
                  }}
                >
                  <span style={{
                    flex: '0 0 52px',
                    textAlign: 'right',
                    paddingRight: '10px',
                    color: '#5a5a5a',
                    userSelect: 'none',
                  }}>
                    {lineNo ?? ''}
                  </span>
                  <span style={{
                    flex: '0 0 14px',
                    color,
                    fontWeight: 700,
                    userSelect: 'none',
                  }}>
                    {sign}
                  </span>
                  <span style={{ color, paddingRight: '12px' }}>{line.text}</span>
                </div>
              );
            })}
          </div>

          {hiddenCount > 0 && (
            <button
              onClick={() => setShowFullDiff(true)}
              style={{
                marginTop: '8px',
                background: 'transparent',
                border: 'none',
                color: '#2196f3',
                fontSize: '12px',
                cursor: 'pointer',
                padding: 0,
              }}
            >
              展开剩余 {hiddenCount} 行差异
            </button>
          )}

          {error && (
            <div style={{
              marginTop: '12px',
              padding: '10px 12px',
              background: 'rgba(244, 67, 54, 0.1)',
              border: '1px solid rgba(244, 67, 54, 0.4)',
              borderRadius: '6px',
              color: '#f44336',
              fontSize: '12px',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
            }}>
              <span>⚠️</span>
              <span>草稿恢复失败：{error}。请重试，或放弃草稿使用初始模板。</span>
            </div>
          )}
        </div>

        {/* 底部操作 */}
        <div style={{
          padding: '14px 22px',
          borderTop: '1px solid #3a3a3a',
          display: 'flex',
          justifyContent: 'flex-end',
          gap: '10px',
          background: '#2d2d2d',
        }}>
          <button
            onClick={onUseTemplate}
            disabled={restoring}
            style={{
              padding: '8px 16px',
              borderRadius: '6px',
              border: '1px solid #555',
              background: 'transparent',
              color: '#ccc',
              cursor: restoring ? 'not-allowed' : 'pointer',
              fontSize: '13px',
              opacity: restoring ? 0.6 : 1,
            }}
          >
            使用模板（放弃草稿）
          </button>
          <button
            onClick={onRestore}
            disabled={restoring}
            style={{
              padding: '8px 18px',
              borderRadius: '6px',
              border: 'none',
              background: '#ff9800',
              color: '#fff',
              cursor: restoring ? 'wait' : 'pointer',
              fontSize: '13px',
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              opacity: restoring ? 0.8 : 1,
            }}
          >
            {restoring && (
              <span style={{
                width: '12px',
                height: '12px',
                border: '2px solid rgba(255,255,255,0.4)',
                borderTopColor: '#fff',
                borderRadius: '50%',
                animation: 'draft-spin 0.8s linear infinite',
                display: 'inline-block',
              }} />
            )}
            {restoring ? '恢复中...' : error ? '重试恢复' : '恢复草稿'}
          </button>
        </div>
      </div>

      <style>{`
        @keyframes draft-spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
};
