import { useEffect, useState } from 'react';

function App() {
  const [serverPort, setServerPort] = useState<number | null>(null);
  const [version, setVersion] = useState<string>('');

  useEffect(() => {
    // 测试 Electron API
    const loadInfo = async () => {
      try {
        const port = await window.electron.getServerPort();
        const ver = await window.electron.getVersion();
        setServerPort(port);
        setVersion(ver);
      } catch (error) {
        console.error('Failed to load info:', error);
      }
    };

    loadInfo();
  }, []);

  return (
    <div style={{ padding: '20px', fontFamily: 'sans-serif' }}>
      <h1>🎬 抖音 AI 视频生成器</h1>
      <p>欢迎使用 Electron 桌面应用！</p>

      <div style={{ marginTop: '20px', padding: '15px', background: '#f0f0f0', borderRadius: '8px' }}>
        <h3>系统信息</h3>
        <p><strong>应用版本：</strong> {version || '加载中...'}</p>
        <p><strong>后端服务端口：</strong> {serverPort || '加载中...'}</p>
        <p><strong>后端地址：</strong> {serverPort ? `http://localhost:${serverPort}` : '加载中...'}</p>
      </div>

      <div style={{ marginTop: '20px' }}>
        <h3>✅ 基础架构已完成</h3>
        <ul>
          <li>✅ Electron 主进程</li>
          <li>✅ React 渲染进程</li>
          <li>✅ IPC 通信桥接</li>
          <li>✅ 配置管理系统</li>
          <li>✅ 嵌入式 Express 服务器（待完善）</li>
        </ul>
      </div>
    </div>
  );
}

export default App;
