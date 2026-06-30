# API Key 验证与智能轮询功能设计

**日期：** 2026-06-30  
**版本：** 1.0  
**状态：** 已批准

---

## 目标

改进抖音 AI 视频生成器的用户体验，重点解决以下问题：

1. **API Key 验证**：用户未配置 API Key 时创建任务，导致任务失败但没有明确提示
2. **全局状态指示**：用户不清楚当前 API Key 配置状态
3. **任务状态刷新**：任务状态变化不会自动更新，用户需要手动刷新

---

## 设计方案

采用**渐进式改进**策略，按以下优先级实施：

### 优先级 1（高）
- API Key 验证与拦截
- 全局配置状态指示器
- 智能轮询服务

### 优先级 2（中）
- 任务详情页
- 改进错误提示

### 优先级 3（低）
- 批量操作
- 任务筛选和搜索

本文档聚焦**优先级 1** 的功能设计。

---

## 架构概览

```
┌─────────────────────────────────────────┐
│          前端 Electron App              │
│  ┌────────────────────────────────────┐ │
│  │  顶部导航栏                         │ │
│  │  [任务列表] [⚙️ 设置] [⚠️ 未配置]  │ │  ← 新增：全局状态指示
│  └────────────────────────────────────┘ │
│  ┌────────────────────────────────────┐ │
│  │  任务列表页                         │ │
│  │  • 智能轮询服务（3秒/15秒/停止）   │ │  ← 新增：智能轮询
│  │  • 创建任务前验证 API Key          │ │  ← 新增：验证拦截
│  └────────────────────────────────────┘ │
└─────────────────────────────────────────┘
              ↕ IPC
┌─────────────────────────────────────────┐
│       Electron Main Process             │
│  • getConfig() - 获取 API Keys          │
│  • hasValidApiKey() - 快速验证         │  ← 已存在
└─────────────────────────────────────────┘
              ↕ HTTP
┌─────────────────────────────────────────┐
│        Express Backend Server           │
│  • GET /api/jobs - 获取任务列表         │
│  • POST /api/jobs - 创建任务            │
└─────────────────────────────────────────┘
```

---

## 功能设计

### 1. 全局状态指示器

**位置：** 顶部导航栏右侧

**状态展示：**

| 状态 | 显示 | 说明 |
|------|------|------|
| 已配置 | ✅ [绿点] API 已配置 | 至少有一个活跃的 API Key |
| 未配置 | ⚠️ [橙点] 未配置 AI + "前往设置" | 没有活跃的 API Key |
| 检查中 | 🔄 [灰点] 检查中... | 正在加载配置 |

**检查时机：**
- 应用启动时
- 路由变化时（特别是从设置页返回）
- 用户手动刷新时

**实现要点：**
- 调用 `window.electron.getConfig()` 获取配置
- 检查 `config.aiKeys` 中是否有 `isActive: true` 的项
- 使用 React `useLocation` 监听路由变化

---

### 2. API Key 验证拦截

**验证时机：** 用户点击"创建任务"按钮时

**交互流程：**
```
用户点击"创建任务"
    ↓
检查是否有 Active API Key
    ↓
[有] → 打开创建任务对话框
    ↓
[无] → 显示警告对话框
    ↓
┌────────────────────────────────────┐
│  ⚠️ 需要配置 API Key               │
│                                    │
│  您还没有添加 AI API 密钥。        │
│  请先前往设置页面添加密钥后再创建  │
│  任务。                            │
│                                    │
│  [取消]  [前往设置]               │
└────────────────────────────────────┘
```

**行为规范：**
- 验证失败时**不**打开创建任务对话框
- 显示明确的原因和引导操作
- "前往设置"按钮使用 React Router 导航到 `/settings`
- 用户在设置页添加 Key 后返回，可以正常创建任务

---

### 3. 智能轮询服务

**核心策略：** 根据任务状态动态调整轮询频率

| 场景 | 轮询间隔 | 说明 |
|------|----------|------|
| 有任务处理中 | 3 秒 | `status = 'queued' \|\| 'processing'` |
| 所有任务完成 | 15 秒 | `status = 'done' \|\| 'failed'` |
| 没有任务 | 停止 | `jobs.length === 0` |
| 用户离开页面 | 停止 | 页面卸载时清理定时器 |

**实现方式：**
- 封装为自定义 Hook：`useJobPolling(enabled: boolean)`
- 使用 `useEffect` + `setInterval` 实现
- 依赖 `jobs` 数组的长度和状态变化
- 返回 `{ isPolling }` 供 UI 显示

**优点：**
- 任务处理时快速更新（3 秒）
- 任务完成后降低频率（15 秒），减少资源消耗
- 没有任务时完全停止，节省资源
- 自动适应页面生命周期

---

## 数据流

### 完整用户流程

```
1. 应用启动
   ├─ 加载配置 (getConfig)
   ├─ 检查 API Key 状态
   └─ 获取任务列表 (GET /api/jobs)

2. 用户创建任务
   ├─ 验证 API Key 是否存在
   │  ├─ [有] → 继续
   │  └─ [无] → 显示提示对话框 → 跳转设置页
   ├─ 提交表单 (POST /api/jobs)
   ├─ 后端创建任务并开始处理
   ├─ 前端添加到任务列表
   └─ 开始智能轮询

3. 智能轮询
   ├─ 根据任务状态计算间隔
   ├─ 发起请求 (GET /api/jobs)
   ├─ 更新任务列表
   └─ 触发下一次轮询

4. 用户添加 API Key
   ├─ 在设置页添加密钥
   ├─ 测试连接
   ├─ 保存配置
   ├─ 返回任务列表
   └─ 重新检查 API Key 状态（更新全局指示器）
```

---

## 错误处理

### 1. API Key 验证失败
**场景：** 检查配置时 IPC 调用失败  
**处理：** 显示为"未配置"状态，允许用户前往设置

### 2. 创建任务失败
**场景：** 网络错误、后端错误、参数错误  
**处理：**
- 在创建对话框中显示错误信息
- 不关闭对话框，让用户修改后重试
- 显示具体错误原因（如"请输入有效链接"）

### 3. 轮询失败
**场景：** 网络中断、后端崩溃  
**处理：**
- 静默失败，不打断用户
- 控制台记录错误
- 下次轮询时自动重试
- 连续失败 3 次后降低轮询频率

### 4. 配置加载失败
**场景：** 配置文件损坏、权限问题  
**处理：**
- 使用默认配置（空 API Keys）
- 显示警告提示
- 允许用户重新配置

---

## 边界情况

### 1. 用户在设置页时创建了任务（在另一个窗口）
**处理：** 返回任务列表时立即刷新

### 2. 用户添加第一个 API Key 后
**处理：**
- 全局指示器从"未配置"变为"已配置"
- 不会自动创建任务，等待用户操作

### 3. 用户删除唯一的 API Key
**处理：**
- 全局指示器变为"未配置"
- 正在运行的任务继续执行（因为后端已加载配置）
- 新任务会被拦截

### 4. 多个任务同时处理
**处理：** 轮询频率始终是 3 秒（只要有一个在处理中）

---

## 实现细节

### 文件结构

**新增文件：**
```
renderer/src/
├── hooks/
│   └── useJobPolling.ts          # 智能轮询 Hook
├── components/
│   ├── ApiKeyWarning.tsx         # API Key 未配置提示对话框
│   └── ApiKeyStatusIndicator.tsx # 全局状态指示器
└── utils/
    └── apiKeyValidator.ts        # API Key 验证工具函数
```

**修改文件：**
```
renderer/src/
├── App.tsx                       # 添加全局状态指示器
├── pages/
│   ├── JobListPage.tsx           # 集成智能轮询
│   └── SettingsPage.tsx          # 返回时通知状态变化
└── components/
    └── CreateJobDialog.tsx       # 添加 API Key 验证
```

### 关键代码模块

#### 1. API Key 验证工具（utils/apiKeyValidator.ts）

```typescript
/**
 * 检查是否有有效的 API Key
 */
export async function hasValidApiKey(): Promise<boolean> {
  try {
    const config = await window.electron.getConfig();
    return config.aiKeys?.some(key => key.isActive) ?? false;
  } catch (error) {
    console.error('Failed to check API key:', error);
    return false;
  }
}

/**
 * 获取当前活跃的 API Key
 */
export async function getActiveApiKey() {
  try {
    const config = await window.electron.getConfig();
    return config.aiKeys?.find(key => key.isActive) ?? null;
  } catch (error) {
    console.error('Failed to get active API key:', error);
    return null;
  }
}
```

#### 2. 智能轮询 Hook（hooks/useJobPolling.ts）

```typescript
import { useEffect, useState, useCallback } from 'react';
import { useAppStore } from '../store';
import { apiClient } from '../services/api';

/**
 * 智能轮询 Hook
 * @param enabled 是否启用轮询
 * @returns { isPolling } 当前是否正在轮询
 */
export function useJobPolling(enabled: boolean) {
  const jobs = useAppStore(state => state.jobs);
  const setJobs = useAppStore(state => state.setJobs);
  const [isPolling, setIsPolling] = useState(false);
  
  // 计算轮询间隔
  const getInterval = useCallback(() => {
    if (jobs.length === 0) return null; // 停止轮询
    
    const hasActive = jobs.some(j => 
      j.status === 'queued' || j.status === 'processing'
    );
    
    return hasActive ? 3000 : 15000; // 3秒 或 15秒
  }, [jobs]);
  
  useEffect(() => {
    if (!enabled) {
      setIsPolling(false);
      return;
    }
    
    const interval = getInterval();
    if (!interval) {
      setIsPolling(false);
      return;
    }
    
    setIsPolling(true);
    
    const fetchJobs = async () => {
      try {
        const response = await apiClient.get('/jobs');
        if (response.data?.jobs) {
          setJobs(response.data.jobs);
        }
      } catch (error) {
        console.error('Polling failed:', error);
        // 静默失败，下次轮询时重试
      }
    };
    
    const timer = setInterval(fetchJobs, interval);
    
    return () => clearInterval(timer);
  }, [enabled, getInterval, setJobs]);
  
  return { isPolling };
}
```

#### 3. 全局状态指示器（components/ApiKeyStatusIndicator.tsx）

```typescript
import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { hasValidApiKey } from '../utils/apiKeyValidator';

export function ApiKeyStatusIndicator() {
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const location = useLocation();
  
  // 路由变化时重新检查
  useEffect(() => {
    checkApiKey();
  }, [location.pathname]);
  
  const checkApiKey = async () => {
    const valid = await hasValidApiKey();
    setHasKey(valid);
  };
  
  // 检查中
  if (hasKey === null) {
    return (
      <div className="flex items-center gap-2">
        <span className="w-2 h-2 bg-gray-400 rounded-full animate-pulse" />
        <span className="text-sm text-tech-muted">检查中...</span>
      </div>
    );
  }
  
  // 已配置
  if (hasKey) {
    return (
      <div className="flex items-center gap-2">
        <span className="w-2 h-2 bg-green-500 rounded-full" />
        <span className="text-sm text-tech-muted">API 已配置</span>
      </div>
    );
  }
  
  // 未配置
  return (
    <div className="flex items-center gap-3">
      <span className="w-2 h-2 bg-orange-500 rounded-full" />
      <span className="text-sm text-orange-600">未配置 AI</span>
      <Link 
        to="/settings"
        className="text-sm text-tech-blue hover:underline"
      >
        前往设置
      </Link>
    </div>
  );
}
```

#### 4. API Key 警告对话框（components/ApiKeyWarning.tsx）

```typescript
import { useNavigate } from 'react-router-dom';

interface ApiKeyWarningProps {
  isOpen: boolean;
  onClose: () => void;
}

export function ApiKeyWarning({ isOpen, onClose }: ApiKeyWarningProps) {
  const navigate = useNavigate();
  
  if (!isOpen) return null;
  
  const handleGoToSettings = () => {
    onClose();
    navigate('/settings');
  };
  
  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-tech-surface rounded-xl shadow-2xl w-full max-w-md mx-4 border border-tech-border p-6">
        <div className="text-center mb-4">
          <div className="text-5xl mb-3">⚠️</div>
          <h3 className="text-xl font-semibold text-tech-text mb-2">
            需要配置 API Key
          </h3>
        </div>
        
        <p className="text-tech-muted text-center mb-6">
          您还没有添加 AI API 密钥。请先前往设置页面添加密钥后再创建任务。
        </p>
        
        <div className="flex gap-3 justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg border border-tech-border text-tech-text hover:bg-tech-bg transition-all"
          >
            取消
          </button>
          <button
            onClick={handleGoToSettings}
            className="px-4 py-2 rounded-lg bg-tech-blue text-white hover:bg-tech-blue-dark transition-all shadow-sm"
          >
            前往设置
          </button>
        </div>
      </div>
    </div>
  );
}
```

### 集成方式

#### App.tsx - 添加全局状态指示器

```typescript
import { ApiKeyStatusIndicator } from './components/ApiKeyStatusIndicator';

function Navigation() {
  const location = useLocation();

  return (
    <div className="min-h-screen bg-tech-bg">
      <header className="bg-tech-surface border-b border-tech-border shadow-sm">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          {/* 左侧：Logo + 导航 */}
          <div className="flex items-center gap-8">
            {/* ... */}
          </div>

          {/* 右侧：状态指示器 */}
          <div className="flex items-center gap-4">
            <ApiKeyStatusIndicator />
            <span className="text-xs text-tech-muted bg-tech-bg px-3 py-1 rounded-full">
              v0.1.0
            </span>
          </div>
        </div>
      </header>
      {/* ... */}
    </div>
  );
}
```

#### JobListPage.tsx - 集成验证和轮询

```typescript
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useJobPolling } from '../hooks/useJobPolling';
import { hasValidApiKey } from '../utils/apiKeyValidator';
import { ApiKeyWarning } from '../components/ApiKeyWarning';

export function JobListPage() {
  const navigate = useNavigate();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [showApiWarning, setShowApiWarning] = useState(false);
  
  // 启用智能轮询
  const { isPolling } = useJobPolling(true);
  
  const handleCreateClick = async () => {
    // 验证 API Key
    const hasKey = await hasValidApiKey();
    if (!hasKey) {
      setShowApiWarning(true);
      return;
    }
    
    // 验证通过，打开创建任务对话框
    setIsDialogOpen(true);
  };
  
  return (
    <Layout>
      {/* ... 任务列表内容 ... */}
      
      <button onClick={handleCreateClick}>
        创建任务
      </button>
      
      {/* 创建任务对话框 */}
      <CreateJobDialog 
        isOpen={isDialogOpen}
        onClose={() => setIsDialogOpen(false)}
      />
      
      {/* API Key 警告对话框 */}
      <ApiKeyWarning 
        isOpen={showApiWarning}
        onClose={() => setShowApiWarning(false)}
      />
      
      {/* 调试信息（可选） */}
      {isPolling && (
        <div className="fixed bottom-4 right-4 text-xs text-tech-muted">
          轮询中...
        </div>
      )}
    </Layout>
  );
}
```

---

## 测试场景

### 功能测试

1. **API Key 验证**
   - [ ] 无 API Key 时点击"创建任务"，显示警告对话框
   - [ ] 警告对话框中点击"前往设置"，正确跳转
   - [ ] 添加 API Key 后返回，可以正常创建任务
   - [ ] 有 API Key 时点击"创建任务"，正常打开对话框

2. **全局状态指示器**
   - [ ] 应用启动时正确显示配置状态
   - [ ] 从设置页返回时状态更新
   - [ ] 点击"前往设置"链接正确跳转
   - [ ] 三种状态（已配置/未配置/检查中）显示正确

3. **智能轮询**
   - [ ] 有任务处理中时，3 秒轮询一次
   - [ ] 所有任务完成时，15 秒轮询一次
   - [ ] 没有任务时，停止轮询
   - [ ] 创建新任务后，自动开始轮询
   - [ ] 切换页面时，轮询正确停止/恢复
   - [ ] 任务状态变化时，UI 自动更新

### 边界测试

1. **网络异常**
   - [ ] 轮询失败时不影响用户操作
   - [ ] IPC 调用失败时显示为"未配置"

2. **并发场景**
   - [ ] 多个任务同时处理时，轮询频率正确
   - [ ] 快速切换页面时，定时器正确清理

3. **配置变更**
   - [ ] 删除唯一 API Key 后，拦截新任务
   - [ ] 添加第一个 API Key 后，允许创建任务

---

## 性能考虑

### 轮询优化
- 没有任务时停止轮询，避免不必要的网络请求
- 任务完成后降低频率，减少服务器负载
- 使用 `useCallback` 避免不必要的函数重建

### 渲染优化
- 状态指示器使用 `location.pathname` 触发检查，避免频繁调用
- 轮询结果通过 Zustand 状态管理，避免 prop drilling
- 使用条件渲染，不显示的对话框不渲染 DOM

---

## 未来改进

### 短期（1-2 周）
- 任务详情页
- 更丰富的错误提示
- 任务操作（重试、删除）

### 中期（1 个月）
- 批量操作
- 任务筛选和搜索
- 导出任务结果

### 长期（3 个月）
- WebSocket 实时推送
- 任务队列可视化
- 性能监控和统计

---

## 总结

本设计通过三个核心功能改进用户体验：

1. **API Key 验证**：在创建任务前拦截，避免无效任务
2. **全局状态指示**：让用户随时了解配置状态
3. **智能轮询**：根据任务状态动态调整刷新频率，平衡实时性和性能

采用渐进式改进策略，优先实现高价值功能，后续迭代补充细节。所有错误处理和边界情况都有明确的处理方案，确保系统稳定可靠。
