import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { ReactNode } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Database,
  HardDrive,
  KeyRound,
  LogIn,
  Mic,
  Pencil,
  Plus,
  QrCode,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Gauge,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';
import { Button } from '../components/ui/Button';
import { Layout } from '../components/Layout';
import { PageHeader } from '../components/ui/PageHeader';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { ToutiaoLoginPanel } from '../components/ToutiaoLoginPanel';
import { DouyinLoginPanel } from '../components/DouyinLoginPanel';
import { RuntimeEnvironmentPanel } from '../components/RuntimeEnvironmentPanel';
import { RuntimeStatusList } from '../components/RuntimeStatusList';
import { XhsLoginPanel } from '../components/XhsLoginPanel';
import { WechatSettingsPanel } from '../components/WechatSettingsPanel';
import { useRuntimeStatus } from '../hooks/useRuntimeStatus';
import { apiClient } from '../services/api';
import { parseOutputLimit, toOutputLimitForm, type OutputLimitMode } from '../utils/ai-output-limit';
import { loginSectionOf, settingsSections } from '../utils/settingsSections';
import type { AiProvider } from '../types';

interface AIKeyConfig {
  id: string;
  name: string;
  provider: AiProvider;
  apiKey: string;
  baseURL?: string;
  model: string;
  isActive: boolean;
  isValid?: boolean;
  lastTested?: string;
  maxOutputTokens?: number;
}

type AIKeyForm = {
  name: string;
  provider: AiProvider;
  apiKey: string;
  baseURL: string;
  model: string;
  maxOutputMode: OutputLimitMode;
  maxOutputTokens: string;
};

type AIKeyTestResult = { valid: boolean; code?: string; error?: string; testedAt?: string };

const emptyKeyForm = (): AIKeyForm => ({
  name: '',
  provider: 'deepseek',
  apiKey: '',
  baseURL: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  maxOutputMode: 'automatic',
  maxOutputTokens: '8192',
});

const toKeyPayload = (key: AIKeyForm) => ({
  name: key.name,
  provider: key.provider,
  apiKey: key.apiKey,
  baseURL: key.baseURL,
  model: key.model,
});

type SettingsSection = (typeof settingsSections)[number]['id'];

const settingsSectionIcons: Record<SettingsSection, typeof KeyRound> = {
  models: KeyRound,
  runtime: Gauge,
  douyin: QrCode,
  toutiao: QrCode,
  xhs: QrCode,
  wechat: KeyRound,
  asr: Mic,
  storage: HardDrive,
  advanced: SlidersHorizontal,
};

export function SettingsPage() {
  const [params, setParams] = useSearchParams();
  const [apiKeys, setApiKeys] = useState<AIKeyConfig[]>([]);
  const activeSection = (() => {
    /*
     * 支持 `?section=runtime` 这类锚点：发布中心概览条的「查看」与「去登录」都靠它把
     * 用户直接送到该看的那一组，而不是丢在设置页首页让他自己找。
     * 不认识的取值一律回落到默认（不制造空白页）。
     */
    const requested = params.get('section');
    const known = settingsSections.some((section) => section.id === requested);
    return known ? (requested as SettingsSection) : 'models';
  })();
  const setActiveSection = (value: SettingsSection) => { const next = new URLSearchParams(params); next.set('section', value); setParams(next, { replace: true }); };
  const [isAdding, setIsAdding] = useState(false);
  const [newKey, setNewKey] = useState<AIKeyForm>(emptyKeyForm);
  const [editingKeyId, setEditingKeyId] = useState<string | null>(null);
  const [testingKeyId, setTestingKeyId] = useState<string | null>(null);
  const [keyResults, setKeyResults] = useState<Record<string, AIKeyTestResult>>({});
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<AIKeyTestResult | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [removeKeyTarget, setRemoveKeyTarget] = useState<string | null>(null);
  const [removeKeyBusy, setRemoveKeyBusy] = useState(false);
  const [keyActionError, setKeyActionError] = useState<string | null>(null);

  useEffect(() => {
    loadApiKeys();
  }, []);

  const loadApiKeys = async () => {
    try {
      const config = await window.electron.getConfig();
      setApiKeys(config.aiKeys || []);
    } catch (error) {
      console.error('Failed to load API keys:', error);
    }
  };

  const handleProviderChange = (provider: AiProvider) => {
    setNewKey({
      ...newKey,
      provider,
      baseURL:
        provider === 'deepseek'
          ? 'https://api.deepseek.com'
          : provider === 'openai'
          ? 'https://api.openai.com/v1'
          : newKey.baseURL || '',
      model:
        provider === 'deepseek'
          ? 'deepseek-chat'
          : provider === 'openai'
          ? 'gpt-4o'
          : newKey.model,
    });
    setTestResult(null);
  };

  const handleTest = async () => {
    if (!newKey.apiKey) {
      setTestResult({ valid: false, error: '请输入 API Key' });
      return;
    }

    setIsTesting(true);
    setTestResult(null);

    try {
      const maxOutputTokens = parseOutputLimit(newKey.maxOutputMode, newKey.maxOutputTokens);
      const result = await window.electron.testApiKey({
        ...toKeyPayload(newKey),
        ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      });
      setTestResult(result);
    } catch (error) {
      setTestResult({
        valid: false,
        error: error instanceof Error ? error.message : '测试失败',
      });
    } finally {
      setIsTesting(false);
    }
  };

  const handleAdd = async () => {
    if (!newKey.name || !newKey.apiKey) {
      setTestResult({ valid: false, error: '请填写完整信息' });
      return;
    }

    if (!testResult?.valid) {
      setTestResult({ valid: false, error: '请先测试 API Key' });
      return;
    }

    setIsSaving(true);

    try {
      const maxOutputTokens = parseOutputLimit(newKey.maxOutputMode, newKey.maxOutputTokens);
      await window.electron.addApiKey({
        ...toKeyPayload(newKey),
        ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      });
      await loadApiKeys();
      closeKeyForm();
    } catch (error) {
      setTestResult({
        valid: false,
        error: error instanceof Error ? error.message : '添加失败',
      });
    } finally {
      setIsSaving(false);
    }
  };

  const startAdding = () => {
    setEditingKeyId(null);
    setNewKey(emptyKeyForm());
    setTestResult(null);
    setIsAdding(true);
  };

  const startEditing = (key: AIKeyConfig) => {
    const outputLimit = toOutputLimitForm(key.maxOutputTokens);
    setEditingKeyId(key.id);
    setNewKey({
      name: key.name,
      provider: key.provider,
      apiKey: '',
      baseURL: key.baseURL || '',
      model: key.model,
      maxOutputMode: outputLimit.mode,
      maxOutputTokens: outputLimit.value,
    });
    setTestResult(null);
    setIsAdding(true);
  };

  const closeKeyForm = () => {
    setIsAdding(false);
    setEditingKeyId(null);
    setNewKey(emptyKeyForm());
    setTestResult(null);
  };

  const handleUpdate = async () => {
    if (!editingKeyId || !newKey.name || !newKey.model || (newKey.provider === 'custom' && !newKey.baseURL)) {
      setTestResult({ valid: false, error: '请填写完整信息' });
      return;
    }
    setIsSaving(true);
    setTestResult(null);
    try {
      const maxOutputTokens = parseOutputLimit(newKey.maxOutputMode, newKey.maxOutputTokens);
      await window.electron.updateApiKey(editingKeyId, {
        ...toKeyPayload(newKey),
        maxOutputTokens: maxOutputTokens ?? null,
      });
      await loadApiKeys();
      closeKeyForm();
    } catch (error) {
      setTestResult({ valid: false, error: error instanceof Error ? error.message : '更新失败' });
    } finally {
      setIsSaving(false);
    }
  };

  const handleRetest = async (keyId: string) => {
    setTestingKeyId(keyId);
    try {
      const result = await window.electron.retestApiKey(keyId);
      setKeyResults((current) => ({ ...current, [keyId]: result }));
      await loadApiKeys();
    } catch (error) {
      setKeyResults((current) => ({
        ...current,
        [keyId]: { valid: false, error: error instanceof Error ? error.message : '测试失败' },
      }));
    } finally {
      setTestingKeyId(null);
    }
  };

  const handleRemove = async () => {
    if (!removeKeyTarget) return;
    const keyId = removeKeyTarget;
    setRemoveKeyBusy(true);
    try {
      await window.electron.removeApiKey(keyId);
      setRemoveKeyTarget(null);
      await loadApiKeys();
    } catch (error) {
      setKeyActionError('删除失败：' + (error instanceof Error ? error.message : '未知错误'));
    } finally {
      setRemoveKeyBusy(false);
    }
  };

  const handleSetActive = async (keyId: string) => {
    setTestingKeyId(keyId);
    try {
      await window.electron.setActiveApiKey(keyId);
      await loadApiKeys();
    } catch (error) {
      setKeyResults((current) => ({
        ...current,
        [keyId]: { valid: false, error: error instanceof Error ? error.message : '切换失败' },
      }));
    } finally {
      setTestingKeyId(null);
    }
  };

  return (
    <Layout>
      <PageHeader
        title="设置"
        description="配置 AI 模型、抖音登录、语音转录和本地创作资产。"
      />

      {/* 移动端：水平下拉选择 */}
      <div className="mb-6 lg:hidden">
        <select
          aria-label="设置分组"
          value={activeSection}
          onChange={(e) => setActiveSection(e.target.value as SettingsSection)}
          className="w-full rounded-lg border border-line-ui bg-well px-4 py-3 text-sm font-medium text-ink outline-none focus:border-accent-line focus:ring-1 focus:ring-accent"
        >
          {settingsSections.map((s) => (
            <option key={s.id} value={s.id}>{s.label} — {s.description}</option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="hidden lg:block rounded-lg border border-line bg-panel p-2">
          {settingsSections.map((section) => {
            const Icon = settingsSectionIcons[section.id];
            const active = activeSection === section.id;
            return (
              <button
                key={section.id}
                type="button"
                onClick={() => setActiveSection(section.id)}
                className={`mb-1 flex w-full items-start gap-3 rounded-lg px-3 py-3 text-left transition-all ${
                  active ? 'bg-accent-soft text-accent' : 'text-ink-muted hover:bg-elevated hover:text-ink'
                }`}
              >
                <Icon size={18} className="mt-0.5 shrink-0" />
                <span>
                  <span className="block text-sm font-semibold">{section.label}</span>
                  <span className="mt-0.5 block text-xs">{section.description}</span>
                </span>
              </button>
            );
          })}
        </aside>

        <main className="min-w-0">
          {activeSection === 'models' && (
            <ModelsSection
              apiKeys={apiKeys}
              isAdding={isAdding}
              editingKeyId={editingKeyId}
              testingKeyId={testingKeyId}
              keyResults={keyResults}
              newKey={newKey}
              setNewKey={setNewKey}
              testResult={testResult}
              setTestResult={setTestResult}
              isTesting={isTesting}
              isSaving={isSaving}
              onProviderChange={handleProviderChange}
              onTest={handleTest}
              onAdd={handleAdd}
              onUpdate={handleUpdate}
              onStartAdd={startAdding}
              onEdit={startEditing}
              onRetest={handleRetest}
              onCloseForm={closeKeyForm}
              setRemoveKeyTarget={setRemoveKeyTarget}
              onSetActive={handleSetActive}
            />
          )}
          {activeSection === 'runtime' && (
            <RuntimeEnvironmentPanel onGoToSection={(target) => setActiveSection(loginSectionOf(target))} />
          )}
          {activeSection === 'douyin' && <DouyinSection />}
          {activeSection === 'toutiao' && <ToutiaoSection />}
          {activeSection === 'xhs' && <XhsSection />}
          {activeSection === 'wechat' && <WechatSettingsPanel />}
          {activeSection === 'asr' && <AsrSection />}
          {activeSection === 'storage' && <StorageSection />}
          {activeSection === 'advanced' && <AdvancedSection />}
        </main>
      </div>
      <ConfirmDialog
        open={removeKeyTarget !== null}
        title="确定要删除这个 API Key 吗？"
        description="删除后依赖该密钥的功能将不可用。"
        confirmLabel="删除"
        tone="danger"
        busy={removeKeyBusy}
        onConfirm={handleRemove}
        onClose={() => setRemoveKeyTarget(null)}
      />

      {keyActionError && (
        <div className="fixed bottom-6 right-6 z-50 rounded-lg border border-danger-line bg-danger-soft px-4 py-3 text-sm text-danger shadow-lg">
          {keyActionError}
          <button className="ml-3 font-medium underline" onClick={() => setKeyActionError(null)}>
            关闭
          </button>
        </div>
      )}
    </Layout>
  );
}


function ModelsSection({
  apiKeys,
  isAdding,
  editingKeyId,
  testingKeyId,
  keyResults,
  newKey,
  setNewKey,
  testResult,
  setTestResult,
  isTesting,
  isSaving,
  onProviderChange,
  onTest,
  onAdd,
  onUpdate,
  onStartAdd,
  onEdit,
  onRetest,
  onCloseForm,
  setRemoveKeyTarget,
  onSetActive,
}: {
  apiKeys: AIKeyConfig[];
  isAdding: boolean;
  editingKeyId: string | null;
  testingKeyId: string | null;
  keyResults: Record<string, AIKeyTestResult>;
  newKey: AIKeyForm;
  setNewKey: (value: AIKeyForm) => void;
  testResult: AIKeyTestResult | null;
  setTestResult: (value: AIKeyTestResult | null) => void;
  isTesting: boolean;
  isSaving: boolean;
  onProviderChange: (provider: AiProvider) => void;
  onTest: () => void;
  onAdd: () => void;
  onUpdate: () => void;
  onStartAdd: () => void;
  onEdit: (key: AIKeyConfig) => void;
  onRetest: (keyId: string) => void;
  onCloseForm: () => void;
  setRemoveKeyTarget: (keyId: string) => void;
  onSetActive: (keyId: string) => void;
}) {
  return (
    <section className="space-y-6">
      <SectionHeader
        icon={KeyRound}
        title="AI 模型与密钥"
        description="管理 AI 洗稿使用的模型密钥。"
        action={
          /* 次要权重：同一屏里的主行动是空态里的「立即添加」。两个实心红按钮做同一件事
             等于没有主次（改造前两者都是 bg-accent）。 */
          <Button variant="outline" onClick={onStartAdd}>
            <Plus size={16} aria-hidden="true" />
            添加密钥
          </Button>
        }
      />

      {apiKeys.length === 0 && !isAdding ? (
        <div className="rounded-lg border border-dashed border-line bg-panel py-16 text-center">
          <KeyRound className="mx-auto mb-4 h-11 w-11 text-ai" />
          <h3 className="text-lg font-semibold text-ink">还没有 API 密钥</h3>
          <p className="mt-2 text-ink-muted">添加第一个密钥后即可创建视频作品。</p>
          <button
            onClick={onStartAdd}
            className="mt-6 inline-flex items-center gap-2 rounded-lg bg-accent px-5 py-2.5 font-medium text-on-accent transition-all hover:bg-accent-hover"
          >
            <Plus size={17} />
            立即添加
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {apiKeys.map((key) => (
            <div
              key={key.id}
              className={`rounded-lg border bg-panel p-5 transition-all ${
                key.isActive ? 'border-accent-line shadow-sm' : 'border-line'
              }`}
            >
              <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                <div className="min-w-0">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <h3 className="font-semibold text-ink">{key.name}</h3>
                    {key.isActive && (
                      <span className="inline-flex items-center gap-1 rounded bg-success-soft px-2 py-1 text-xs font-medium text-success">
                        <CheckCircle2 size={13} />
                        当前使用
                      </span>
                    )}
                    <span className="rounded bg-canvas px-2 py-1 text-xs text-ink-muted">
                      {getProviderLabel(key.provider)}
                    </span>
                  </div>
                  <p className="text-sm text-ink-muted">
                    模型：<code className="rounded bg-canvas px-2 py-0.5 text-ink">{key.model}</code>
                  </p>
                  <p className="mt-1 text-xs text-ink-muted">
                    输出上限：{key.maxOutputTokens === undefined ? '自动' : `${key.maxOutputTokens.toLocaleString('zh-CN')} Tokens`}
                  </p>
                  {key.baseURL && <p className="mt-1 break-all font-mono text-xs text-ink-muted">{key.baseURL}</p>}
                  <p className="mt-1 font-mono text-xs text-ink-muted">
                    密钥：{key.apiKey.slice(0, 8)}...{key.apiKey.slice(-4)}
                  </p>
                  <p className={`mt-2 text-xs ${key.isValid === true ? 'text-success' : key.isValid === false ? 'text-danger' : 'text-ink-muted'}`}>
                    {key.isValid === true ? '连接有效' : key.isValid === false ? '连接失效' : '尚未重新测试'}
                    {key.lastTested ? ` · ${new Date(key.lastTested).toLocaleString('zh-CN')}` : ''}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                  <button
                    onClick={() => onRetest(key.id)}
                    disabled={testingKeyId === key.id}
                    className="inline-flex items-center gap-1 rounded-lg border border-line px-3 py-2 text-sm font-medium text-ink transition-all hover:border-accent-line hover:text-accent disabled:opacity-50"
                  >
                    <RefreshCw size={15} className={testingKeyId === key.id ? 'animate-spin' : ''} />
                    重新测试
                  </button>
                  <button
                    onClick={() => onEdit(key)}
                    className="inline-flex items-center gap-1 rounded-lg border border-line px-3 py-2 text-sm font-medium text-ink transition-all hover:border-accent-line hover:text-accent"
                  >
                    <Pencil size={15} />
                    编辑
                  </button>
                  {!key.isActive && (
                    <button
                      onClick={() => onSetActive(key.id)}
                      disabled={testingKeyId === key.id}
                      className="rounded-lg border border-line px-3 py-2 text-sm font-medium text-ink transition-all hover:border-accent-line hover:text-accent"
                    >
                      设为当前
                    </button>
                  )}
                  <button
                    onClick={() => setRemoveKeyTarget(key.id)}
                    className="inline-flex items-center gap-1 rounded-lg border border-danger-line px-3 py-2 text-sm font-medium text-danger transition-all hover:bg-danger-soft"
                  >
                    <Trash2 size={15} />
                    删除
                  </button>
                </div>
              </div>
              {keyResults[key.id] && (
                <div className="mt-4">
                  <ResultBanner
                    valid={keyResults[key.id].valid}
                    message={keyResults[key.id].valid ? 'API 连接测试通过' : keyResults[key.id].error || '测试失败'}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {isAdding && (
        <div className="rounded-lg border border-line bg-panel p-6">
          <div className="mb-6 flex items-center justify-between">
            <h3 className="text-lg font-semibold text-ink">{editingKeyId ? '编辑 AI 配置' : '添加新密钥'}</h3>
            <button
              onClick={onCloseForm}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-muted transition-all hover:bg-elevated hover:text-ink"
              aria-label="关闭添加密钥"
            >
              <X size={18} />
            </button>
          </div>

          <div className="space-y-5">
            <FormField label="密钥名称" required>
              <input
                type="text"
                value={newKey.name}
                onChange={(event) => setNewKey({ ...newKey, name: event.target.value })}
                placeholder="例如：我的 DeepSeek 密钥"
                className={inputClassName}
              />
            </FormField>

            <div>
              <label className="mb-3 block text-sm font-medium text-ink">服务商</label>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {(['deepseek', 'openai', 'custom'] as const).map((provider) => (
                  <button
                    key={provider}
                    type="button"
                    onClick={() => onProviderChange(provider)}
                    className={`rounded-lg border px-4 py-3 text-sm font-medium transition-all ${
                      newKey.provider === provider
                        ? 'border-ai-line bg-ai-soft text-ai'
                        : 'border-line text-ink-muted hover:border-accent-line'
                    }`}
                  >
                    {getProviderLabel(provider)}
                  </button>
                ))}
              </div>
            </div>

            <FormField label="API Key" required={!editingKeyId}>
              <input
                type="password"
                value={newKey.apiKey}
                onChange={(event) => {
                  setNewKey({ ...newKey, apiKey: event.target.value });
                  setTestResult(null);
                }}
                placeholder={editingKeyId ? '留空则保留原 API Key' : 'sk-...'}
                className={`${inputClassName} font-mono text-sm`}
              />
            </FormField>

            {newKey.provider === 'custom' && (
              <FormField label="API 地址">
                <input
                  type="text"
                  value={newKey.baseURL}
                  onChange={(event) => {
                    setNewKey({ ...newKey, baseURL: event.target.value });
                    setTestResult(null);
                  }}
                  placeholder="https://api.example.com/v1"
                  className={`${inputClassName} font-mono text-sm`}
                />
              </FormField>
            )}

            <FormField label="模型">
              <input
                type="text"
                value={newKey.model}
                onChange={(event) => {
                  setNewKey({ ...newKey, model: event.target.value });
                  setTestResult(null);
                }}
                placeholder="模型 ID"
                className={`${inputClassName} font-mono text-sm`}
              />
            </FormField>

            <FormField label="创作输出 Token 上限">
              <div className="inline-flex rounded-lg border border-line bg-canvas p-1">
                {(['automatic', 'custom'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setNewKey({ ...newKey, maxOutputMode: mode })}
                    className={mode === newKey.maxOutputMode
                      ? 'rounded-md bg-panel px-3 py-2 text-sm font-medium text-ink shadow-sm'
                      : 'rounded-md px-3 py-2 text-sm font-medium text-ink-muted transition-colors hover:text-ink'}
                  >
                    {mode === 'automatic' ? '自动' : '自定义'}
                  </button>
                ))}
              </div>
              {newKey.maxOutputMode === 'custom' && (
                <input
                  type="number"
                  min={256}
                  step={1}
                  value={newKey.maxOutputTokens}
                  onChange={(event) => setNewKey({ ...newKey, maxOutputTokens: event.target.value })}
                  className={`${inputClassName} mt-3`}
                />
              )}
              <p className="mt-2 text-xs leading-5 text-ink-muted">
                仅用于 AI 洗稿和生成分镜。自动模式不由应用限制；自定义值最终仍受模型和中转服务限制。
              </p>
            </FormField>

            {testResult && (
              <ResultBanner valid={testResult.valid} message={testResult.valid ? 'API Key 有效' : testResult.error || '测试失败'} />
            )}

            <div className="flex justify-end gap-3 pt-2">
              {!editingKeyId && (
                <button
                  onClick={onTest}
                  disabled={isTesting || !newKey.apiKey}
                  className="rounded-lg border border-line px-5 py-2.5 font-medium text-ink transition-all hover:bg-elevated disabled:opacity-50"
                >
                  {isTesting ? '测试中...' : '测试连接'}
                </button>
              )}
              <button
                onClick={editingKeyId ? onUpdate : onAdd}
                disabled={isSaving || (!editingKeyId && !testResult?.valid)}
                className="rounded-lg bg-accent px-5 py-2.5 font-medium text-on-accent transition-all hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isSaving ? '测试并保存中...' : editingKeyId ? '测试并保存' : '保存密钥'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function AsrSection() {
  return (
    <section className="space-y-6">
      <SectionHeader
        icon={Mic}
        title="语音转录"
        description="视频转录由软件内置 Whisper 本地完成。"
      />

      <div className="rounded-lg border border-line bg-panel p-6">
        <div className="space-y-4">
          <div className="rounded-lg border border-success-line bg-success-soft p-4 text-sm text-success">
            <div className="flex items-start gap-3">
              <AlertCircle size={18} className="mt-0.5 shrink-0" />
              <div>
                <p className="font-semibold">内置 Whisper 本地转录</p>
                <p className="mt-1 leading-6">
                  软件会随安装包携带 whisper.cpp 和 ggml-small 多语言模型。视频转录在本机完成，不需要 ASR API Key、Python、FunASR 或 faster-whisper。
                </p>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <StorageCard title="转录引擎" value="whisper.cpp" />
            <StorageCard title="内置模型" value="ggml-small" />
            <StorageCard title="运行方式" value="本地离线" />
          </div>
        </div>
      </div>
    </section>
  );
}

function StorageSection() {
  return (
    <section className="space-y-6">
      <SectionHeader
        icon={HardDrive}
        title="存储位置"
        description="本地作品、素材和输出文件会保存到用户文档目录。"
      />
      <div className="rounded-lg border border-line bg-panel p-6">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <StorageCard title="原始素材" value="~/Documents/抖音AI视频/raw" />
          <StorageCard title="处理产物" value="~/Documents/抖音AI视频/processed" />
          <StorageCard title="视频输出" value="~/Documents/抖音AI视频/output/videos" />
          <StorageCard title="日志" value="~/Documents/抖音AI视频/logs" />
        </div>
      </div>
    </section>
  );
}

function AdvancedSection() {
  return (
    <section className="space-y-6">
      <SectionHeader
        icon={SlidersHorizontal}
        title="高级选项"
        description="安全策略、运行诊断和本地数据管理。"
      />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <InfoCard
          icon={ShieldCheck}
          title="本地密钥存储"
          description="API Key 仅保存在本机配置中，切换当前密钥后会立即影响后续任务。"
        />
        <InfoCard
          icon={Database}
          title="处理链路"
          description="视频、音频、转录、洗稿、提示词和成片按任务 ID 保存，删除后会先进入垃圾桶。"
        />
      </div>

      {/* 危险区域：数据恢复与重置 */}
      <div className="rounded-lg border border-danger-line bg-danger-soft p-6">
        <div className="flex items-start gap-3 mb-4">
          <AlertTriangle size={20} className="text-danger shrink-0 mt-0.5" />
          <div>
            <h3 className="text-lg font-semibold text-danger">恢复与重置</h3>
            <p className="mt-1 text-sm text-danger">
              以下操作不可撤销，请在执行前确认已备份重要数据。
            </p>
          </div>
        </div>
        <div className="space-y-3">
          <div className="rounded-lg border border-danger-line bg-panel p-4 flex items-center justify-between">
            <div>
              <p className="font-medium text-ink">重置所有本地数据</p>
              <p className="text-xs text-ink-muted mt-0.5">清除所有任务、合集、发布包和 Skill，保留 API Key 和配置</p>
            </div>
            <button
              type="button"
              disabled
              title="此功能将在后续版本中提供"
              className="inline-flex items-center gap-1.5 rounded-lg border border-danger-line px-3 py-2 text-sm font-medium text-danger cursor-not-allowed transition-colors"
            >
              <Trash2 size={14} />
              暂不可用
            </button>
          </div>
          <div className="rounded-lg border border-danger-line bg-panel p-4 flex items-center justify-between">
            <div>
              <p className="font-medium text-ink">清除缓存和临时文件</p>
              <p className="text-xs text-ink-muted mt-0.5">清除下载缓存、临时处理文件和日志</p>
            </div>
            <button
              type="button"
              disabled
              title="此功能将在后续版本中提供"
              className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-2 text-sm font-medium text-ink-muted cursor-not-allowed transition-colors"
            >
              <RefreshCw size={14} />
              暂不可用
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function SectionHeader({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: typeof KeyRound;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 rounded-lg border border-line bg-panel p-5 md:flex-row md:items-center md:justify-between">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-ai-soft text-ai">
          <Icon size={20} />
        </span>
        <div>
          <h3 className="text-lg font-semibold text-ink">{title}</h3>
          <p className="mt-1 text-sm text-ink-muted">{description}</p>
        </div>
      </div>
      {action}
    </div>
  );
}

function FormField({ label, required, hint, children }: { label: string; required?: boolean; hint?: string; children: ReactNode }) {
  /*
   * 改造前 `<label>` 与控件是**兄弟节点**且没有 `htmlFor`，于是四个输入框
   * （接口地址 / API Key / 模型名 / 存储位置）都**没有可访问名** —— 读屏只念「编辑框」，
   * 点标签文字也不会聚焦到输入框。
   * 现在用**包裹式 label**（隐式关联，不必给每个调用点补 id）；
   * hint 留在 label 之外，避免被算进可访问名里变成一长串。
   */
  return (
    <div>
      <label className="block">
        <span className="mb-2 block text-sm font-medium text-ink">
          {label} {required && <span className="text-danger">*</span>}
        </span>
        {children}
      </label>
      {hint && <p className="mt-1 text-xs text-ink-muted">{hint}</p>}
    </div>
  );
}

function ResultBanner({ valid, message }: { valid: boolean; message: string }) {
  /* 保存在/测试结果是异步出现的：成功走 status（礼貌播报），失败走 alert（立即播报）。 */
  return (
    <div
      role={valid ? 'status' : 'alert'}
      className={`flex items-center gap-2 rounded-lg border p-3 text-sm ${valid ? 'border-success-line bg-success-soft text-success' : 'border-danger-line bg-danger-soft text-danger'}`}
    >
      {valid ? <CheckCircle2 size={17} aria-hidden="true" /> : <XCircle size={17} aria-hidden="true" />}
      {message}
    </div>
  );
}

function StorageCard({ title, value }: { title: string; value: string }) {
  return (
    <div className="rounded-lg bg-canvas p-4">
      <p className="text-sm font-semibold text-ink">{title}</p>
      <p className="mt-2 break-all font-mono text-xs text-ink-muted">{value}</p>
    </div>
  );
}

function InfoCard({ icon: Icon, title, description }: { icon: typeof ShieldCheck; title: string; description: string }) {
  return (
    <div className="rounded-lg border border-line bg-panel p-5">
      <Icon className="mb-4 h-8 w-8 text-ai" />
      <h3 className="font-semibold text-ink">{title}</h3>
      <p className="mt-2 text-sm leading-6 text-ink-muted">{description}</p>
    </div>
  );
}

function getProviderLabel(provider: AIKeyConfig['provider']) {
  if (provider === 'deepseek') return 'DeepSeek';
  if (provider === 'openai') return 'OpenAI';
  return '第三方';
}

// ─── 手动 Cookie 输入组件 ──────────────────────────────────────

function ManualCookieInput({ onSaved }: { onSaved: () => void }) {
  const [cookie, setCookie] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const handleSave = async () => {
    if (!cookie.trim()) return;
    setSaving(true);
    setMsg(null);
    try {
      const r = await apiClient.saveCookie(cookie.trim());
      setMsg({ ok: r.success && r.hasAuth, text: r.message });
      if (r.success) { setCookie(""); onSaved(); }
    } catch (err: any) {
      setMsg({ ok: false, text: err.response?.data?.message || err.message || "保存失败" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <textarea
        value={cookie}
        onChange={(e) => setCookie(e.target.value)}
        placeholder="sessionid=xxx; sid_guard=xxx; passport_csrf_token=xxx; ..."
        disabled={saving}
        rows={3}
        className="w-full rounded-lg border border-line-ui bg-well px-4 py-3 text-sm font-mono text-ink placeholder-ink-muted outline-none transition-all focus:border-accent-line focus:ring-2 focus:ring-accent resize-y"
      />
      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={saving || !cookie.trim()}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-on-accent transition-all hover:bg-info disabled:opacity-50"
        >
          {saving ? "保存中..." : "保存 Cookie"}
        </button>
        {msg && (
          <span className={`text-sm ${msg.ok ? "text-success" : "text-danger"}`}>{msg.text}</span>
        )}
      </div>
    </div>
  );
}

// ─── 抖音扫码登录 ──────────────────────────────────────────────

/**
 * 今日头条（头条号）登录区。
 *
 * 头条号**没有可手工粘贴的凭据**（登录态是浏览器 profile），所以这里只有一条路：应用内扫码。
 * 与抖音那套「打开浏览器窗口扫码」不同 —— 后端用内置无头浏览器取二维码，界面直接显示。
 */
function ToutiaoSection() {
  return (
    <div className="space-y-4">
      <SectionHeader
        icon={QrCode}
        title="今日头条"
        description="头条号登录态保存在本机，用今日头条 App 扫码一次即可（不需要重启应用）。"
      />
      <div className="rounded-xl border border-line bg-panel p-4">
        <ToutiaoLoginPanel />
      </div>
    </div>
  );
}

/**
 * 小红书登录区。
 *
 * 与抖音/头条同一条交互（应用内扫码 + 打开浏览器窗口扫码 + 零副作用自检）。
 * ⚠️ 这里**只有登录**：本工具不读取笔记、不搜索、不评论、不点赞收藏（spec §12）。
 */
function XhsSection() {
  return (
    <div className="space-y-4">
      <SectionHeader
        icon={QrCode}
        title="小红书"
        description="登录态保存在本机，用小红书 App 扫码一次即可（不需要重启应用）。"
      />
      <div className="rounded-xl border border-line bg-panel p-4">
        <XhsLoginPanel />
      </div>
    </div>
  );
}

function DouyinSection() {
  /*
   * 状态从**运行环境**那份模型来（同一份数据、同一个组件、只是 compact 尺寸）——
   * 决策 ⑤ 选 A 时的缓解措施：常驻状态只有一个家，这行不是「第二份实现」。
   */
  const { status: runtimeStatus, refresh } = useRuntimeStatus();
  const douyin = runtimeStatus?.channels.find((item) => item.id === 'douyin');
  /** 凭据文件的真实位置由服务端下发（`evidence.paths`），界面不自己拼路径。 */
  const credentialPath = douyin?.evidence?.paths?.find((entry) => entry.label === '凭据文件')?.value;

  return (
    <section className="space-y-6">
      <SectionHeader
        icon={QrCode}
        title="抖音登录"
        description="扫码登录抖音。⚠️ 这份凭据**采集与发布共用同一份**；发布侧现在能不能用，以「运行环境」里带时间戳的验证结论为准。"
      />

      {/* 紧凑状态行（状态的真源在「运行环境」，这里只是同一实现的紧凑尺寸） */}
      {douyin ? (
        <RuntimeStatusList items={[douyin]} variant="compact" now={new Date()} />
      ) : (
        <p className="text-sm text-ink-muted">正在读取登录状态…</p>
      )}

      {/* 应用内二维码与可选的浏览器扫码备用入口 */}
      <div className="rounded-lg border border-line bg-panel p-6">
        <h3 className="text-lg font-semibold text-ink mb-4">扫码登录</h3>
        <DouyinLoginPanel onLoggedIn={() => void refresh()} />
      </div>

      {/* Manual cookie input */}
      <div className="rounded-lg border border-line bg-panel p-6">
        <h3 className="text-sm font-semibold text-ink mb-3">手动粘贴 Cookie</h3>
        <p className="text-sm text-ink-muted leading-relaxed mb-3">
          在 Chrome 中打开抖音并登录，然后按 <kbd className="px-1.5 py-0.5 rounded bg-canvas text-xs">F12</kbd> 打开 DevTools，
          进入 <strong>Application</strong> → <strong>Cookies</strong> → <strong>douyin.com</strong>，
          将下方格式的 Cookie 字符串粘贴到输入框中保存。
        </p>
        <ManualCookieInput onSaved={() => void refresh()} />
        <p className="mt-3 text-sm text-ink-muted">
          保存位置：<code className="bg-canvas px-2 py-0.5 rounded text-xs select-all">{credentialPath || '~/.douyin-ai-video/douyin-cookie.txt'}</code>
        </p>
      </div>
    </section>
  );
}

const inputClassName =
  'w-full rounded-lg border border-line-ui bg-well px-4 py-3 text-ink placeholder-ink-muted outline-none transition-all focus:border-accent-line focus:ring-2 focus:ring-accent';
