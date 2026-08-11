import { useEffect, useRef, useState } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { JobListPage } from './pages/JobListPage';
import { JobDetailPage } from './pages/JobDetailPage';
import { TrashPage } from './pages/TrashPage';
import { SettingsPage } from './pages/SettingsPage';
import { CollectionListPage } from './pages/CollectionListPage';
import { CollectionDetailPage } from './pages/CollectionDetailPage';
import { SkillListPage } from './pages/SkillListPage';
import { PublishingPage } from './pages/PublishingPage';
import { LocalUserSetup } from './components/LocalUserSetup';
import { PublishingDuePoller } from './components/PublishingDuePoller';
import { AppShell } from './components/shell/AppShell';
import { useOperatorStore } from './store/operator';

function AppContent() {
  const initialize = useOperatorStore((state) => state.initialize);
  const initialized = useOperatorStore((state) => state.initialized);
  const needsBootstrap = useOperatorStore((state) => state.needsBootstrap);
  const initializationStarted = useRef(false);
  const [initializationError, setInitializationError] = useState(false);
  const [recoveryRequested, setRecoveryRequested] = useState(false);

  useEffect(() => {
    if (initializationStarted.current) return;
    initializationStarted.current = true;
    void initialize().catch(() => setInitializationError(true));
  }, [initialize]);

  if (!initialized) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-canvas p-6">
        <div className="w-full max-w-sm rounded-lg border border-tech-border bg-white px-5 py-4 text-sm text-tech-muted shadow-sm" role={initializationError ? 'alert' : 'status'}>
          {initializationError ? '无法读取本地用户信息，请重新打开应用后再试。' : '正在读取本地用户信息...'}
        </div>
      </main>
    );
  }

  if (needsBootstrap || recoveryRequested) {
    return (
      <LocalUserSetup
        recoveryOnly={!needsBootstrap}
        onClose={recoveryRequested ? () => setRecoveryRequested(false) : undefined}
        onRecoveryComplete={recoveryRequested ? () => setRecoveryRequested(false) : undefined}
      />
    );
  }

  return (
    <BrowserRouter>
      <AppShell onRequestRecovery={() => setRecoveryRequested(true)}>
        <Routes>
          <Route path="/" element={<JobListPage />} />
          <Route path="/jobs/:id" element={<JobDetailPage />} />
          <Route path="/collections" element={<CollectionListPage />} />
          <Route path="/collections/:id" element={<CollectionDetailPage />} />
          <Route path="/skills" element={<SkillListPage />} />
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
