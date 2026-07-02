import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom';
import { LayoutDashboard, Settings, Sparkles, Trash2, Video } from 'lucide-react';
import { JobListPage } from './pages/JobListPage';
import { JobDetailPage } from './pages/JobDetailPage';
import { TrashPage } from './pages/TrashPage';
import { SettingsPage } from './pages/SettingsPage';
import { ApiKeyStatusIndicator } from './components/ApiKeyStatusIndicator';

function Navigation() {
  const location = useLocation();
  const navItems = [
    { to: '/', label: '创作中心', icon: LayoutDashboard },
    { to: '/settings', label: '设置', icon: Settings },
    { to: '/trash', label: '垃圾桶', icon: Trash2 },
  ];

  return (
    <div className="min-h-screen bg-tech-bg">
      {/* Header */}
      <header className="bg-tech-surface border-b border-tech-border shadow-sm">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-8">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-gradient-to-br from-tech-blue to-tech-purple rounded-lg flex items-center justify-center text-white shadow-sm">
                <Video size={22} />
              </div>
              <div>
                <h1 className="text-lg font-semibold text-tech-text">
                  AI 视频创作中心
                </h1>
                <p className="text-xs text-tech-muted flex items-center gap-1">
                  <Sparkles size={12} className="text-tech-purple" />
                  从视频到文稿、PPT 与创作资产
                </p>
              </div>
            </div>

            {/* Navigation */}
            <nav className="flex items-center gap-1">
              {navItems.map((item) => {
                const Icon = item.icon;
                const active = item.to === '/'
                  ? location.pathname === '/' || location.pathname.startsWith('/jobs/')
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
          <Route path="/trash" element={<TrashPage />} />
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
