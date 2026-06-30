import { useState, useEffect } from 'react';
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

export function SettingsPage() {
  const [apiKeys, setApiKeys] = useState<AIKeyConfig[]>([]);
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

  // 加载 API Keys
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
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-semibold text-tech-text mb-1">API 密钥管理</h2>
            <p className="text-sm text-tech-muted">管理您的 AI 服务 API 密钥</p>
          </div>
          <button
            onClick={() => setIsAdding(true)}
            className="px-4 py-2 rounded-lg bg-tech-blue text-white hover:bg-tech-blue-dark transition-all shadow-sm hover:shadow font-medium text-sm"
          >
            + 添加密钥
          </button>
        </div>

        {/* API Keys List */}
        {apiKeys.length === 0 && !isAdding ? (
          <div className="text-center py-16 bg-tech-surface rounded-lg border border-tech-border">
            <div className="text-5xl mb-4">🔑</div>
            <h3 className="text-lg font-medium text-tech-text mb-2">还没有 API 密钥</h3>
            <p className="text-tech-muted mb-6">添加第一个 API 密钥开始使用</p>
            <button
              onClick={() => setIsAdding(true)}
              className="px-6 py-3 rounded-lg bg-tech-blue text-white hover:bg-tech-blue-dark transition-all shadow-sm hover:shadow font-medium"
            >
              立即添加
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            {apiKeys.map((key) => (
              <div
                key={key.id}
                className={`bg-tech-surface rounded-lg border p-5 transition-all ${
                  key.isActive
                    ? 'border-tech-blue shadow-md'
                    : 'border-tech-border hover:border-tech-blue'
                }`}
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-2">
                      <h3 className="font-semibold text-tech-text">{key.name}</h3>
                      {key.isActive && (
                        <span className="px-2 py-1 bg-green-50 text-green-700 border border-green-200 rounded text-xs font-medium">
                          当前使用
                        </span>
                      )}
                      <span className="px-2 py-1 bg-tech-bg text-tech-muted rounded text-xs">
                        {key.provider === 'deepseek'
                          ? 'DeepSeek'
                          : key.provider === 'openai'
                          ? 'OpenAI'
                          : '第三方'}
                      </span>
                    </div>
                    <p className="text-sm text-tech-muted mb-1">
                      模型：<code className="text-tech-text bg-tech-bg px-2 py-0.5 rounded">{key.model}</code>
                    </p>
                    <p className="text-xs text-tech-muted font-mono">
                      密钥：{key.apiKey.slice(0, 8)}...{key.apiKey.slice(-4)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {!key.isActive && (
                      <button
                        onClick={() => handleSetActive(key.id)}
                        className="px-3 py-1.5 rounded-lg border border-tech-border text-tech-text hover:border-tech-blue hover:text-tech-blue transition-all text-sm"
                      >
                        设为当前
                      </button>
                    )}
                    <button
                      onClick={() => handleRemove(key.id)}
                      className="px-3 py-1.5 rounded-lg border border-red-200 text-red-600 hover:bg-red-50 transition-all text-sm"
                    >
                      删除
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Add New Key Form */}
        {isAdding && (
          <div className="mt-6 bg-tech-surface rounded-lg border border-tech-border p-6">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-lg font-semibold text-tech-text">添加新密钥</h3>
              <button
                onClick={() => {
                  setIsAdding(false);
                  setTestResult(null);
                }}
                className="text-tech-muted hover:text-tech-text"
              >
                ✕
              </button>
            </div>

            <div className="space-y-5">
              {/* Name */}
              <div>
                <label className="block text-sm font-medium text-tech-text mb-2">
                  密钥名称 <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={newKey.name}
                  onChange={(e) => setNewKey({ ...newKey, name: e.target.value })}
                  placeholder="例如：我的 DeepSeek 密钥"
                  className="w-full px-4 py-3 rounded-lg border border-tech-border bg-tech-surface text-tech-text placeholder-tech-muted focus:outline-none focus:ring-2 focus:ring-tech-blue focus:border-transparent transition-all"
                />
              </div>

              {/* Provider */}
              <div>
                <label className="block text-sm font-medium text-tech-text mb-3">
                  服务商
                </label>
                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={() => handleProviderChange('deepseek')}
                    className={`flex-1 px-4 py-3 rounded-lg border text-sm font-medium transition-all ${
                      newKey.provider === 'deepseek'
                        ? 'border-tech-blue bg-blue-50 text-tech-blue'
                        : 'border-tech-border text-tech-muted hover:border-tech-blue'
                    }`}
                  >
                    DeepSeek
                  </button>
                  <button
                    type="button"
                    onClick={() => handleProviderChange('openai')}
                    className={`flex-1 px-4 py-3 rounded-lg border text-sm font-medium transition-all ${
                      newKey.provider === 'openai'
                        ? 'border-tech-blue bg-blue-50 text-tech-blue'
                        : 'border-tech-border text-tech-muted hover:border-tech-blue'
                    }`}
                  >
                    OpenAI
                  </button>
                  <button
                    type="button"
                    onClick={() => handleProviderChange('custom')}
                    className={`flex-1 px-4 py-3 rounded-lg border text-sm font-medium transition-all ${
                      newKey.provider === 'custom'
                        ? 'border-tech-blue bg-blue-50 text-tech-blue'
                        : 'border-tech-border text-tech-muted hover:border-tech-blue'
                    }`}
                  >
                    第三方
                  </button>
                </div>
              </div>

              {/* API Key */}
              <div>
                <label className="block text-sm font-medium text-tech-text mb-2">
                  API Key <span className="text-red-500">*</span>
                </label>
                <input
                  type="password"
                  value={newKey.apiKey}
                  onChange={(e) => {
                    setNewKey({ ...newKey, apiKey: e.target.value });
                    setTestResult(null);
                  }}
                  placeholder="sk-..."
                  className="w-full px-4 py-3 rounded-lg border border-tech-border bg-tech-surface text-tech-text placeholder-tech-muted focus:outline-none focus:ring-2 focus:ring-tech-blue focus:border-transparent transition-all font-mono text-sm"
                />
              </div>

              {/* Base URL (for custom) */}
              {newKey.provider === 'custom' && (
                <div>
                  <label className="block text-sm font-medium text-tech-text mb-2">
                    API 地址
                  </label>
                  <input
                    type="text"
                    value={newKey.baseURL}
                    onChange={(e) => setNewKey({ ...newKey, baseURL: e.target.value })}
                    placeholder="https://api.example.com/v1"
                    className="w-full px-4 py-3 rounded-lg border border-tech-border bg-tech-surface text-tech-text placeholder-tech-muted focus:outline-none focus:ring-2 focus:ring-tech-blue focus:border-transparent transition-all font-mono text-sm"
                  />
                </div>
              )}

              {/* Model */}
              <div>
                <label className="block text-sm font-medium text-tech-text mb-2">
                  模型
                </label>
                <input
                  type="text"
                  value={newKey.model}
                  onChange={(e) => setNewKey({ ...newKey, model: e.target.value })}
                  placeholder="模型 ID"
                  className="w-full px-4 py-3 rounded-lg border border-tech-border bg-tech-surface text-tech-text placeholder-tech-muted focus:outline-none focus:ring-2 focus:ring-tech-blue focus:border-transparent transition-all font-mono text-sm"
                />
              </div>

              {/* Test Result */}
              {testResult && (
                <div
                  className={`p-3 rounded-lg text-sm ${
                    testResult.valid
                      ? 'bg-green-50 border border-green-200 text-green-700'
                      : 'bg-red-50 border border-red-200 text-red-700'
                  }`}
                >
                  {testResult.valid ? '✅ API Key 有效' : `❌ ${testResult.error}`}
                </div>
              )}

              {/* Buttons */}
              <div className="flex gap-3 justify-end pt-2">
                <button
                  onClick={handleTest}
                  disabled={isTesting || !newKey.apiKey}
                  className="px-5 py-2.5 rounded-lg border border-tech-border text-tech-text hover:bg-tech-bg transition-all disabled:opacity-50 font-medium"
                >
                  {isTesting ? '测试中...' : '测试连接'}
                </button>
                <button
                  onClick={handleAdd}
                  disabled={isSaving || !testResult?.valid}
                  className="px-5 py-2.5 rounded-lg bg-tech-blue text-white hover:bg-tech-blue-dark shadow-sm hover:shadow transition-all disabled:opacity-50 disabled:cursor-not-allowed font-medium"
                >
                  {isSaving ? '保存中...' : '保存密钥'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Info */}
        <div className="mt-8 p-4 bg-blue-50 border border-blue-200 rounded-lg">
          <div className="flex items-start gap-3">
            <span className="text-2xl">💡</span>
            <div className="flex-1 text-sm">
              <p className="font-medium text-tech-text mb-1">提示</p>
              <ul className="space-y-1 text-tech-muted">
                <li>• 添加前会先测试 API Key 是否有效</li>
                <li>• 可以添加多个 API Key 并随时切换</li>
                <li>• API Key 使用加密存储，仅保存在本地</li>
                <li>• 切换 API Key 后会立即生效</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </Layout>
  );
}
