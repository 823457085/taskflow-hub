const shellQuote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";

export const bridgeInstallCommand = (origin: string, deviceName = '我的开发电脑') =>
  `curl -fsSk ${origin}/install-bridge.sh -o /tmp/taskflow-install.sh && sh /tmp/taskflow-install.sh ${origin} ${shellQuote(deviceName)}`;
