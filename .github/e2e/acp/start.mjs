import { readFileSync } from 'node:fs';

if (process.env.AGENT_LINK_NATIVE_KIND === 'dsh') {
  const path = process.env.AGENT_LINK_DSH_TOKEN_FILE ?? '/tmp/dsh-e2e/token';
  let token = '';
  for (let attempt = 0; attempt < 120 && !token; attempt += 1) {
    try {
      token = readFileSync(path, 'utf8').trim();
    } catch {
      // The DSH container writes its random launch token after the web listener is ready.
    }
    if (!token) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!token) throw new Error(`DSH launch token was not written to ${path}`);
  process.env.DSH_GATEWAY_TOKEN = token;
}
await import('/app/dist/acp/cli.js');
