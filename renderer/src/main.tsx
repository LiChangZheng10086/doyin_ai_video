/// <reference types="vite/client" />
import './electron-bridge';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { initializeTheme } from './store/theme';

void initializeTheme(window).then(dispose => {
  if (import.meta.hot) import.meta.hot.dispose(dispose);
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
});
