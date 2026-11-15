// One local rehearsal session. No API key, network service, or deployment required.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = code;
}
for (const [name, args] of [
  ['stores', ['fixtures/server.mjs']],
  ['analysis', [require.resolve('tsx/cli'), 'server/src/index.ts']],
]) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...process.env, LLM_PROVIDER: 'mock', PORT: '8787', FIXTURE_PORT: '4000', FIXTURE_LEGAL_PORT: '4001' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  children.push(child);
  child.on('error', (error) => { console.error(`[demo] ${name}: ${error.message}`); stop(1); });
  child.on('exit', (code, signal) => {
    if (!stopping) { console.error(`[demo] ${name} stopped (${signal || code}). Ending the rehearsal session.`); stop(code || 1); }
  });
}
console.log('\n[demo] Demo room: http://localhost:4000/\n[demo] Rules-only mock mode. Ctrl+C stops both services.\n');
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
