import type { IncomingMessage } from 'node:http'

export interface SseEvent {
  id?: string
  event?: string
  data: string
}

export async function* readSse(response: IncomingMessage): AsyncIterable<SseEvent> {
  let buffer = ''
  for await (const chunk of response) {
    buffer += chunk.toString('utf8').replaceAll('\r\n', '\n')
    let boundary: number
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const data: string[] = []
      let id: string | undefined
      let event: string | undefined
      for (const line of frame.split('\n')) {
        if (line.startsWith(':')) continue
        if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
        else if (line.startsWith('id:')) id = line.slice(3).trim()
        else if (line.startsWith('event:')) event = line.slice(6).trim()
      }
      if (data.length > 0) yield { ...(id === undefined ? {} : { id }), ...(event === undefined ? {} : { event }), data: data.join('\n') }
    }
  }
}
