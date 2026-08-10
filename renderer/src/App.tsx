import { useEffect, useRef, useState } from 'react';
import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom';
import { Brain, LayoutDashboard, Send, Settings, Sparkles, Trash2, Users, Video } from 'lucide-react';
import { JobListPage } from './pages/JobListPage';
import { JobDetailPage } from './pages/JobDetailPage';
import { TrashPage } from './pages/TrashPage';
import { SettingsPage } from './pages/SettingsPage';
import { CollectionListPage } from './pages/CollectionListPage';
import { CollectionDetailPage } from './pages/CollectionDetailPage';
import { SkillListPage } from './pages/SkillListPage';
import { PublishingPage } from './pages/PublishingPage';
import { ApiKeyStatusIndicator } from './components/ApiKeyStatusIndicator';
import { CookieStatusIndicator } from './components/CookieStatusIndicator';
import { LocalUserSetup } from './components/LocalUserSetup';
import { OperatorSwitcher } from './components/OperatorSwitcher';
import { PublishingDuePoller } from './components/PublishingDuePoller';
import { useOperatorStore } from './store/operator';

function Navigation({ onRequestRecovery }: { onRequestRecovery: () => void }) {
  const location = useLocation();
  const navItems = [
    { to: '/', label: '创作中心', icon: LayoutDashboard },
    { to: '/collections', label: '合集', icon: Users },
    { to: '/skills', label: 'Skills', icon: Brain },
    { to: '/publishing', label: '发布中心', icon: Send },
    { to: '/settings', label: '设置', icon: Settings },
    { to: '/trash', label: '垃圾桶', icon: Trash2 },
  ];

  return (
    <div className="min-h-screen bg-tech-bg">
      {/* Header */}
      <header className="bg-tech-surface border-b border-tech-border shadow-sm">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-4 sm:px-6 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex min-w-0 flex-col gap-4 lg:flex-row lg:items-center lg:gap-8">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-gradient-to-br from-tech-blue to-tech-purple rounded-lg flex items-center justify-center text-white shadow-sm">
                <Video size={22} />
              </div>
              <div>
                <h1 className="text-lg font-semibold text-tech-text">
                  抖创工坊
                </h1>
                <p className="text-xs text-tech-muted flex items-center gap-1">
                  <Sparkles size={12} className="text-tech-purple" />
                   从采集到创作，AI 驱动的内容工坊
                </p>
              </div>
            </div>

            {/* Navigation */}
            <nav className="flex items-center gap-1 overflow-x-auto pb-1 lg:pb-0">
              {navItems.map((item) => {
                const Icon = item.icon;
                const active = item.to === '/'
                  ? location.pathname === '/' || location.pathname.startsWith('/jobs/')
                  : item.to === '/collections'
                    ? location.pathname === '/collections' || location.pathname.startsWith('/collections/')
                    : location.pathname === item.to;
                return (
                  <Link
                    key={item.to}
                    to={item.to}
                    className={`px-4 py-2 rounded-lg text-sm font-medium transition-all inline-flex items-center gap-2 ${
                      active
                        ? 'bg-blue-50 text-tech-blue'
                        : 'text-tech-muted hover:text-tech-text hover:bg-tech-bg'
                    }`}
                  >
                    <Icon size={16} />
                    {item.label}
                  </Link>
                );
              })}
            </nav>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <ApiKeyStatusIndicator />
            <CookieStatusIndicator />
            <OperatorSwitcher onRequestRecovery={onRequestRecovery} />
            <span className="text-xs text-tech-muted bg-tech-bg px-3 py-1 rounded-full">
              v0.1.0
            </span>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main>
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
      </main>
    </div>
  );
}

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
      <main className="flex min-h-screen items-center justify-center bg-tech-bg p-6">
        <div className="w-full max-w-sm rounded-lg border border-tech-border bg-tech-surface px-5 py-4 text-sm text-tech-muted shadow-sm" role={initializationError ? 'alert' : 'status'}>
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
      <Navigation onRequestRecovery={() => setRecoveryRequested(true)} />
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
