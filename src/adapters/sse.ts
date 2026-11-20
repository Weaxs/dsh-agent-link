import type { IncomingMessage } from 'node:http';
import { StringDecoder } from 'node:string_decoder';

const MAX_SSE_BUFFER = 4 * 1024 * 1024;

export interface SseEvent {
  id?: string;
  event?: string;
  data: string;
}

export async function* readSse(response: IncomingMessage): AsyncIterable<SseEvent> {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  for await (const chunk of response) {
    const piece = typeof chunk === 'string' ? chunk : decoder.write(chunk);
    buffer += piece.replaceAll('\r\n', '\n');
    if (buffer.length > MAX_SSE_BUFFER) throw new Error(`SSE buffer exceeds ${MAX_SSE_BUFFER} bytes`);
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const parsed = parseFrame(frame);
      if (parsed) yield parsed;
      boundary = buffer.indexOf('\n\n');
    }
  }
  buffer += decoder.end().replaceAll('\r\n', '\n');
  if (buffer.trim()) {
    const parsed = parseFrame(buffer);
    if (parsed) yield parsed;
  }
}

function parseFrame(frame: string): SseEvent | undefined {
  const data: string[] = [];
  let id: string | undefined;
  let event: string | undefined;
  for (const line of frame.split('\n')) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    else if (line.startsWith('id:')) id = line.slice(3).trim();
    else if (line.startsWith('event:')) event = line.slice(6).trim();
  }
  if (data.length === 0) return undefined;
  return { ...(id === undefined ? {} : { id }), ...(event === undefined ? {} : { event }), data: data.join('\n') };
}
