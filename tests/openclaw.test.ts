import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OpenClawAdapter } from '../src/adapters/openclaw.js'
import { loadOrCreateIdentity, signClaim } from '../src/adapters/openclaw-identity.js'

class FakeGateway {
  calls: Array<{ method: string; params: any }> = []
  private challenge = true
  isOpen = false
  async openWebSocket() { this.isOpen = true }
  async nextEvent() {
    if (this.challenge) {
      this.challenge = false
      return { done: false, value: { type: 'event', event: 'connect.challenge', payload: { nonce: 'nonce-1' } } }
    }
    return { done: false, value: { type: 'event', event: 'agent', payload: { runId: 'run-1', type: 'message.delta', delta: 'ok' } } }
  }
  async request(method: string, params: any) {
    this.calls.push({ method, params })
    if (method === 'connect') return { type: 'hello-ok' }
    if (method === 'health') return { ok: true }
    if (method === 'sessions.list') return { sessions: [{ key: 'agent:main:main', displayName: 'Main' }] }
    if (method === 'agent') return { runId: 'run-1', sessionKey: params.sessionKey }
    if (method === 'agent.wait') return { status: 'completed', output: 'finished' }
    if (method === 'sessions.abort') return {}
    throw new Error(`unexpected ${method}`)
  }
  async close() { this.isOpen = false }
}

afterEach(() => {
  delete process.env.OPENCLAW_GATEWAY_TOKEN
  delete process.env.DSH_AGENT_LINK_STATE_DIR
})

describe('OpenClaw adapter', () => {
  it('pairs with a nonce signature and reuses the session', async () => {
    process.env.OPENCLAW_GATEWAY_TOKEN = 'token'
    process.env.DSH_AGENT_LINK_STATE_DIR = mkdtempSync(join(tmpdir(), 'agent-link-'))
    const gateway = new FakeGateway()
    const adapter = new OpenClawAdapter('claw', { id: 'claw', kind: 'openclaw', transport: 'local' }, undefined, gateway as any)
    expect(await adapter.health()).toEqual({ ok: true })
    const connect = gateway.calls.find(call => call.method === 'connect')!
    expect(connect.params.device.signature).not.toBe('')
    expect(connect.params.device.nonce).toBe('nonce-1')
    expect(connect.params.auth.token).toBe('token')
    const events = []
    for await (const event of adapter.prompt('agent:main:test', 'work')) events.push(event)
    expect(events.at(-1)).toMatchObject({ type: 'final', text: 'finished' })
    expect(gateway.calls.find(call => call.method === 'agent')?.params.sessionKey).toBe('agent:main:test')
    await adapter.cancel('agent:main:test')
    expect(gateway.calls.at(-1)?.method).toBe('sessions.abort')
  })
})

describe('device identity', () => {
  it('persists the key and signs the v2 claim', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-link-id-'))
    const first = loadOrCreateIdentity('test', root)
    const second = loadOrCreateIdentity('test', root)
    expect(second.deviceId).toBe(first.deviceId)
    expect(signClaim(first, 'nonce', 'token')).toMatch(/^[a-zA-Z0-9_-]+$/)
  })
})
