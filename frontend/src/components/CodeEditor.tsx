import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import Editor from '@monaco-editor/react';
import { useInterviewStore, ExecutionResult } from '../store/interview';
import { SubmissionResult } from './SubmissionResult';
import { LANGUAGE_CONFIGS, getLanguageConfig, LanguageConfig, getDefaultCodeByLanguage } from '../types';
import {
  CodeDraft,
  DraftDiffStats,
  computeDraftDiff,
  formatDraftTime,
  getDraft,
  isRecoverableDraft,
  removeDraft,
  saveDraft,
} from '../services/codeDraftService';

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
    currentProblem,
    currentUser,
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
  const [draftModalOpen, setDraftModalOpen] = useState(false);
  const [draftChecking, setDraftChecking] = useState(false);
  const [pendingDraft, setPendingDraft] = useState<CodeDraft | null>(null);
  const [draftCheckError, setDraftCheckError] = useState<string | null>(null);
  const [draftBusy, setDraftBusy] = useState(false);

  const langConfig = useMemo(() => getLanguageConfig(language), [language]);

  // ---- 未提交草稿：检查、恢复、自动保存 ----
  const draftContextKey = `${currentUser?.id ?? 'anonymous'}::${currentProblem?.id ?? ''}`;
  const checkedDraftContextRef = useRef<string | null>(null);
  const draftCheckCompletedRef = useRef(false);
  /** 仅在草稿检查完成且用户确实编辑过/恢复过草稿后才自动保存，避免把当前内存内容误写成草稿 */
  const autoSaveEnabledRef = useRef(false);
  const lastSavedSignatureRef = useRef<string | null>(null);
  const pendingSnapshotRef = useRef<{ code: string; language: string }>({ code, language });
  const latestRef = useRef({ code, language, currentUser, currentProblem, draftModalOpen });
  latestRef.current = { code, language, currentUser, currentProblem, draftModalOpen };

  const draftDiffStats = useMemo<DraftDiffStats | null>(() => {
    if (!pendingDraft) return null;
    try {
      return computeDraftDiff(pendingDraft);
    } catch {
      return null;
    }
  }, [pendingDraft]);

  /**
   * 进入题目（切换题目、返回房间重进、断网重连）时检查未提交草稿。
   * 无草稿或草稿已与初始模板一致时保持当前代码不变，不会发生覆盖。
   */
  const runDraftCheck = useCallback(async () => {
    const user = latestRef.current.currentUser;
    const problem = latestRef.current.currentProblem;
    if (!user || !problem) return;

    setDraftChecking(true);
    setDraftCheckError(null);
    try {
      const draft = await getDraft(user.id, problem.id);
      if (draft && isRecoverableDraft(draft)) {
        setPendingDraft(draft);
        setDraftModalOpen(true);
      } else if (draft) {
        // 草稿已退化为模板（例如切语言后残留），静默清理
        try {
          await removeDraft(user.id, problem.id);
        } catch {
          // 清理失败不阻塞使用，下次保存会覆盖
        }
      }
    } catch (error) {
      setPendingDraft(null);
      setDraftCheckError(error instanceof Error ? error.message : '读取本地草稿失败');
      setDraftModalOpen(true);
    } finally {
      draftCheckCompletedRef.current = true;
      autoSaveEnabledRef.current = false;
      setDraftChecking(false);
    }
  }, []);

  // 题目上下文变化时检查一次草稿（只检查一次，防止轮询重复弹窗）
  useEffect(() => {
    if (!currentUser?.id || !currentProblem?.id) return;
    if (checkedDraftContextRef.current === draftContextKey) return;
    checkedDraftContextRef.current = draftContextKey;
    draftCheckCompletedRef.current = false;
    autoSaveEnabledRef.current = false;
    lastSavedSignatureRef.current = null;
    pendingSnapshotRef.current = { code, language };
    void runDraftCheck();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftContextKey, currentUser?.id, currentProblem?.id]);

  /** 立即将待保存的快照写入本地草稿；返回是否实际写入 */
  const flushDraftSnapshot = useCallback((): boolean => {
    const { currentUser: user, currentProblem: problem } = latestRef.current;
    if (!user || !problem) return false;
    const snapshot = pendingSnapshotRef.current;
    const template = getDefaultCodeByLanguage(snapshot.language);
    if (snapshot.code.trim() === '' || snapshot.code === template) return false;
    const signature = `${snapshot.language} ${snapshot.code}`;
    if (signature === lastSavedSignatureRef.current) return false;
    saveDraft({
      problemId: problem.id,
      userId: user.id,
      code: snapshot.code,
      language: snapshot.language,
      savedAt: new Date().toISOString(),
    });
    lastSavedSignatureRef.current = signature;
    return true;
  }, []);

  // 题目/用户切换的渲染前一刻，先把上一题目尚未落盘的修改刷入草稿
  useEffect(() => {
    const previousContext = checkedDraftContextRef.current;
    return () => {
      // 实时读取标记：用户是否曾在当前题目的草稿检查完成后编辑过代码
      if (previousContext && autoSaveEnabledRef.current) {
        try {
          pendingSnapshotRef.current = {
            code: latestRef.current.code,
            language: latestRef.current.language,
          };
          flushDraftSnapshot();
        } catch {
          // 离开题目时的最佳努力保存，失败不打断导航
        }
      }
    };
  }, [draftContextKey, flushDraftSnapshot]);

  // 代码变化后的防抖自动保存（草稿弹窗期间与未编辑状态不保存）
  useEffect(() => {
    if (!draftCheckCompletedRef.current || !autoSaveEnabledRef.current) return;
    if (draftModalOpen || isRunning || isSubmitting) return;
    pendingSnapshotRef.current = { code, language };

    const timer = window.setTimeout(() => {
      try {
        if (flushDraftSnapshot()) {
          showStatus('info', '草稿已自动保存');
        }
      } catch (error) {
        showStatus('error', `草稿保存失败：${error instanceof Error ? error.message : '请稍后重试'}`);
      }
    }, 800);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, language, draftModalOpen, isRunning, isSubmitting]);

  // 关闭页面 / 切到后台时尽量保存最新代码
  useEffect(() => {
    const handleFlush = () => {
      if (!draftCheckCompletedRef.current || !autoSaveEnabledRef.current) return;
      pendingSnapshotRef.current = { code: latestRef.current.code, language: latestRef.current.language };
      try {
        flushDraftSnapshot();
      } catch {
        // 页面卸载期间无法可靠提示，忽略
      }
    };
    window.addEventListener('beforeunload', handleFlush);
    document.addEventListener('visibilitychange', handleFlush);
    return () => {
      window.removeEventListener('beforeunload', handleFlush);
      document.removeEventListener('visibilitychange', handleFlush);
    };
  }, [flushDraftSnapshot]);

  const handleEditorChange = useCallback((value: string) => {
    autoSaveEnabledRef.current = draftCheckCompletedRef.current;
    setCode(value);
  }, [setCode]);

  const handleRestoreDraft = useCallback(async () => {
    const user = latestRef.current.currentUser;
    const problem = latestRef.current.currentProblem;
    if (!user || !problem) return;

    setDraftBusy(true);
    setDraftCheckError(null);
    try {
      // 始终以本地最新的草稿内容为准，保证“重试”能读到新写入的数据
      const draft = await getDraft(user.id, problem.id);
      if (!isRecoverableDraft(draft)) {
        throw new Error('草稿不存在或已恢复为初始模板');
      }
      applyDraftCode(draft.language, draft.code);
      autoSaveEnabledRef.current = true;
      lastSavedSignatureRef.current = `${draft.language} ${draft.code}`;
      pendingSnapshotRef.current = { code: draft.code, language: draft.language };
      setPendingDraft(draft);
      setDraftModalOpen(false);
      showStatus('success', '已恢复未提交的草稿 ✓');
    } catch (error) {
      setDraftCheckError(error instanceof Error ? error.message : '草稿恢复失败，请重试');
    } finally {
      setDraftBusy(false);
    }
  }, [applyDraftCode]);

  const handleUseTemplate = useCallback(async () => {
    const user = latestRef.current.currentUser;
    const problem = latestRef.current.currentProblem;
    if (!user || !problem || !pendingDraft) return;

    setDraftBusy(true);
    setDraftCheckError(null);
    try {
      // 先清理草稿再重置编辑器，避免异常情况下误覆盖当前代码
      await removeDraft(user.id, problem.id);
      lastSavedSignatureRef.current = null;
      setLanguage(pendingDraft.language);
      autoSaveEnabledRef.current = false;
      setPendingDraft(null);
      setDraftModalOpen(false);
      showStatus('info', '已使用初始模板，草稿已放弃');
    } catch (error) {
      setDraftCheckError(error instanceof Error ? error.message : '放弃草稿失败，请重试');
    } finally {
      setDraftBusy(false);
    }
  }, [pendingDraft, setLanguage]);

  const handleDismissDraft = useCallback(() => {
    setDraftModalOpen(false);
    setDraftCheckError(null);
    // 保留当前代码与本地草稿，由后续自动保存或再次进入时处理
  }, []);

  const handleRetryDraftCheck = useCallback(() => {
    void runDraftCheck();
  }, [runDraftCheck]);

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

  useEffect(() => {
    setCodeModified(code !== originalCode);
    if (code !== originalCode) {
      setCodeChangeIndicator(true);
      const timer = setTimeout(() => setCodeChangeIndicator(false), 300);
      return () => clearTimeout(timer);
    }
  }, [code, originalCode]);

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

  const showStatus = useCallback((type: 'success' | 'error' | 'info', text: string) => {
    setStatusMessage({ type, text });
  }, []);

  const handleLanguageSelect = useCallback((newLang: string) => {
    setShowLanguageDropdown(false);
    if (newLang === language) return;

    if (codeModified && code.trim() !== '') {
      setPendingLanguage(newLang);
      setLanguageConfirmOpen(true);
    } else {
      setLanguage(newLang);
      showStatus('info', `已切换到 ${LANGUAGE_CONFIGS.find(l => l.value === newLang)?.label || newLang}`);
    }
  }, [language, codeModified, code, setLanguage, showStatus]);

  const confirmLanguageChange = useCallback(() => {
    if (pendingLanguage) {
      setLanguage(pendingLanguage);
      // 语言切换会重置为新语言模板，旧语言的未提交草稿随之失效
      const user = latestRef.current.currentUser;
      const problem = latestRef.current.currentProblem;
      if (user && problem) {
        try {
          removeDraft(user.id, problem.id);
          lastSavedSignatureRef.current = null;
        } catch {
          showStatus('error', '旧草稿清理失败，可稍后重试');
        }
      }
      autoSaveEnabledRef.current = false;
      showStatus('info', `已切换到 ${LANGUAGE_CONFIGS.find(l => l.value === pendingLanguage)?.label || pendingLanguage}`);
    }
    setLanguageConfirmOpen(false);
    setPendingLanguage(null);
  }, [pendingLanguage, setLanguage, showStatus]);

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
      const isSubmitSuccess = result.success && passedCount === totalCount && totalCount > 0;

      updateExecutionHistory(historyId, {
        result,
        passedCount,
        totalCount,
        runtime: result.runtime,
        memory: result.memory,
        status: isSubmitSuccess ? 'success' : 'failed',
      });

      if (isSubmitSuccess) {
        // 提交成功后清理对应题目的本地草稿
        if (currentUser && currentProblem) {
          try {
            removeDraft(currentUser.id, currentProblem.id);
            lastSavedSignatureRef.current = null;
            autoSaveEnabledRef.current = false;
          } catch (error) {
            showStatus('error', `草稿清理失败，可稍后重试：${error instanceof Error ? error.message : ''}`);
          }
        }
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
  }, [disabled, isRunning, isSubmitting, onSubmit, currentProblem, currentUser, setIsSubmitting, setLastSubmissionResult, addExecutionHistory, updateExecutionHistory, language, showStatus]);

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

      {draftModalOpen && (
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
          zIndex: 1100,
        }}>
          <div style={{
            background: '#2d2d2d',
            borderRadius: '8px',
            padding: '24px',
            maxWidth: '460px',
            width: '90%',
            border: '1px solid #444',
            boxShadow: '0 4px 20px rgba(0, 0, 0, 0.5)',
          }}>
            <h3 style={{ margin: '0 0 12px 0', color: '#fff', fontSize: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              📝 发现未提交的草稿
            </h3>

            {draftChecking ? (
              <p style={{ margin: '0 0 20px 0', color: '#ccc', fontSize: '13px' }}>
                正在读取本地草稿...
              </p>
            ) : draftCheckError ? (
              <>
                <p style={{
                  margin: '0 0 12px 0',
                  color: '#f44336',
                  fontSize: '13px',
                  lineHeight: 1.6,
                  padding: '10px 12px',
                  background: 'rgba(244, 67, 54, 0.1)',
                  border: '1px solid rgba(244, 67, 54, 0.3)',
                  borderRadius: '6px',
                }}>
                  读取草稿失败：{draftCheckError}
                  <br />
                  可点击“重试”再次尝试；关闭后不会改动当前代码。
                </p>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
                  <button
                    onClick={handleDismissDraft}
                    disabled={draftBusy}
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
                    关闭
                  </button>
                  <button
                    onClick={handleRetryDraftCheck}
                    style={{
                      padding: '8px 16px',
                      borderRadius: '6px',
                      border: 'none',
                      background: '#2196f3',
                      color: '#fff',
                      cursor: 'pointer',
                      fontSize: '13px',
                      fontWeight: 500,
                    }}
                  >
                    重试
                  </button>
                </div>
              </>
            ) : pendingDraft ? (
              <>
                <p style={{ margin: '0 0 16px 0', color: '#ccc', fontSize: '13px', lineHeight: 1.6 }}>
                  该题目存在未提交且与初始模板不同的代码，是否恢复？
                </p>

                <div style={{
                  background: '#252525',
                  border: '1px solid #3a3a3a',
                  borderRadius: '6px',
                  padding: '12px 14px',
                  marginBottom: '16px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '10px',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <div style={{
                      width: '26px',
                      height: '26px',
                      borderRadius: '6px',
                      background: getLanguageConfig(pendingDraft.language).color,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: '#1e1e1e',
                      fontSize: '10px',
                      fontWeight: 800,
                      fontFamily: 'monospace',
                      flexShrink: 0,
                    }}>
                      {getLanguageConfig(pendingDraft.language).icon}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                      <span style={{ color: '#888', fontSize: '11px' }}>语言</span>
                      <span style={{ color: '#fff', fontSize: '13px', fontWeight: 600 }}>
                        {getLanguageConfig(pendingDraft.language).label}
                      </span>
                    </div>
                  </div>

                  <div style={{ height: '1px', background: '#333' }} />

                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontSize: '14px' }}>🕒</span>
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                      <span style={{ color: '#888', fontSize: '11px' }}>最后修改时间</span>
                      <span style={{ color: '#fff', fontSize: '12px', fontFamily: 'monospace' }}>
                        {formatDraftTime(pendingDraft.savedAt)}
                      </span>
                    </div>
                  </div>

                  {draftDiffStats && (
                    <>
                      <div style={{ height: '1px', background: '#333' }} />
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                        <span style={{ color: '#888', fontSize: '11px' }}>与初始模板的差异概况</span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '11px', fontFamily: 'monospace' }}>
                          <span style={{ color: '#4caf50', fontWeight: 700 }}>+{draftDiffStats.added} 行</span>
                          <span style={{ color: '#f44336', fontWeight: 700 }}>-{draftDiffStats.removed} 行</span>
                          <span style={{ color: '#888' }}>
                            {draftDiffStats.templateLines} → {draftDiffStats.draftLines} 行
                          </span>
                        </div>
                        <div style={{
                          height: '6px',
                          borderRadius: '3px',
                          background: '#1a1a1a',
                          display: 'flex',
                          overflow: 'hidden',
                        }}>
                          <div style={{
                            width: `${Math.min(100, (draftDiffStats.added / Math.max(1, draftDiffStats.draftLines)) * 100)}%`,
                            background: '#4caf50',
                          }} />
                          <div style={{
                            width: `${Math.min(100, (draftDiffStats.removed / Math.max(1, draftDiffStats.templateLines)) * 100)}%`,
                            background: '#f44336',
                            opacity: 0.7,
                          }} />
                        </div>
                      </div>
                    </>
                  )}
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
                  <button
                    onClick={handleDismissDraft}
                    disabled={draftBusy}
                    style={{
                      padding: '8px 14px',
                      borderRadius: '6px',
                      border: '1px solid #555',
                      background: 'transparent',
                      color: '#888',
                      cursor: draftBusy ? 'not-allowed' : 'pointer',
                      fontSize: '12px',
                    }}
                  >
                    暂不处理
                  </button>
                  <button
                    onClick={handleUseTemplate}
                    disabled={draftBusy}
                    style={{
                      padding: '8px 16px',
                      borderRadius: '6px',
                      border: '1px solid #555',
                      background: 'transparent',
                      color: '#ccc',
                      cursor: draftBusy ? 'not-allowed' : 'pointer',
                      fontSize: '13px',
                    }}
                  >
                    {draftBusy ? '处理中...' : '使用模板'}
                  </button>
                  <button
                    onClick={handleRestoreDraft}
                    disabled={draftBusy}
                    style={{
                      padding: '8px 16px',
                      borderRadius: '6px',
                      border: 'none',
                      background: '#2196f3',
                      color: '#fff',
                      cursor: draftBusy ? 'not-allowed' : 'pointer',
                      fontSize: '13px',
                      fontWeight: 500,
                    }}
                  >
                    {draftBusy ? '处理中...' : '恢复草稿'}
                  </button>
                </div>
              </>
            ) : null}
          </div>
        </div>
      )}

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ flex: lastRunResult || lastSubmissionResult ? '0 0 60%' : '1', overflow: 'hidden', minHeight: '200px' }}>
          <Editor
            height="100%"
            language={language}
            value={code}
            onChange={(v, ev) => {
              // isFlush 表示值由外部程序化设置（切语言/恢复草稿），不算用户编辑
              if (ev?.isFlush) return;
              handleEditorChange(v || '');
            }}
            theme="vs-dark"
            options={{
              fontSize: 14,
              minimap: { enabled: false },
              wordWrap: 'on',
              readOnly: disabled,
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
