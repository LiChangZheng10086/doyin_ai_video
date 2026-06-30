import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom';
import { JobListPage } from './pages/JobListPage';
import { JobDetailPage } from './pages/JobDetailPage';
import { SettingsPage } from './pages/SettingsPage';
import { ApiKeyStatusIndicator } from './components/ApiKeyStatusIndicator';

function Navigation() {
  const location = useLocation();

  return (
    <div className="min-h-screen bg-tech-bg">
      {/* Header */}
      <header className="bg-tech-surface border-b border-tech-border shadow-sm">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-8">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-gradient-to-br from-tech-blue to-tech-blue-light rounded-lg flex items-center justify-center text-white text-xl">
                🎬
              </div>
              <div>
                <h1 className="text-lg font-semibold text-tech-text">
                  抖音 AI 视频生成器
                </h1>
                <p className="text-xs text-tech-muted">智能内容创作平台</p>
              </div>
            </div>

            {/* Navigation */}
            <nav className="flex items-center gap-1">
              <Link
                to="/"
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                  location.pathname === '/'
                    ? 'bg-tech-bg text-tech-text'
                    : 'text-tech-muted hover:text-tech-text hover:bg-tech-bg'
                }`}
              >
                任务列表
              </Link>
              <Link
                to="/settings"
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                  location.pathname === '/settings'
                    ? 'bg-tech-bg text-tech-text'
                    : 'text-tech-muted hover:text-tech-text hover:bg-tech-bg'
                }`}
              >
                ⚙️ 设置
              </Link>
            </nav>
          </div>

          <div className="flex items-center gap-4">
            <ApiKeyStatusIndicator />
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
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </main>
    </div>
  );
}

function App() {
  return (
    <BrowserRouter>
      <Navigation />
    </BrowserRouter>
  );
}

export default App;
