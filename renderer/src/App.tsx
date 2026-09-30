import { ArticlesPage } from './pages/ArticlesPage';
import { WechatBenchmarksPage } from './pages/WechatBenchmarksPage';
import { ArticleDetailPage } from './pages/ArticleDetailPage';
import { useEffect, useRef } from 'react';
import { RouterProvider, Outlet } from 'react-router-dom';
import { createAppRouter } from './utils/appRouter';
import { JobListPage } from './pages/JobListPage';
import { JobDetailPage } from './pages/JobDetailPage';
import { TrashPage } from './pages/TrashPage';
import { SettingsPage } from './pages/SettingsPage';
import { CollectionListPage } from './pages/CollectionListPage';
import { CollectionDetailPage } from './pages/CollectionDetailPage';
import { SkillListPage } from './pages/SkillListPage';
import { AssetsPage } from './pages/AssetsPage';
import { PublishingPage } from './pages/PublishingPage';
import { GalleriesPage } from './pages/GalleriesPage';
import { GalleryDetailPage } from './pages/GalleryDetailPage';
import { HotspotsPage } from './pages/HotspotsPage';
import { PublishingDuePoller } from './components/PublishingDuePoller';
import { AppShell } from './components/shell/AppShell';
import { useOperatorStore } from './store/operator';

const router = createAppRouter([{
  element: <AppShell><Outlet /></AppShell>,
  children: [
    { path: '/', element: <JobListPage /> },
    { path: '/articles', element: <ArticlesPage /> },
    { path: '/articles/benchmarks', element: <WechatBenchmarksPage /> },
    { path: '/articles/:id', element: <ArticleDetailPage /> },
    { path: '/hotspots', element: <HotspotsPage /> },
    { path: '/jobs/:id', element: <JobDetailPage /> },
    { path: '/galleries', element: <GalleriesPage /> },
    { path: '/galleries/:id', element: <GalleryDetailPage /> },
    { path: '/collections', element: <CollectionListPage /> },
    { path: '/collections/:id', element: <CollectionDetailPage /> },
    { path: '/skills', element: <SkillListPage /> },
    { path: '/assets', element: <AssetsPage /> },
    { path: '/publishing', element: <PublishingPage /> },
    { path: '/trash', element: <TrashPage /> },
    { path: '/settings', element: <SettingsPage /> },
  ],
}]);

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
        <div className="w-full max-w-sm rounded-lg border border-line bg-panel px-5 py-4 text-sm text-ink-muted shadow-sm" role="status">
          正在准备本机操作者...
        </div>
      </main>
    );
  }

  return (
    <RouterProvider router={router} />
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
