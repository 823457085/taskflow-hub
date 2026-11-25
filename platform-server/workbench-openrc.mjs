import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const service = 'taskflow-workbench-1';

export function openrcControl() {
  const call = (slot, action) => {
    if (slot !== 1) throw new Error('This host supports one workbench slot');
    return run('/usr/bin/doas', ['-n', '/sbin/rc-service', service, action], { timeout: 30_000 });
  };
  return {
    // Each boot issues new instance credentials. An OpenRC start on a running
    // supervisor is a no-op; restart always stages the newly issued settings.
    start: slot => call(slot, 'restart'),
    stop: slot => call(slot, 'stop'),
    restart: slot => call(slot, 'restart'),
    active: async slot => {
      try { await call(slot, 'status'); return true; } catch { return false; }
    },
  };
}
