/** Fixed local decoder process; no shell, arbitrary command, or user-supplied URL. */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
export function obtainPrecisionProofs(request) {
  return new Promise(resolve => {
    const child = spawn('/usr/bin/python3', [fileURLToPath(new URL('./ecmwf_precision.py', import.meta.url))],
      { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONUNBUFFERED: '1' } });
    let output = '', finished = false;
    const done = result => { if (!finished) { finished = true; clearTimeout(timer); resolve(result); } };
    const unavailable = () => ({ status: 'unavailable', intervals: [], error: 'Precision decoder failed or exceeded its budget' });
    const timer = setTimeout(() => { child.kill('SIGKILL'); done(unavailable()); }, 60000);
    child.on('error', () => done(unavailable()));
    child.stdin.on('error', () => {});
    child.stderr.on('data', () => {}); // Details stay in structured evidence, not public logs.
    child.stdout.on('data', bytes => {
      output += bytes.toString('utf8');
      if (Buffer.byteLength(output) > 2 * 1024 * 1024) { child.kill('SIGKILL'); done(unavailable()); }
    });
    child.on('close', code => {
      try { done(code === 0 ? JSON.parse(output) : unavailable()); }
      catch { done(unavailable()); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}
