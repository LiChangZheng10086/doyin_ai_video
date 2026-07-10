import { useState, useEffect } from 'react';
import type { ReactNode } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Database,
  HardDrive,
  KeyRound,
  Mic,
  Plus,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';
import { Layout } from '../components/Layout';

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

type SettingsSection = 'models' | 'asr' | 'storage' | 'advanced';

const sections: Array<{ id: SettingsSection; label: string; description: string; icon: typeof KeyRound }> = [
  { id: 'models', label: 'Models / API Keys', description: 'AI 服务与密钥', icon: KeyRound },
  { id: 'asr', label: 'ASR', description: '视频转录服务', icon: Mic },
  { id: 'storage', label: 'Storage', description: '本地文件位置', icon: HardDrive },
  { id: 'advanced', label: 'Advanced', description: '安全与提示', icon: SlidersHorizontal },
];

export function SettingsPage() {
  const [apiKeys, setApiKeys] = useState<AIKeyConfig[]>([]);
  const [activeSection, setActiveSection] = useState<SettingsSection>('models');
  const [isAdding, setIsAdding] = useState(false);
  const [newKey, setNewKey] = useState({
    name: '',
    provider: 'deepseek' as 'deepseek' | 'openai' | 'custom',
    apiKey: '',
    baseURL: 'https://api.deepseek.com',
    model: 'deepseek-chat',
  });
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ valid: boolean; error?: string } | null>(null);
  const [isSaving, setIsSaving] = useState(false);

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
      setIsAdding(false);
      setNewKey({
        name: '',
        provider: 'deepseek',
        apiKey: '',
        baseURL: 'https://api.deepseek.com',
        model: 'deepseek-chat',
      });
      setTestResult(null);
    } catch (error) {
      setTestResult({
        valid: false,
        error: error instanceof Error ? error.message : '添加失败',
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleRemove = async (keyId: string) => {
    if (!confirm('确定要删除这个 API Key 吗？')) return;

    try {
      await window.electron.removeApiKey(keyId);
      await loadApiKeys();
    } catch (error) {
      alert('删除失败：' + (error instanceof Error ? error.message : '未知错误'));
    }
  };

  const handleSetActive = async (keyId: string) => {
    try {
      await window.electron.setActiveApiKey(keyId);
      await loadApiKeys();
    } catch (error) {
      alert('切换失败：' + (error instanceof Error ? error.message : '未知错误'));
    }
  };

  return (
    <Layout>
      <div className="mb-8">
        <p className="mb-2 inline-flex items-center gap-2 rounded-full bg-purple-50 px-3 py-1 text-xs font-medium text-tech-purple">
          <Sparkles size={14} />
          Creator settings
        </p>
        <h2 className="text-2xl font-semibold text-tech-text">设置</h2>
        <p className="mt-1 text-sm text-tech-muted">配置 AI 模型、视频转录和本地创作资产。</p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="rounded-lg border border-tech-border bg-tech-surface p-2">
          {sections.map((section) => {
            const Icon = section.icon;
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
              setIsAdding={setIsAdding}
              newKey={newKey}
              setNewKey={setNewKey}
              testResult={testResult}
              setTestResult={setTestResult}
              isTesting={isTesting}
              isSaving={isSaving}
              onProviderChange={handleProviderChange}
              onTest={handleTest}
              onAdd={handleAdd}
              onRemove={handleRemove}
              onSetActive={handleSetActive}
            />
          )}
          {activeSection === 'asr' && <AsrSection />}
          {activeSection === 'storage' && <StorageSection />}
          {activeSection === 'advanced' && <AdvancedSection />}
        </main>
      </div>
    </Layout>
  );
}

function ModelsSection({
  apiKeys,
  isAdding,
  setIsAdding,
  newKey,
  setNewKey,
  testResult,
  setTestResult,
  isTesting,
  isSaving,
  onProviderChange,
  onTest,
  onAdd,
  onRemove,
  onSetActive,
}: {
  apiKeys: AIKeyConfig[];
  isAdding: boolean;
  setIsAdding: (value: boolean) => void;
  newKey: {
    name: string;
    provider: 'deepseek' | 'openai' | 'custom';
    apiKey: string;
    baseURL: string;
    model: string;
  };
  setNewKey: (value: {
    name: string;
    provider: 'deepseek' | 'openai' | 'custom';
    apiKey: string;
    baseURL: string;
    model: string;
  }) => void;
  testResult: { valid: boolean; error?: string } | null;
  setTestResult: (value: { valid: boolean; error?: string } | null) => void;
  isTesting: boolean;
  isSaving: boolean;
  onProviderChange: (provider: 'deepseek' | 'openai' | 'custom') => void;
  onTest: () => void;
  onAdd: () => void;
  onRemove: (keyId: string) => void;
  onSetActive: (keyId: string) => void;
}) {
  return (
    <section className="space-y-6">
      <SectionHeader
        icon={KeyRound}
        title="Models / API Keys"
        description="管理 AI 洗稿使用的模型密钥。"
        action={
          <button
            onClick={() => setIsAdding(true)}
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
            onClick={() => setIsAdding(true)}
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
                  <p className="mt-1 font-mono text-xs text-tech-muted">
                    密钥：{key.apiKey.slice(0, 8)}...{key.apiKey.slice(-4)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {!key.isActive && (
                    <button
                      onClick={() => onSetActive(key.id)}
                      className="rounded-lg border border-tech-border px-3 py-2 text-sm font-medium text-tech-text transition-all hover:border-tech-blue hover:text-tech-blue"
                    >
                      设为当前
                    </button>
                  )}
                  <button
                    onClick={() => onRemove(key.id)}
                    className="inline-flex items-center gap-1 rounded-lg border border-red-200 px-3 py-2 text-sm font-medium text-red-600 transition-all hover:bg-red-50"
                  >
                    <Trash2 size={15} />
                    删除
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {isAdding && (
        <div className="rounded-lg border border-tech-border bg-tech-surface p-6">
          <div className="mb-6 flex items-center justify-between">
            <h3 className="text-lg font-semibold text-tech-text">添加新密钥</h3>
            <button
              onClick={() => {
                setIsAdding(false);
                setTestResult(null);
              }}
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

            <FormField label="API Key" required>
              <input
                type="password"
                value={newKey.apiKey}
                onChange={(event) => {
                  setNewKey({ ...newKey, apiKey: event.target.value });
                  setTestResult(null);
                }}
                placeholder="sk-..."
                className={`${inputClassName} font-mono text-sm`}
              />
            </FormField>

            {newKey.provider === 'custom' && (
              <FormField label="API 地址">
                <input
                  type="text"
                  value={newKey.baseURL}
                  onChange={(event) => setNewKey({ ...newKey, baseURL: event.target.value })}
                  placeholder="https://api.example.com/v1"
                  className={`${inputClassName} font-mono text-sm`}
                />
              </FormField>
            )}

            <FormField label="模型">
              <input
                type="text"
                value={newKey.model}
                onChange={(event) => setNewKey({ ...newKey, model: event.target.value })}
                placeholder="模型 ID"
                className={`${inputClassName} font-mono text-sm`}
              />
            </FormField>

            {testResult && (
              <ResultBanner valid={testResult.valid} message={testResult.valid ? 'API Key 有效' : testResult.error || '测试失败'} />
            )}

            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={onTest}
                disabled={isTesting || !newKey.apiKey}
                className="rounded-lg border border-tech-border px-5 py-2.5 font-medium text-tech-text transition-all hover:bg-tech-bg disabled:opacity-50"
              >
                {isTesting ? '测试中...' : '测试连接'}
              </button>
              <button
                onClick={onAdd}
                disabled={isSaving || !testResult?.valid}
                className="rounded-lg bg-tech-blue px-5 py-2.5 font-medium text-white transition-all hover:bg-tech-blue-dark disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isSaving ? '保存中...' : '保存密钥'}
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
        title="ASR"
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
        title="Storage"
        description="本地作品、素材和输出文件会保存到用户文档目录。"
      />
      <div className="rounded-lg border border-tech-border bg-tech-surface p-6">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <StorageCard title="Raw assets" value="~/Documents/抖音AI视频/raw" />
          <StorageCard title="Processed scripts" value="~/Documents/抖音AI视频/processed" />
          <StorageCard title="Video output" value="~/Documents/抖音AI视频/output/videos" />
          <StorageCard title="Logs" value="~/Documents/抖音AI视频/logs" />
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
        title="Advanced"
        description="安全策略和本地运行提示。"
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

const inputClassName =
  'w-full rounded-lg border border-tech-border bg-tech-surface px-4 py-3 text-tech-text placeholder-tech-muted outline-none transition-all focus:border-tech-blue focus:ring-2 focus:ring-blue-100';
