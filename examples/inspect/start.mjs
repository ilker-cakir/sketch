import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const root = new URL('../..', import.meta.url);
const sketchUrl = 'http://127.0.0.1:3000/inspect';
const processes = [];

function run(name, command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? root,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    env: { ...process.env, ...options.env },
  });
  processes.push(child);
  child.stdout.on('data', (data) => process.stdout.write(`[${name}] ${data}`));
  child.stderr.on('data', (data) => process.stderr.write(`[${name}] ${data}`));
  child.on('exit', (code) => {
    if (code && !shuttingDown) process.exitCode = code;
  });
  return child;
}

async function waitFor(url) {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // wait
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

let shuttingDown = false;
function shutdown() {
  shuttingDown = true;
  for (const child of processes) child.kill('SIGTERM');
}

process.on('SIGINT', () => {
  shutdown();
  process.exit(0);
});
process.on('SIGTERM', shutdown);

run('sketch', 'pnpm', ['dev', '--host', '127.0.0.1', '--port', '3000']);
await waitFor(sketchUrl);
run('example', 'pnpm', [
  'exec',
  'vite',
  'examples/inspect',
  '--host',
  '127.0.0.1',
  '--port',
  '3001',
  '--open',
  '/',
]);
