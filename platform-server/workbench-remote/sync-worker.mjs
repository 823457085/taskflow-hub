import { workerData } from 'node:worker_threads';
import { execRequest, fsRequest } from './client.mjs';

const { port, shared, config } = workerData;
const flag = new Int32Array(shared);

function reply(value) {
  port.postMessage(value);
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);
}

function exec(spec, input, maxBuffer) {
  return new Promise(resolve => {
    const stdout = [], stderr = [];
    let size = 0, result = null;
    const stream = execRequest(config, spec, frame => {
      if (result) return;
      if (frame.t === 'id') stream.id = frame.id;
      else if (frame.t === 'o' || frame.t === 'e') {
        const data = Buffer.from(frame.d, 'base64');
        size += data.length;
        (frame.t === 'o' ? stdout : stderr).push(data);
        if (size > maxBuffer) { result = { error: { code: 'ENOBUFS', message: '输出超过 maxBuffer' }, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), status: null, signal: 'SIGTERM' }; stream.destroy(); resolve(result); }
      } else if (frame.t === 'x') { result = { status: frame.code ?? null, signal: frame.signal ?? null, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }; resolve(result); }
      else if (frame.t === 'err') { result = { error: { code: frame.code || 'EIO', message: frame.message }, status: null, signal: null, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }; resolve(result); }
    });
    if (input?.length) stream.write(input);
    stream.end();
  });
}

port.on('message', async message => {
  try {
    if (message.kind === 'fs') reply(await fsRequest(config, message.op, message.args));
    else reply({ ok: true, value: await exec(message.spec, message.input && Buffer.from(message.input), message.maxBuffer || 64 * 1024 * 1024) });
  } catch (error) { reply({ ok: false, error: { code: 'EIO', message: error?.message || '同步调用失败' } }); }
});
