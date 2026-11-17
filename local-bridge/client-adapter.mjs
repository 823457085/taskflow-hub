import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { parseClientAdapter } from '../shared/local-client-adapter.mjs';

export async function loadClientAdapter(path) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.size > 8192 || (process.getuid && info.uid !== process.getuid())) throw new Error('客户端适配器必须是当前用户所有、最大 8 KiB 的普通 JSON 文件。');
    const buffer = Buffer.alloc(8193);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > 8192) throw new Error('客户端适配器 JSON 不能超过 8 KiB。');
    return parseClientAdapter(buffer.subarray(0, size).toString('utf8'));
  } catch (error) {
    if (error.code) throw new Error('无法安全读取指定的客户端适配器 JSON 文件。');
    throw error;
  } finally { await handle?.close(); }
}
