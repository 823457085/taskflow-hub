const shellQuote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";

export const bridgeInstallCommand = (origin: string, deviceName = '我的开发电脑', projectIds: string[] = [], replace = false) =>
  `curl -fsSk ${origin}/install-bridge.sh -o /tmp/taskflow-install.sh && ${replace ? 'TASKFLOW_REPLACE_BRIDGE=1 ' : ''}sh /tmp/taskflow-install.sh ${origin} ${shellQuote(deviceName)}${projectIds.length ? ` codex-cli ${shellQuote(projectIds.join(','))}` : ''}`;
