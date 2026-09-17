import { useEffect, useRef } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { JobListPage } from './pages/JobListPage';
import { JobDetailPage } from './pages/JobDetailPage';
import { TrashPage } from './pages/TrashPage';
import { SettingsPage } from './pages/SettingsPage';
import { CollectionListPage } from './pages/CollectionListPage';
import { CollectionDetailPage } from './pages/CollectionDetailPage';
import { SkillListPage } from './pages/SkillListPage';
import { AssetsPage } from './pages/AssetsPage';
import { PublishingPage } from './pages/PublishingPage';
import { PublishingDuePoller } from './components/PublishingDuePoller';
import { AppShell } from './components/shell/AppShell';
import { useOperatorStore } from './store/operator';

function AppContent() {
  const initialize = useOperatorStore((state) => state.initialize);
  const initialized = useOperatorStore((state) => state.initialized);
  const initializationStarted = useRef(false);

  useEffect(() => {
    if (initializationStarted.current) return;
    initializationStarted.current = true;
    // 本机操作者会话失败时 store 会降级为「未就绪」，不会 reject，
    // 因此这里不再有初始化失败分支：应用照常进入，缺会话的操作会各自提示重试。
    void initialize();
  }, [initialize]);

  if (!initialized) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-canvas p-6">
        <div className="w-full max-w-sm rounded-lg border border-tech-border bg-white px-5 py-4 text-sm text-tech-muted shadow-sm" role="status">
          正在准备本机操作者...
        </div>
      </main>
    );
  }

  return (
    <BrowserRouter>
      <AppShell>
        <Routes>
          <Route path="/" element={<JobListPage />} />
          <Route path="/jobs/:id" element={<JobDetailPage />} />
          <Route path="/collections" element={<CollectionListPage />} />
          <Route path="/collections/:id" element={<CollectionDetailPage />} />
          <Route path="/skills" element={<SkillListPage />} />
          <Route path="/assets" element={<AssetsPage />} />
          <Route path="/publishing" element={<PublishingPage />} />
          <Route path="/trash" element={<TrashPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </AppShell>
    </BrowserRouter>
  );
}

function App() {
  return (
    <>
      <PublishingDuePoller />
      <AppContent />
    </>
  );
}

export default App;
