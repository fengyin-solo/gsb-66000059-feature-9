import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import Editor from '@monaco-editor/react';
import { useInterviewStore, ExecutionResult } from '../store/interview';
import { SubmissionResult } from './SubmissionResult';
import { LANGUAGE_CONFIGS, getLanguageConfig, getDefaultCodeByLanguage, LanguageConfig } from '../types';
import { DraftRecoveryDialog } from './DraftRecoveryDialog';
import {
  CodeDraft,
  getDraft,
  restoreDraft,
  deleteDraft,
  saveDraftSync,
  deleteDraftSync,
} from '../services/draftService';

interface CodeEditorProps {
  disabled?: boolean;
  onRun?: () => Promise<ExecutionResult>;
  onSubmit?: () => Promise<ExecutionResult>;
  showRunButton?: boolean;
  showSubmitButton?: boolean;
}

export const CodeEditor: React.FC<CodeEditorProps> = ({
  disabled = false,
  onRun,
  onSubmit,
  showRunButton = true,
  showSubmitButton = true,
}) => {
  const {
    code,
    setCode,
    language,
    setLanguage,
    applyDraftCode,
    originalCode,
    isRunning,
    isSubmitting,
    setIsRunning,
    setIsSubmitting,
    setLastRunResult,
    setLastSubmissionResult,
    addExecutionHistory,
    updateExecutionHistory,
    resetOriginalCode,
    currentProblem,
    currentRoom,
    lastRunResult,
    lastSubmissionResult,
    executionHistory,
  } = useInterviewStore();

  const [languageConfirmOpen, setLanguageConfirmOpen] = useState(false);
  const [pendingLanguage, setPendingLanguage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);
  const [codeModified, setCodeModified] = useState(false);
  const [codeChangeIndicator, setCodeChangeIndicator] = useState(false);
  const [showLanguageDropdown, setShowLanguageDropdown] = useState(false);

  // 未提交草稿恢复相关状态
  const [draftPrompt, setDraftPrompt] = useState<CodeDraft | null>(null);
  const [draftRestoring, setDraftRestoring] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const roomId = currentRoom?.id;
  const problemId = currentProblem?.id;
  const sessionKey = roomId && problemId ? `${roomId}__${problemId}` : null;
  const sessionKeyRef = useRef<string | null>(null);
  /** 当前会话是否已完成初始化（加载模板/草稿），完成前禁止自动保存草稿 */
  const sessionReadyRef = useRef(false);
  /** 会话初始化令牌，仅最新一次初始化允许更新状态（兼容 StrictMode 双挂载） */
  const initTokenRef = useRef(0);
  const autoSaveTimerRef = useRef<number | null>(null);
  /** 供卸载/页面隐藏时立即落盘最新代码 */
  const latestCodeRef = useRef({ code, language, roomId: roomId ?? '', problemId: problemId ?? '', ready: false });

  useEffect(() => {
    latestCodeRef.current = {
      code,
      language,
      roomId: roomId ?? '',
      problemId: problemId ?? '',
      ready: sessionReadyRef.current,
    };
  }, [code, language, roomId, problemId]);

  const langConfig = useMemo(() => getLanguageConfig(language), [language]);

  const codeChangeStats = useMemo(() => {
    if (!codeModified) return { added: 0, removed: 0, total: 0 };
    const originalLines = originalCode.split('\n');
    const currentLines = code.split('\n');
    const minLen = Math.min(originalLines.length, currentLines.length);
    let added = 0, removed = 0;
    for (let i = 0; i < minLen; i++) {
      if (originalLines[i] !== currentLines[i]) {
        added++;
        removed++;
      }
    }
    if (currentLines.length > originalLines.length) {
      added += currentLines.length - originalLines.length;
    } else if (originalLines.length > currentLines.length) {
      removed += originalLines.length - currentLines.length;
    }
    return { added, removed, total: added + removed };
  }, [code, originalCode, codeModified]);

  const showStatus = useCallback((type: 'success' | 'error' | 'info', text: string) => {
    setStatusMessage({ type, text });
  }, []);

  useEffect(() => {
    setCodeModified(code !== originalCode);
    if (code !== originalCode) {
      setCodeChangeIndicator(true);
      const timer = setTimeout(() => setCodeChangeIndicator(false), 300);
      return () => clearTimeout(timer);
    }
  }, [code, originalCode]);

  // 进入「房间 + 题目」会话：先重置为初始模板（无草稿时不会被覆盖），
  // 再检查是否存在未提交草稿，若有则提示恢复。
  useEffect(() => {
    if (!sessionKey || !roomId || !problemId) {
      sessionReadyRef.current = false;
      return;
    }

    // 同一会话（轮询刷新等）不重复初始化。StrictMode 双挂载时旧运行会使
    // token 失效，只有最新一次初始化可以更新状态。
    if (sessionKeyRef.current === sessionKey) return;
    sessionKeyRef.current = sessionKey;
    sessionReadyRef.current = false;
    initTokenRef.current += 1;
    const initToken = initTokenRef.current;

    const initSession = async () => {
      // 先重置为初始模板，确保不会把上个题目/会话的代码带入
      setLanguage('javascript');
      setDraftPrompt(null);
      setDraftError(null);

      try {
        const draft = await getDraft(roomId, problemId);
        if (initTokenRef.current !== initToken) return;
        if (draft) {
          setDraftPrompt(draft);
        }
      } catch (err) {
        if (initTokenRef.current !== initToken) return;
        // 草稿存储暂不可用：保留初始模板，给出错误条，不自动重试以免打扰
        showStatus('error', `读取本地草稿失败：${err instanceof Error ? err.message : '未知错误'}`);
      } finally {
        if (initTokenRef.current === initToken) {
          sessionReadyRef.current = true;
        }
      }
    };

    initSession();

    return () => {
      // 卸载即令本次初始化失效（兼容 StrictMode 双挂载）；
      // 若初始化尚未完成，复位会话标记，下次挂载可重新初始化。
      initTokenRef.current += 1;
      if (!sessionReadyRef.current) {
        sessionKeyRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey, roomId, problemId]);

  // 防抖自动保存草稿（仅在会话初始化完成后）
  useEffect(() => {
    if (!sessionKey || !roomId || !problemId) return;
    if (!sessionReadyRef.current) return;
    // 草稿恢复弹窗未处理前不保存，避免覆盖/重建即将恢复的草稿
    if (draftPrompt) return;

    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
    }

    const latestCode = code;
    const latestLanguage = language;
    autoSaveTimerRef.current = window.setTimeout(() => {
      try {
        saveDraftSync({ roomId, problemId, language: latestLanguage, code: latestCode });
      } catch (err) {
        // 保存失败不阻塞编辑，稍后由下一次修改自动重试
        showStatus('error', `草稿自动保存失败：${err instanceof Error ? err.message : '未知错误'}`);
      }
    }, 800);

    return () => {
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
      }
    };
  }, [code, language, sessionKey, roomId, problemId, draftPrompt]);

  // 离开页面/隐藏时立即把待保存的修改落盘，防止丢失最后的输入
  useEffect(() => {
    const flushPendingDraft = () => {
      const { code: latestCode, language: latestLanguage, roomId: rId, problemId: pId, ready } = latestCodeRef.current;
      if (!rId || !pId || !ready) return;
      try {
        saveDraftSync({ roomId: rId, problemId: pId, language: latestLanguage, code: latestCode });
      } catch {
        /* 页面卸载阶段无法提示，忽略 */
      }
    };
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') flushPendingDraft();
    };
    window.addEventListener('pagehide', flushPendingDraft);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      flushPendingDraft();
      window.removeEventListener('pagehide', flushPendingDraft);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, []);

  const handleRestoreDraft = useCallback(async () => {
    if (!roomId || !problemId || !draftPrompt) return;
    setDraftRestoring(true);
    setDraftError(null);
    try {
      const draft = await restoreDraft(roomId, problemId);
      if (draft.roomId !== roomId || draft.problemId !== problemId) {
        throw new Error('草稿与当前题目不匹配');
      }
      applyDraftCode(draft.language, draft.code);
      setDraftPrompt(null);
      showStatus('success', '已恢复未提交的代码草稿');
    } catch (err) {
      // 恢复失败保留弹窗，用户可重试或选择使用模板
      setDraftError(err instanceof Error ? err.message : '未知错误');
    } finally {
      setDraftRestoring(false);
    }
  }, [roomId, problemId, draftPrompt, applyDraftCode, showStatus]);

  const handleUseTemplate = useCallback(async () => {
    if (!roomId || !problemId || !draftPrompt) return;
    // 放弃草稿：当前已是初始模板，只需清除已保存的草稿
    try {
      await deleteDraft(roomId, problemId);
    } catch (err) {
      // 即使删除失败也继续使用模板，并提示用户（下次进入仍可能再次提示）
      showStatus('error', `草稿清除失败：${err instanceof Error ? err.message : '未知错误'}`);
    }
    setDraftPrompt(null);
    setDraftError(null);
    showStatus('info', '已使用初始模板');
  }, [roomId, problemId, draftPrompt, showStatus]);

  const latestSubmission = useMemo(() => {
    return executionHistory.find(h => h.type === 'submit') || executionHistory[0];
  }, [executionHistory]);

  const submissionStatus = useMemo(() => {
    if (!latestSubmission) return null;
    const passRate = latestSubmission.totalCount > 0
      ? (latestSubmission.passedCount / latestSubmission.totalCount) * 100
      : 0;
    const isSuccess = latestSubmission.passedCount === latestSubmission.totalCount && latestSubmission.totalCount > 0;
    return {
      isSuccess,
      passRate,
      passedCount: latestSubmission.passedCount,
      totalCount: latestSubmission.totalCount,
      runtime: latestSubmission.runtime,
      memory: latestSubmission.memory,
      timestamp: latestSubmission.timestamp,
      type: latestSubmission.type,
    };
  }, [latestSubmission]);

  useEffect(() => {
    if (statusMessage) {
      const timer = setTimeout(() => setStatusMessage(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [statusMessage]);

  const handleLanguageSelect = useCallback((newLang: string) => {
    setShowLanguageDropdown(false);
    if (newLang === language) return;

    if (codeModified && code.trim() !== '') {
      setPendingLanguage(newLang);
      setLanguageConfirmOpen(true);
    } else {
      // 切换语言会重置为新语言模板，旧语言草稿不再适用于当前编辑
      if (roomId && problemId) {
        try { deleteDraftSync(roomId, problemId); } catch { /* 忽略清理失败 */ }
      }
      setLanguage(newLang);
      showStatus('info', `已切换到 ${LANGUAGE_CONFIGS.find(l => l.value === newLang)?.label || newLang}`);
    }
  }, [language, codeModified, code, setLanguage, showStatus, roomId, problemId]);

  const confirmLanguageChange = useCallback(() => {
    if (pendingLanguage) {
      if (roomId && problemId) {
        try { deleteDraftSync(roomId, problemId); } catch { /* 忽略清理失败 */ }
      }
      setLanguage(pendingLanguage);
      showStatus('info', `已切换到 ${LANGUAGE_CONFIGS.find(l => l.value === pendingLanguage)?.label || pendingLanguage}`);
    }
    setLanguageConfirmOpen(false);
    setPendingLanguage(null);
  }, [pendingLanguage, setLanguage, showStatus, roomId, problemId]);

  const getTimeAgo = (dateString: string) => {
    const diff = Date.now() - new Date(dateString).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return '刚刚';
    if (mins < 60) return `${mins} 分钟前`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours} 小时前`;
    return `${Math.floor(hours / 24)} 天前`;
  };

  const cancelLanguageChange = useCallback(() => {
    setLanguageConfirmOpen(false);
    setPendingLanguage(null);
  }, []);

  const handleRun = useCallback(async () => {
    if (disabled || isRunning || isSubmitting) return;

    const historyId = `run-${Date.now()}`;
    const pendingResult: ExecutionResult = { success: false, output: '代码运行中...' };

    setIsRunning(true);
    setLastRunResult(null);
    showStatus('info', '正在运行代码...');

    addExecutionHistory({
      id: historyId,
      type: 'run',
      result: pendingResult,
      timestamp: new Date().toISOString(),
      language,
      passedCount: 0,
      totalCount: 0,
      status: 'running',
    });

    try {
      let result;
      if (onRun) {
        result = await onRun();
      } else {
        await new Promise(resolve => setTimeout(resolve, 1000));
        result = { success: true, output: '// 模拟运行结果\nHello, World!' };
      }

      setLastRunResult(result);

      const passedCount = result.testResults?.filter(t => t.passed).length || 0;
      const totalCount = result.testResults?.length || 0;
      const isSuccess = result.success && (totalCount === 0 || passedCount === totalCount);

      updateExecutionHistory(historyId, {
        result,
        passedCount,
        totalCount,
        runtime: result.runtime,
        memory: result.memory,
        status: isSuccess ? 'success' : 'failed',
      });

      if (result.success) {
        showStatus('success', '运行成功 ✓');
      } else {
        showStatus('error', result.error || '运行失败 ✗');
      }
    } catch (error) {
      const errorResult = { success: false, error: error instanceof Error ? error.message : '运行出错' };
      setLastRunResult(errorResult);
      updateExecutionHistory(historyId, {
        result: errorResult,
        status: 'failed',
      });
      showStatus('error', errorResult.error);
    } finally {
      setIsRunning(false);
    }
  }, [disabled, isRunning, isSubmitting, onRun, setIsRunning, setLastRunResult, addExecutionHistory, updateExecutionHistory, language, showStatus]);

  const handleSubmit = useCallback(async () => {
    if (disabled || isRunning || isSubmitting) return;

    if (!window.confirm('确定要提交代码吗？提交后将无法修改。')) {
      return;
    }

    const historyId = `submit-${Date.now()}`;
    const pendingResult: ExecutionResult = { success: false, output: '代码提交中...' };

    setIsSubmitting(true);
    setLastSubmissionResult(null);
    showStatus('info', '正在提交代码...');

    addExecutionHistory({
      id: historyId,
      type: 'submit',
      result: pendingResult,
      timestamp: new Date().toISOString(),
      language,
      passedCount: 0,
      totalCount: 0,
      status: 'running',
    });

    try {
      let result;
      if (onSubmit) {
        result = await onSubmit();
      } else {
        await new Promise(resolve => setTimeout(resolve, 1500));
        const testCases = currentProblem?.testCases?.filter(t => !t.hidden) || [];
        result = {
          success: Math.random() > 0.3,
          output: `// 模拟提交结果\n通过 ${Math.floor(Math.random() * testCases.length) + 1}/${testCases.length} 个测试用例`,
          runtime: Math.floor(Math.random() * 80) + 20,
          memory: Math.floor(Math.random() * 60) + 30,
          testResults: testCases.map(t => ({
            passed: Math.random() > 0.3,
            input: t.input,
            expected: t.expectedOutput,
            actual: Math.random() > 0.3 ? t.expectedOutput : 'wrong_output',
          })),
        };
      }

      setLastSubmissionResult(result);

      const passedCount = result.testResults?.filter(t => t.passed).length || 0;
      const totalCount = result.testResults?.length || 0;
      const isSuccess = result.success && passedCount === totalCount && totalCount > 0;

      updateExecutionHistory(historyId, {
        result,
        passedCount,
        totalCount,
        runtime: result.runtime,
        memory: result.memory,
        status: isSuccess ? 'success' : 'failed',
      });

      if (result.success) {
        // 提交成功：清理对应草稿，并以已提交代码作为新的差异基线
        if (roomId && problemId) {
          try { deleteDraftSync(roomId, problemId); } catch { /* 忽略清理失败 */ }
        }
        resetOriginalCode();
        showStatus('success', '提交成功 ✓ 所有测试用例通过');
      } else {
        showStatus('error', '提交失败 ✗ 存在未通过的测试用例');
      }
    } catch (error) {
      const errorResult = { success: false, error: error instanceof Error ? error.message : '提交出错' };
      setLastSubmissionResult(errorResult);
      updateExecutionHistory(historyId, {
        result: errorResult,
        status: 'failed',
      });
      showStatus('error', errorResult.error);
    } finally {
      setIsSubmitting(false);
    }
  }, [disabled, isRunning, isSubmitting, onSubmit, currentProblem, setIsSubmitting, setLastSubmissionResult, addExecutionHistory, updateExecutionHistory, language, showStatus, roomId, problemId, resetOriginalCode]);

  const buttonBaseStyle: React.CSSProperties = {
    padding: '6px 18px',
    borderRadius: '6px',
    border: 'none',
    cursor: 'pointer',
    fontSize: '13px',
    fontWeight: 500,
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    transition: 'all 0.2s ease',
    minWidth: '90px',
    justifyContent: 'center',
  };

  const getRunButtonStyle = (): React.CSSProperties => {
    const base = { ...buttonBaseStyle };
    if (disabled || isRunning || isSubmitting) {
      return { ...base, background: '#555', color: '#888', cursor: 'not-allowed', opacity: 0.7 };
    }
    return { ...base, background: '#4caf50', color: '#fff' };
  };

  const getSubmitButtonStyle = (): React.CSSProperties => {
    const base = { ...buttonBaseStyle };
    if (disabled || isRunning || isSubmitting) {
      return { ...base, background: '#555', color: '#888', cursor: 'not-allowed', opacity: 0.7 };
    }
    return { ...base, background: '#2196f3', color: '#fff' };
  };

  const Spinner = () => (
    <div style={{
      width: '14px',
      height: '14px',
      border: '2px solid transparent',
      borderTop: '2px solid currentColor',
      borderRadius: '50%',
      animation: 'spin 0.8s linear infinite',
    }} />
  );

  const LanguageBadge: React.FC<{ config: LanguageConfig; onClick: () => void; isOpen: boolean }> = ({ config, onClick, isOpen }) => (
    <div
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '6px 12px 6px 8px',
        borderRadius: '8px',
        background: config.bgColor,
        border: `2px solid ${config.borderColor}`,
        cursor: disabled || isRunning || isSubmitting ? 'not-allowed' : 'pointer',
        opacity: disabled || isRunning || isSubmitting ? 0.5 : 1,
        transition: 'all 0.2s ease',
        position: 'relative',
      }}
      onMouseEnter={(e) => {
        if (!disabled && !isRunning && !isSubmitting) {
          e.currentTarget.style.transform = 'translateY(-1px)';
          e.currentTarget.style.boxShadow = `0 2px 8px ${config.color}40`;
        }
      }}
      onMouseLeave={(e) => {
        if (!disabled && !isRunning && !isSubmitting) {
          e.currentTarget.style.transform = 'translateY(0)';
          e.currentTarget.style.boxShadow = 'none';
        }
      }}
    >
      <div style={{
        width: '26px',
        height: '26px',
        borderRadius: '6px',
        background: config.color,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#1e1e1e',
        fontSize: '11px',
        fontWeight: 800,
        fontFamily: 'monospace',
      }}>
        {config.icon}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <span style={{ color: '#fff', fontSize: '13px', fontWeight: 600 }}>{config.label}</span>
        <span style={{ color: config.color, fontSize: '10px', fontWeight: 500 }}>{config.value.toUpperCase()}</span>
      </div>
      <span style={{
        color: config.color,
        fontSize: '10px',
        marginLeft: '4px',
        transition: 'transform 0.2s',
        transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)',
      }}>▼</span>
      {codeModified && (
        <div style={{
          position: 'absolute',
          top: '-4px',
          right: '-4px',
          width: '10px',
          height: '10px',
          background: '#ff9800',
          borderRadius: '50%',
          animation: 'pulse 1.5s ease-in-out infinite',
          boxShadow: '0 0 8px #ff9800',
        }} title="代码已修改" />
      )}
    </div>
  );

  const LanguageDropdown: React.FC = () => (
    <div style={{
      position: 'absolute',
      top: '100%',
      left: '0',
      marginTop: '6px',
      background: '#2d2d2d',
      border: '1px solid #444',
      borderRadius: '8px',
      boxShadow: '0 8px 24px rgba(0, 0, 0, 0.5)',
      zIndex: 1000,
      overflow: 'hidden',
      minWidth: '180px',
    }}>
      {LANGUAGE_CONFIGS.map((lang) => (
        <div
          key={lang.value}
          onClick={() => handleLanguageSelect(lang.value)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            padding: '10px 14px',
            cursor: 'pointer',
            transition: 'background 0.15s',
            background: language === lang.value ? lang.bgColor : 'transparent',
          }}
          onMouseEnter={(e) => {
            if (language !== lang.value) {
              e.currentTarget.style.background = lang.bgColor;
            }
          }}
          onMouseLeave={(e) => {
            if (language !== lang.value) {
              e.currentTarget.style.background = 'transparent';
            }
          }}
        >
          <div style={{
            width: '22px',
            height: '22px',
            borderRadius: '4px',
            background: lang.color,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#1e1e1e',
            fontSize: '10px',
            fontWeight: 800,
            fontFamily: 'monospace',
          }}>
            {lang.icon}
          </div>
          <span style={{ color: '#fff', fontSize: '13px', fontWeight: 500, flex: 1 }}>{lang.label}</span>
          {language === lang.value && (
            <span style={{ color: lang.color, fontSize: '12px', fontWeight: 600 }}>✓</span>
          )}
        </div>
      ))}
    </div>
  );

  const CodeChangeIndicator: React.FC = () => (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: '10px',
      padding: '6px 12px',
      background: codeChangeIndicator ? 'rgba(255, 152, 0, 0.2)' : 'rgba(255, 152, 0, 0.1)',
      border: codeChangeIndicator ? '1px solid #ff9800' : '1px solid rgba(255, 152, 0, 0.3)',
      borderRadius: '6px',
      transition: 'all 0.3s ease',
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
        animation: codeChangeIndicator ? 'flash 0.3s ease' : 'none',
      }}>
        <span style={{ color: '#ff9800', fontSize: '14px' }}>✏️</span>
        <span style={{ color: '#ff9800', fontSize: '11px', fontWeight: 600 }}>已修改</span>
      </div>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        fontSize: '10px',
        fontFamily: 'monospace',
      }}>
        {codeChangeStats.added > 0 && (
          <span style={{ color: '#4caf50', fontWeight: 600 }}>
            +{codeChangeStats.added}
          </span>
        )}
        {codeChangeStats.removed > 0 && (
          <span style={{ color: '#f44336', fontWeight: 600 }}>
            -{codeChangeStats.removed}
          </span>
        )}
        {codeChangeStats.total > 0 && (
          <span style={{ color: '#888' }}>
            · {codeChangeStats.total} 处变更
          </span>
        )}
      </div>
    </div>
  );

  const SubmissionStatusBar: React.FC = () => {
    if (!submissionStatus) {
      return (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '6px 12px',
          background: 'rgba(102, 102, 102, 0.1)',
          border: '1px solid rgba(102, 102, 102, 0.3)',
          borderRadius: '6px',
        }}>
          <span style={{ color: '#666', fontSize: '14px' }}>📊</span>
          <span style={{ color: '#666', fontSize: '11px', fontWeight: 500 }}>暂无执行记录</span>
        </div>
      );
    }

    const statusColor = submissionStatus.isSuccess ? '#4caf50' : '#ff9800';
    const statusBg = submissionStatus.isSuccess ? 'rgba(76, 175, 80, 0.1)' : 'rgba(255, 152, 0, 0.1)';
    const statusBorder = submissionStatus.isSuccess ? 'rgba(76, 175, 80, 0.3)' : 'rgba(255, 152, 0, 0.3)';

    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '6px 12px',
        background: statusBg,
        border: `1px solid ${statusBorder}`,
        borderRadius: '6px',
        transition: 'all 0.3s ease',
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
        }}>
          <span style={{ fontSize: '14px' }}>{submissionStatus.isSuccess ? '✅' : '⏳'}</span>
          <span style={{
            color: statusColor,
            fontSize: '11px',
            fontWeight: 600,
          }}>
            {submissionStatus.type === 'submit' ? '提交' : '运行'}
            {submissionStatus.isSuccess ? '通过' : '进行中'}
          </span>
        </div>

        <div style={{ width: '1px', height: '14px', background: '#444' }} />

        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          fontSize: '10px',
          fontFamily: 'monospace',
        }}>
          <span style={{
            color: submissionStatus.isSuccess ? '#4caf50' : '#ff9800',
            fontWeight: 700,
            fontSize: '11px',
          }}>
            {submissionStatus.passedCount}/{submissionStatus.totalCount || '-'}
          </span>
          <span style={{ color: '#666' }}>用例</span>
          {submissionStatus.runtime !== undefined && (
            <>
              <span style={{ width: '4px', height: '4px', background: '#444', borderRadius: '50%' }} />
              <span style={{ color: '#2196f3', fontWeight: 600 }}>
                {submissionStatus.runtime}ms
              </span>
            </>
          )}
          {submissionStatus.memory !== undefined && (
            <>
              <span style={{ width: '4px', height: '4px', background: '#444', borderRadius: '50%' }} />
              <span style={{ color: '#9c27b0', fontWeight: 600 }}>
                {submissionStatus.memory}MB
              </span>
            </>
          )}
        </div>

        <div style={{ width: '1px', height: '14px', background: '#444' }} />

        <span style={{ color: '#666', fontSize: '10px' }}>
          {getTimeAgo(submissionStatus.timestamp)}
        </span>
      </div>
    );
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '12px',
        padding: '10px 16px',
        background: '#1e1e1e',
        borderBottom: '1px solid #333',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ position: 'relative' }}>
            <LanguageBadge
              config={langConfig}
              onClick={() => !disabled && !isRunning && !isSubmitting && setShowLanguageDropdown(!showLanguageDropdown)}
              isOpen={showLanguageDropdown}
            />
            {showLanguageDropdown && (
              <>
                <div
                  style={{
                    position: 'fixed',
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                    zIndex: 999,
                  }}
                  onClick={() => setShowLanguageDropdown(false)}
                />
                <LanguageDropdown />
              </>
            )}
          </div>

          {codeModified && <CodeChangeIndicator />}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <SubmissionStatusBar />

          {statusMessage && (
            <span style={{
              color: statusMessage.type === 'success' ? '#4caf50' : statusMessage.type === 'error' ? '#f44336' : '#2196f3',
              fontSize: '12px',
              fontWeight: 500,
              padding: '4px 10px',
              borderRadius: '4px',
              background: statusMessage.type === 'success' ? 'rgba(76, 175, 80, 0.1)' :
                statusMessage.type === 'error' ? 'rgba(244, 67, 54, 0.1)' : 'rgba(33, 150, 243, 0.1)',
            }}>
              {statusMessage.text}
            </span>
          )}

          {showRunButton && (
            <button
              onClick={handleRun}
              disabled={disabled || isRunning || isSubmitting}
              style={getRunButtonStyle()}
              onMouseEnter={(e) => {
                if (!disabled && !isRunning && !isSubmitting) {
                  e.currentTarget.style.background = '#45a049';
                  e.currentTarget.style.transform = 'translateY(-1px)';
                  e.currentTarget.style.boxShadow = '0 2px 8px rgba(76, 175, 80, 0.3)';
                }
              }}
              onMouseLeave={(e) => {
                if (!disabled && !isRunning && !isSubmitting) {
                  e.currentTarget.style.background = '#4caf50';
                  e.currentTarget.style.transform = 'translateY(0)';
                  e.currentTarget.style.boxShadow = 'none';
                }
              }}
              onMouseDown={(e) => {
                if (!disabled && !isRunning && !isSubmitting) {
                  e.currentTarget.style.transform = 'translateY(0)';
                }
              }}
              title={disabled ? '面试未开始' : isRunning ? '正在运行...' : '运行代码 (Ctrl+Enter)'}
            >
              {isRunning ? <Spinner /> : '▶'}
              {isRunning ? '运行中' : '运行'}
            </button>
          )}

          {showSubmitButton && (
            <button
              onClick={handleSubmit}
              disabled={disabled || isRunning || isSubmitting}
              style={getSubmitButtonStyle()}
              onMouseEnter={(e) => {
                if (!disabled && !isRunning && !isSubmitting) {
                  e.currentTarget.style.background = '#1976d2';
                  e.currentTarget.style.transform = 'translateY(-1px)';
                  e.currentTarget.style.boxShadow = '0 2px 8px rgba(33, 150, 243, 0.3)';
                }
              }}
              onMouseLeave={(e) => {
                if (!disabled && !isRunning && !isSubmitting) {
                  e.currentTarget.style.background = '#2196f3';
                  e.currentTarget.style.transform = 'translateY(0)';
                  e.currentTarget.style.boxShadow = 'none';
                }
              }}
              onMouseDown={(e) => {
                if (!disabled && !isRunning && !isSubmitting) {
                  e.currentTarget.style.transform = 'translateY(0)';
                }
              }}
              title={disabled ? '面试未开始' : isSubmitting ? '正在提交...' : '提交代码 (Ctrl+Shift+Enter)'}
            >
              {isSubmitting ? <Spinner /> : '✓'}
              {isSubmitting ? '提交中' : '提交'}
            </button>
          )}
        </div>
      </div>

      {languageConfirmOpen && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0, 0, 0, 0.6)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000,
        }}>
          <div style={{
            background: '#2d2d2d',
            borderRadius: '8px',
            padding: '24px',
            maxWidth: '400px',
            width: '90%',
            border: '1px solid #444',
            boxShadow: '0 4px 20px rgba(0, 0, 0, 0.5)',
          }}>
            <h3 style={{ margin: '0 0 12px 0', color: '#fff', fontSize: '16px' }}>
              ⚠️ 确认切换语言
            </h3>
            <p style={{ margin: '0 0 20px 0', color: '#ccc', fontSize: '13px', lineHeight: 1.6 }}>
              当前代码已修改，切换到 <strong style={{ color: getLanguageConfig(pendingLanguage || '').color }}>
                {LANGUAGE_CONFIGS.find(l => l.value === pendingLanguage)?.label || pendingLanguage}
              </strong> 将重置代码模板。
              <br /><br />
              是否继续？
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
              <button
                onClick={cancelLanguageChange}
                style={{
                  padding: '8px 16px',
                  borderRadius: '6px',
                  border: '1px solid #555',
                  background: 'transparent',
                  color: '#ccc',
                  cursor: 'pointer',
                  fontSize: '13px',
                }}
              >
                取消
              </button>
              <button
                onClick={confirmLanguageChange}
                style={{
                  padding: '8px 16px',
                  borderRadius: '6px',
                  border: 'none',
                  background: '#ff9800',
                  color: '#fff',
                  cursor: 'pointer',
                  fontSize: '13px',
                  fontWeight: 500,
                }}
              >
                确认切换
              </button>
            </div>
          </div>
        </div>
      )}

      {draftPrompt && (
        <DraftRecoveryDialog
          draft={draftPrompt}
          templateCode={getDefaultCodeByLanguage(draftPrompt.language)}
          restoring={draftRestoring}
          error={draftError}
          onRestore={handleRestoreDraft}
          onUseTemplate={handleUseTemplate}
        />
      )}

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ flex: lastRunResult || lastSubmissionResult ? '0 0 60%' : '1', overflow: 'hidden', minHeight: '200px' }}>
          <Editor
            height="100%"
            language={language}
            value={code}
            onChange={(v) => setCode(v || '')}
            theme="vs-dark"
            options={{
              fontSize: 14,
              minimap: { enabled: false },
              wordWrap: 'on',
              readOnly: disabled || !!draftPrompt,
              automaticLayout: true,
            }}
          />
        </div>

        {lastSubmissionResult && (
          <div style={{ flex: '0 0 40%', minHeight: '200px', display: 'flex', flexDirection: 'column' }}>
            <SubmissionResult
              title="提交结果"
              type="submit"
              success={lastSubmissionResult.success}
              output={lastSubmissionResult.output}
              error={lastSubmissionResult.error}
              runtime={lastSubmissionResult.runtime}
              memory={lastSubmissionResult.memory}
              testResults={lastSubmissionResult.testResults}
            />
          </div>
        )}

        {!lastSubmissionResult && lastRunResult && (
          <div style={{ flex: '0 0 40%', minHeight: '200px', display: 'flex', flexDirection: 'column' }}>
            <SubmissionResult
              title="运行结果"
              type="run"
              success={lastRunResult.success}
              output={lastRunResult.output}
              error={lastRunResult.error}
              runtime={lastRunResult.runtime}
              memory={lastRunResult.memory}
              testResults={lastRunResult.testResults}
            />
          </div>
        )}
      </div>

      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.7; transform: scale(1.2); }
        }
        @keyframes flash {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
      `}</style>
    </div>
  );
};
