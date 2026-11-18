// Stand-in for the workbench in tests: started with the remote preload, exercises the same Node APIs the workbench uses.
import { execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';

const home = process.env.HOME;
const project = path.join(home, 'proj');
const collect = child => new Promise(resolve => {
  let out = '';
  child.stdout.on('data', chunk => { out += chunk; });
  child.on('close', code => resolve({ code, out }));
});

async function probe() {
  const result = {};
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, 'a.txt'), 'hello from server');
  result.read = await readFile(path.join(project, 'a.txt'), 'utf8');
  result.existsSync = fs.existsSync(path.join(project, 'a.txt'));
  result.listing = fs.readdirSync(project, { withFileTypes: true }).map(entry => `${entry.name}:${entry.isFile() ? 'file' : 'dir'}`);
  result.statSize = fs.statSync(path.join(project, 'a.txt')).size;
  try { await readFile(path.join(home, '.ssh', 'id_ed25519')); result.ssh = 'READ'; } catch (error) { result.ssh = error.code; }
  await promisify(execFile)('git', ['init', '-q'], { cwd: project });
  result.git = execFileSync('git', ['-C', project, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' }).trim();
  const shell = spawn('sh', ['-c', 'pwd; cat'], { cwd: project });
  shell.stdin.end('piped-stdin');
  result.shell = (await collect(shell)).out;
  const node = spawn(process.execPath, ['-e', "process.stdout.write(require('fs').readFileSync(process.env.HOME + '/proj/a.txt', 'utf8'))"], { cwd: project });
  result.nodeChild = (await collect(node)).out;
  const local = path.join(process.env.DELIVERY_DATA_DIR, 'local.txt');
  fs.mkdirSync(path.dirname(local), { recursive: true });
  fs.writeFileSync(local, 'server-side');
  result.localData = fs.readFileSync(local, 'utf8');
  result.codex = await new Promise(resolve => execFile('codex', ['--version'], (error, stdout) => resolve(error ? error.code : stdout.trim())));
  return result;
}

http.createServer(async (req, res) => {
  if (req.url === '/probe') {
    let body, status = 200;
    try { body = JSON.stringify(await probe()); } catch (error) { status = 500; body = String(error?.stack || error); }
    res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(body);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<p>workbench ${req.headers.host} ${req.headers.origin || ''}</p>`);
}).listen(Number(process.env.PORT), '127.0.0.1');
