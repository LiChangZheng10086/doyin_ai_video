import { useState, useEffect } from 'react';
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
  Trash2,
  X,
  XCircle,
} from 'lucide-react';
import { Layout } from '../components/Layout';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { LocalUsersSettings } from '../components/LocalUsersSettings';
import { apiClient } from '../services/api';
import { settingsSections } from '../utils/localUsers';

interface AIKeyConfig {
  id: string;
  name: string;
  provider: 'deepseek' | 'openai' | 'custom';
  apiKey: string;
  baseURL?: string;
  model: string;
  isActive: boolean;
  isValid?: boolean;
  lastTested?: string;
}

type AIKeyForm = {
  name: string;
  provider: 'deepseek' | 'openai' | 'custom';
  apiKey: string;
  baseURL: string;
  model: string;
};

type AIKeyTestResult = { valid: boolean; code?: string; error?: string; testedAt?: string };

const emptyKeyForm = (): AIKeyForm => ({
  name: '',
  provider: 'deepseek',
  apiKey: '',
  baseURL: 'https://api.deepseek.com',
  model: 'deepseek-chat',
});

type SettingsSection = (typeof settingsSections)[number]['id'];

const settingsSectionIcons: Record<SettingsSection, typeof KeyRound> = {
  models: KeyRound,
  douyin: QrCode,
  asr: Mic,
  storage: HardDrive,
  users: ShieldCheck,
  advanced: SlidersHorizontal,
};

export function SettingsPage() {
  const [apiKeys, setApiKeys] = useState<AIKeyConfig[]>([]);
  const [activeSection, setActiveSection] = useState<SettingsSection>('models');
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

  const handleProviderChange = (provider: 'deepseek' | 'openai' | 'custom') => {
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
      const result = await window.electron.testApiKey(newKey);
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
      await window.electron.addApiKey(newKey);
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
    setEditingKeyId(key.id);
    setNewKey({
      name: key.name,
      provider: key.provider,
      apiKey: '',
      baseURL: key.baseURL || '',
      model: key.model,
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
      await window.electron.updateApiKey(editingKeyId, newKey);
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
      <div className="mb-8">
        <h2 className="text-2xl font-semibold text-tech-text">设置</h2>
        <p className="mt-1 text-sm text-tech-muted">配置 AI 模型、抖音登录、语音转录和本地创作资产。</p>
      </div>

      {/* 移动端：水平下拉选择 */}
      <div className="mb-6 lg:hidden">
        <select
          value={activeSection}
          onChange={(e) => setActiveSection(e.target.value as SettingsSection)}
          className="w-full rounded-lg border border-tech-border bg-tech-surface px-4 py-3 text-sm font-medium text-tech-text outline-none focus:border-tech-blue focus:ring-1 focus:ring-tech-blue"
        >
          {settingsSections.map((s) => (
            <option key={s.id} value={s.id}>{s.label} — {s.description}</option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="hidden lg:block rounded-lg border border-tech-border bg-tech-surface p-2">
          {settingsSections.map((section) => {
            const Icon = settingsSectionIcons[section.id];
            const active = activeSection === section.id;
            return (
              <button
                key={section.id}
                type="button"
                onClick={() => setActiveSection(section.id)}
                className={`mb-1 flex w-full items-start gap-3 rounded-lg px-3 py-3 text-left transition-all ${
                  active ? 'bg-blue-50 text-tech-blue' : 'text-tech-muted hover:bg-tech-bg hover:text-tech-text'
                }`}
              >
                <Icon size={18} className="mt-0.5 shrink-0" />
                <span>
                  <span className="block text-sm font-semibold">{section.label}</span>
                  <span className="mt-0.5 block text-xs opacity-80">{section.description}</span>
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
          {activeSection === 'douyin' && <DouyinSection />}
          {activeSection === 'asr' && <AsrSection />}
          {activeSection === 'storage' && <StorageSection />}
          {activeSection === 'users' && <LocalUsersSettings />}
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
        <div className="fixed bottom-6 right-6 z-50 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 shadow-lg">
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
  onProviderChange: (provider: 'deepseek' | 'openai' | 'custom') => void;
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
          <button
            onClick={onStartAdd}
            className="inline-flex items-center gap-2 rounded-lg bg-tech-blue px-4 py-2 text-sm font-medium text-white transition-all hover:bg-tech-blue-dark"
          >
            <Plus size={16} />
            添加密钥
          </button>
        }
      />

      {apiKeys.length === 0 && !isAdding ? (
        <div className="rounded-lg border border-dashed border-tech-border bg-tech-surface py-16 text-center">
          <KeyRound className="mx-auto mb-4 h-11 w-11 text-tech-purple" />
          <h3 className="text-lg font-semibold text-tech-text">还没有 API 密钥</h3>
          <p className="mt-2 text-tech-muted">添加第一个密钥后即可创建视频作品。</p>
          <button
            onClick={onStartAdd}
            className="mt-6 inline-flex items-center gap-2 rounded-lg bg-tech-blue px-5 py-2.5 font-medium text-white transition-all hover:bg-tech-blue-dark"
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
              className={`rounded-lg border bg-tech-surface p-5 transition-all ${
                key.isActive ? 'border-tech-blue shadow-sm' : 'border-tech-border'
              }`}
            >
              <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                <div className="min-w-0">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <h3 className="font-semibold text-tech-text">{key.name}</h3>
                    {key.isActive && (
                      <span className="inline-flex items-center gap-1 rounded bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700">
                        <CheckCircle2 size={13} />
                        当前使用
                      </span>
                    )}
                    <span className="rounded bg-tech-bg px-2 py-1 text-xs text-tech-muted">
                      {getProviderLabel(key.provider)}
                    </span>
                  </div>
                  <p className="text-sm text-tech-muted">
                    模型：<code className="rounded bg-tech-bg px-2 py-0.5 text-tech-text">{key.model}</code>
                  </p>
                  {key.baseURL && <p className="mt-1 break-all font-mono text-xs text-tech-muted">{key.baseURL}</p>}
                  <p className="mt-1 font-mono text-xs text-tech-muted">
                    密钥：{key.apiKey.slice(0, 8)}...{key.apiKey.slice(-4)}
                  </p>
                  <p className={`mt-2 text-xs ${key.isValid === true ? 'text-emerald-600' : key.isValid === false ? 'text-red-600' : 'text-tech-muted'}`}>
                    {key.isValid === true ? '连接有效' : key.isValid === false ? '连接失效' : '尚未重新测试'}
                    {key.lastTested ? ` · ${new Date(key.lastTested).toLocaleString('zh-CN')}` : ''}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                  <button
                    onClick={() => onRetest(key.id)}
                    disabled={testingKeyId === key.id}
                    className="inline-flex items-center gap-1 rounded-lg border border-tech-border px-3 py-2 text-sm font-medium text-tech-text transition-all hover:border-tech-blue hover:text-tech-blue disabled:opacity-50"
                  >
                    <RefreshCw size={15} className={testingKeyId === key.id ? 'animate-spin' : ''} />
                    重新测试
                  </button>
                  <button
                    onClick={() => onEdit(key)}
                    className="inline-flex items-center gap-1 rounded-lg border border-tech-border px-3 py-2 text-sm font-medium text-tech-text transition-all hover:border-tech-blue hover:text-tech-blue"
                  >
                    <Pencil size={15} />
                    编辑
                  </button>
                  {!key.isActive && (
                    <button
                      onClick={() => onSetActive(key.id)}
                      disabled={testingKeyId === key.id}
                      className="rounded-lg border border-tech-border px-3 py-2 text-sm font-medium text-tech-text transition-all hover:border-tech-blue hover:text-tech-blue"
                    >
                      设为当前
                    </button>
                  )}
                  <button
                    onClick={() => setRemoveKeyTarget(key.id)}
                    className="inline-flex items-center gap-1 rounded-lg border border-red-200 px-3 py-2 text-sm font-medium text-red-600 transition-all hover:bg-red-50"
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
        <div className="rounded-lg border border-tech-border bg-tech-surface p-6">
          <div className="mb-6 flex items-center justify-between">
            <h3 className="text-lg font-semibold text-tech-text">{editingKeyId ? '编辑 AI 配置' : '添加新密钥'}</h3>
            <button
              onClick={onCloseForm}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-tech-muted transition-all hover:bg-tech-bg hover:text-tech-text"
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
              <label className="mb-3 block text-sm font-medium text-tech-text">服务商</label>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {(['deepseek', 'openai', 'custom'] as const).map((provider) => (
                  <button
                    key={provider}
                    type="button"
                    onClick={() => onProviderChange(provider)}
                    className={`rounded-lg border px-4 py-3 text-sm font-medium transition-all ${
                      newKey.provider === provider
                        ? 'border-tech-purple bg-purple-50 text-tech-purple'
                        : 'border-tech-border text-tech-muted hover:border-tech-blue'
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

            {testResult && (
              <ResultBanner valid={testResult.valid} message={testResult.valid ? 'API Key 有效' : testResult.error || '测试失败'} />
            )}

            <div className="flex justify-end gap-3 pt-2">
              {!editingKeyId && (
                <button
                  onClick={onTest}
                  disabled={isTesting || !newKey.apiKey}
                  className="rounded-lg border border-tech-border px-5 py-2.5 font-medium text-tech-text transition-all hover:bg-tech-bg disabled:opacity-50"
                >
                  {isTesting ? '测试中...' : '测试连接'}
                </button>
              )}
              <button
                onClick={editingKeyId ? onUpdate : onAdd}
                disabled={isSaving || (!editingKeyId && !testResult?.valid)}
                className="rounded-lg bg-tech-blue px-5 py-2.5 font-medium text-white transition-all hover:bg-tech-blue-dark disabled:cursor-not-allowed disabled:opacity-50"
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

      <div className="rounded-lg border border-tech-border bg-tech-surface p-6">
        <div className="space-y-4">
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-700">
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
      <div className="rounded-lg border border-tech-border bg-tech-surface p-6">
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
      <div className="rounded-lg border border-red-200 bg-red-50 p-6">
        <div className="flex items-start gap-3 mb-4">
          <AlertTriangle size={20} className="text-red-600 shrink-0 mt-0.5" />
          <div>
            <h3 className="text-lg font-semibold text-red-700">恢复与重置</h3>
            <p className="mt-1 text-sm text-red-600">
              以下操作不可撤销，请在执行前确认已备份重要数据。
            </p>
          </div>
        </div>
        <div className="space-y-3">
          <div className="rounded-lg border border-red-200 bg-white p-4 flex items-center justify-between">
            <div>
              <p className="font-medium text-tech-text">重置所有本地数据</p>
              <p className="text-xs text-tech-muted mt-0.5">清除所有任务、合集、发布包和 Skill，保留 API Key 和配置</p>
            </div>
            <button
              type="button"
              disabled
              title="此功能将在后续版本中提供"
              className="inline-flex items-center gap-1.5 rounded-lg border border-red-300 px-3 py-2 text-sm font-medium text-red-400 cursor-not-allowed transition-colors"
            >
              <Trash2 size={14} />
              暂不可用
            </button>
          </div>
          <div className="rounded-lg border border-red-200 bg-white p-4 flex items-center justify-between">
            <div>
              <p className="font-medium text-tech-text">清除缓存和临时文件</p>
              <p className="text-xs text-tech-muted mt-0.5">清除下载缓存、临时处理文件和日志</p>
            </div>
            <button
              type="button"
              disabled
              title="此功能将在后续版本中提供"
              className="inline-flex items-center gap-1.5 rounded-lg border border-tech-border px-3 py-2 text-sm font-medium text-tech-muted cursor-not-allowed transition-colors"
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
    <div className="flex flex-col gap-4 rounded-lg border border-tech-border bg-tech-surface p-5 md:flex-row md:items-center md:justify-between">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-purple-50 text-tech-purple">
          <Icon size={20} />
        </span>
        <div>
          <h3 className="text-lg font-semibold text-tech-text">{title}</h3>
          <p className="mt-1 text-sm text-tech-muted">{description}</p>
        </div>
      </div>
      {action}
    </div>
  );
}

function FormField({ label, required, hint, children }: { label: string; required?: boolean; hint?: string; children: ReactNode }) {
  return (
    <div>
      <label className="mb-2 block text-sm font-medium text-tech-text">
        {label} {required && <span className="text-red-500">*</span>}
      </label>
      {children}
      {hint && <p className="mt-1 text-xs text-tech-muted">{hint}</p>}
    </div>
  );
}

function ResultBanner({ valid, message }: { valid: boolean; message: string }) {
  return (
    <div className={`flex items-center gap-2 rounded-lg border p-3 text-sm ${valid ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-red-200 bg-red-50 text-red-700'}`}>
      {valid ? <CheckCircle2 size={17} /> : <XCircle size={17} />}
      {message}
    </div>
  );
}

function StorageCard({ title, value }: { title: string; value: string }) {
  return (
    <div className="rounded-lg bg-tech-bg p-4">
      <p className="text-sm font-semibold text-tech-text">{title}</p>
      <p className="mt-2 break-all font-mono text-xs text-tech-muted">{value}</p>
    </div>
  );
}

function InfoCard({ icon: Icon, title, description }: { icon: typeof ShieldCheck; title: string; description: string }) {
  return (
    <div className="rounded-lg border border-tech-border bg-tech-surface p-5">
      <Icon className="mb-4 h-8 w-8 text-tech-purple" />
      <h3 className="font-semibold text-tech-text">{title}</h3>
      <p className="mt-2 text-sm leading-6 text-tech-muted">{description}</p>
    </div>
  );
}

function getProviderLabel(provider: AIKeyConfig['provider']) {
  if (provider === 'deepseek') return 'DeepSeek';
  if (provider === 'openai') return 'OpenAI';
  return '第三方';
}

// ─── 手动 Cookie 输入组件 ──────────────────────────────────────

function ManualCookieInput({ onSaved, disabled }: { onSaved: () => void; disabled: boolean }) {
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
        disabled={disabled || saving}
        rows={3}
        className="w-full rounded-lg border border-tech-border bg-tech-bg px-4 py-3 text-sm font-mono text-tech-text placeholder-tech-muted outline-none transition-all focus:border-tech-blue focus:ring-2 focus:ring-blue-100 resize-y"
      />
      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={disabled || saving || !cookie.trim()}
          className="rounded-lg bg-tech-blue px-4 py-2 text-sm font-medium text-white transition-all hover:bg-blue-600 disabled:opacity-50"
        >
          {saving ? "保存中..." : "保存 Cookie"}
        </button>
        {msg && (
          <span className={`text-sm ${msg.ok ? "text-emerald-600" : "text-red-500"}`}>{msg.text}</span>
        )}
      </div>
    </div>
  );
}

// ─── 抖音扫码登录 ──────────────────────────────────────────────

function DouyinSection() {
  const [status, setStatus] = useState<{ hasCookie: boolean; hasAuth: boolean; path: string; status: string } | null>(null);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [loginResult, setLoginResult] = useState<{ success: boolean; message: string } | null>(null);

  useEffect(() => {
    loadStatus();
  }, []);

  const loadStatus = async () => {
    try {
      const s = await apiClient.getCookieStatus();
      setStatus(s);
    } catch {
      // ignore
    }
  };

  const handleQrLogin = async () => {
    setIsLoggingIn(true);
    setLoginResult(null);
    try {
      const result = await apiClient.startQrLogin();
      setLoginResult({ success: result.success, message: result.message });
      await loadStatus();
    } catch (err: any) {
      setLoginResult({
        success: false,
        message: err.response?.data?.message || err.message || '扫码登录失败',
      });
    } finally {
      setIsLoggingIn(false);
    }
  };

  const statusDisplay = status
    ? status.status === 'authenticated'
      ? { icon: CheckCircle2, color: 'text-emerald-600 bg-emerald-50 border-emerald-200', text: '已登录', desc: 'Cookie 包含登录态，API 调用可用' }
      : status.status === 'no_auth'
      ? { icon: AlertCircle, color: 'text-amber-600 bg-amber-50 border-amber-200', text: '未登录', desc: 'Cookie 存在但无登录态，需扫码登录' }
      : { icon: XCircle, color: 'text-red-600 bg-red-50 border-red-200', text: '无 Cookie', desc: '尚未获取任何 Cookie' }
    : null;

  return (
    <section className="space-y-6">
      <SectionHeader
        icon={QrCode}
        title="抖音登录"
        description="扫码登录抖音以获取 API 调用所需的 Cookie。登录后即可使用签名 API 批量采集视频。"
      />

      {/* Status card */}
      {statusDisplay && (
        <div className={`rounded-lg border p-5 ${statusDisplay.color}`}>
          <div className="flex items-start gap-4">
            <statusDisplay.icon size={24} className="shrink-0 mt-0.5" />
            <div className="min-w-0">
              <h3 className="font-semibold text-lg">Cookie 状态：{statusDisplay.text}</h3>
              <p className="mt-1 text-sm opacity-80">{statusDisplay.desc}</p>
              {status && (
                <p className="mt-2 text-xs opacity-60 break-all">
                  存储位置：{status.path}
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Login button */}
      <div className="rounded-lg border border-tech-border bg-tech-surface p-6">
        <h3 className="text-lg font-semibold text-tech-text mb-4">扫码登录</h3>
        <p className="text-sm text-tech-muted mb-6 leading-relaxed">
          点击下方按钮后，系统会自动打开浏览器窗口并导航至抖音首页。
          请在浏览器中<strong>使用抖音 App 扫描二维码</strong>完成登录。
          登录成功后浏览器会自动关闭，Cookie 将保存到本地供后续使用。
        </p>
        <p className="text-sm text-tech-muted mb-6">
          此操作只需执行一次，后续所有 API 调用将自动使用持久化的登录态。
        </p>

        <button
          onClick={handleQrLogin}
          disabled={isLoggingIn}
          className="inline-flex items-center gap-3 rounded-lg bg-tech-purple px-6 py-4 text-base font-semibold text-white transition-all hover:bg-purple-700 disabled:opacity-50 disabled:cursor-wait shadow-sm"
        >
          {isLoggingIn ? (
            <>
              <RefreshCw size={20} className="animate-spin" />
              等待扫码中...（浏览器已打开，请用抖音 App 扫码）
            </>
          ) : (
            <>
              <QrCode size={20} />
              打开浏览器扫码登录
            </>
          )}
        </button>

        {isLoggingIn && (
          <div className="mt-4 rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-700">
            <div className="flex items-start gap-3">
              <AlertCircle size={18} className="shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold">请查看桌面上的浏览器窗口</p>
                <p className="mt-1">
                  浏览器窗口正在等待您扫码登录。请在打开的 Chromium 窗口中用抖音 App 扫描二维码。
                  检测到登录后窗口会自动关闭。
                  <strong className="block mt-1">最长等待时间：2 分钟</strong>
                </p>
              </div>
            </div>
          </div>
        )}

        {loginResult && (
          <div className={`mt-4 rounded-lg border p-4 text-sm ${
            loginResult.success
              ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
              : 'border-red-200 bg-red-50 text-red-700'
          }`}>
            <div className="flex items-center gap-2">
              {loginResult.success ? <CheckCircle2 size={18} /> : <XCircle size={18} />}
              {loginResult.message}
            </div>
          </div>
        )}
      </div>

      {/* Manual cookie input */}
      <div className="rounded-lg border border-tech-border bg-tech-surface p-6">
        <h3 className="text-sm font-semibold text-tech-text mb-3">手动粘贴 Cookie</h3>
        <p className="text-sm text-tech-muted leading-relaxed mb-3">
          在 Chrome 中打开抖音并登录，然后按 <kbd className="px-1.5 py-0.5 rounded bg-tech-bg text-xs">F12</kbd> 打开 DevTools，
          进入 <strong>Application</strong> → <strong>Cookies</strong> → <strong>douyin.com</strong>，
          将下方格式的 Cookie 字符串粘贴到输入框中保存。
        </p>
        <ManualCookieInput
          onSaved={() => loadStatus()}
          disabled={isLoggingIn}
        />
        <p className="mt-3 text-sm text-tech-muted">
          保存位置：<code className="bg-tech-bg px-2 py-0.5 rounded text-xs select-all">{status?.path || '~/.douyin-ai-video/douyin-cookie.txt'}</code>
        </p>
      </div>
    </section>
  );
}

const inputClassName =
  'w-full rounded-lg border border-tech-border bg-tech-surface px-4 py-3 text-tech-text placeholder-tech-muted outline-none transition-all focus:border-tech-blue focus:ring-2 focus:ring-blue-100';
