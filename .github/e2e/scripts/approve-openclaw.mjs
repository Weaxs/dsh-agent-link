import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
let lastError = '';

async function approvePending() {
  try {
    const { stdout } = await execute('openclaw', ['devices', 'list', '--json'], {
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const ids = requestIds(stdout);
    for (const id of ids) {
      await execute('openclaw', ['devices', 'approve', id], { timeout: 20_000 });
      console.log(`Approved OpenClaw device request ${id}`);
    }
  } catch (error) {
    const message = String(error.message ?? error);
    if (message !== lastError) {
      console.error(`OpenClaw pairing watcher: ${message.slice(0, 500)}`);
      lastError = message;
    }
  }
}

function requestIds(text) {
  try {
    const value = JSON.parse(text);
    const pending =
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value.pending ?? value.requests ?? value.pendingRequests ?? value)
        : value;
    return findIds(pending);
  } catch {
    return [...text.matchAll(/(?:requestId|request_id|deviceRequestId)["'\s:=]+([a-zA-Z0-9_-]+)/g)].map(
      (match) => match[1],
    );
  }
}

function findIds(value) {
  if (Array.isArray(value)) return [...new Set(value.flatMap(findIds))];
  if (!value || typeof value !== 'object') return [];
  const own =
    typeof value.requestId === 'string'
      ? [value.requestId]
      : typeof value.request_id === 'string'
        ? [value.request_id]
        : typeof value.deviceRequestId === 'string'
          ? [value.deviceRequestId]
          : [];
  return [...new Set([...own, ...Object.values(value).flatMap(findIds)])];
}

await approvePending();
setInterval(approvePending, 2_000);
