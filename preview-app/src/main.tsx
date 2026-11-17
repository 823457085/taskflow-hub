import React, { useEffect, useMemo, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { App as AntApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { App } from './App';
import {
  applyTaskFlowThemeDom,
  buildAntdThemeConfig,
  loadTaskFlowTheme,
  resolveTaskFlowTheme,
  saveTaskFlowTheme,
  type TaskFlowThemeId,
} from './theme';
import 'antd/dist/reset.css';
import './index.css';

const Root: React.FC = () => {
  const [themeId, setThemeId] = useState<TaskFlowThemeId>(loadTaskFlowTheme);
  const themeMeta = useMemo(() => resolveTaskFlowTheme(themeId), [themeId]);
  const antdConfig = useMemo(() => buildAntdThemeConfig(themeId), [themeId]);

  useEffect(() => {
    applyTaskFlowThemeDom(themeMeta);
  }, [themeMeta]);

  const handleThemeChange = (next: TaskFlowThemeId) => {
    setThemeId(next);
    saveTaskFlowTheme(next);
    applyTaskFlowThemeDom(resolveTaskFlowTheme(next));
  };

  return (
    <ConfigProvider
      locale={zhCN}
      theme={antdConfig}
      drawer={{ classNames: { header: 'tf-drawer-header', body: 'tf-drawer-body', footer: 'tf-drawer-footer' } }}
      modal={{ classNames: { header: 'tf-modal-header', body: 'tf-modal-body', footer: 'tf-modal-footer' } }}
    >
      <AntApp className="tf-antd-app">
        <App themeId={themeId} onThemeChange={handleThemeChange} />
      </AntApp>
    </ConfigProvider>
  );
};

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
