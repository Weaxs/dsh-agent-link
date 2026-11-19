import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';

const tokenDirectory = '/tmp/dsh-e2e';
mkdirSync(tokenDirectory, { recursive: true });
const inspection = spawnSync('dsh', ['--profile', 'web', '--patch', `${tokenDirectory}/patch.yml`, '--dump-config'], {
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024,
});
if (inspection.status === 0) {
  const lines = inspection.stdout
    .split('\n')
    .filter((line) => /dsh-llm-pi-ai|openai|baseURL|apiKeyEnv|models:|glm-|reasoningEfforts|providers:/i.test(line));
  console.log(`DSH provider patch:\n${lines.join('\n')}`);
} else {
  console.error(`DSH config inspection failed: ${inspection.stderr}`);
}
const child = spawn(
  'dsh',
  ['--profile', 'web', '--patch', '/tmp/dsh-e2e/patch.yml', '--host', '127.0.0.1', '--port', '18791', '--no-open'],
  {
    env: { ...process.env, DSH_HOME: '/tmp/dsh-home' },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let output = '';
let tokenWritten = false;

function capture(chunk) {
  process.stdout.write(chunk);
  output = `${output}${chunk.toString('utf8')}`.slice(-200_000);
  const match = output.match(/[?&]token=([^&\s]+)/);
  if (match && !tokenWritten) {
    writeFileSync(`${tokenDirectory}/token`, decodeURIComponent(match[1]), { mode: 0o644 });
    tokenWritten = true;
  }
}
child.stdout.on('data', capture);
child.stderr.on('data', capture);
child.on('error', (error) => {
  console.error(error);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});

const proxy = http.createServer((request, response) => {
  const upstream = http.request(
    {
      host: '127.0.0.1',
      port: 18791,
      path: request.url,
      method: request.method,
      headers: { ...request.headers, host: '127.0.0.1:18791' },
    },
    (remote) => {
      response.writeHead(remote.statusCode ?? 502, remote.headers);
      remote.pipe(response);
    },
  );
  upstream.on('error', (error) => {
    response.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(`DSH loopback bridge: ${error.message}`);
  });
  request.pipe(upstream);
});
proxy.listen(18790, '0.0.0.0', () => {
  console.log('DSH loopback bridge listening on 18790');
});

function shutdown() {
  proxy.close();
  child.kill('SIGTERM');
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
