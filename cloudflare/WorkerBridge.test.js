import { describe, expect, it, vi } from 'vitest'
import { handleBridge } from './WorkerBridge.js'

describe('Bridge native-origin CORS', () => {
  it.each([
    'tauri://localhost',
    'http://tauri.localhost',
    'https://tauri.localhost',
    'capacitor://localhost',
    'ionic://localhost',
    'https://srl.example.test',
  ])('allows preflight from %s for sessions and binary parcels', async (origin) => {
    for (const path of ['/api/bridge/sessions', '/api/bridge/parcels/upload']) {
      const response = await handleBridge(
        new Request(`https://srl.example.test${path}`, {
          method: 'OPTIONS',
          headers: {
            origin,
            'access-control-request-method': 'POST',
            'access-control-request-headers': 'content-type,x-srl-parcel-code,x-srl-parcel-index',
          },
        }),
        {},
        path,
      )
      expect(response.status).toBe(204)
      expect(response.headers.get('access-control-allow-origin')).toBe(origin)
      expect(response.headers.get('access-control-allow-headers')).toContain('x-srl-parcel-code')
      expect(response.headers.get('vary')).toContain('Origin')
      expect(response.headers.has('access-control-allow-credentials')).toBe(false)
    }
  })

  it.each(['null', 'file://', 'tauri://other', 'tauri://localhost.evil', 'tauri://localhost/path'])(
    'rejects unsupported origin %s without reaching session storage',
    async (origin) => {
      const get = vi.fn()
      for (const method of ['OPTIONS', 'POST']) {
        const response = await handleBridge(
          new Request('https://srl.example.test/api/bridge/sessions', {
            method,
            headers: { origin },
          }),
          { BRIDGE_SESSIONS: { get } },
          '/api/bridge/sessions',
        )
        expect(response.status).toBe(403)
        expect(response.headers.has('access-control-allow-origin')).toBe(false)
      }
      expect(get).not.toHaveBeenCalled()
    },
  )

  it.each([
    ['/api/bridge/sessions', { srlUrl: 'https://srl.example.test/' }, 201],
    ['/api/bridge/poll', { code: 'ABCDEFGH', token: 'invalid' }, 403],
    ['/api/bridge/parcels/create', {}, 400],
  ])('preserves service results and CORS for %s', async (path, body, status) => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ status }), { status }))
    const response = await handleBridge(
      new Request(`https://srl.example.test${path}`, {
        method: 'POST',
        headers: { origin: 'tauri://localhost', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      { BRIDGE_SESSIONS: { idFromName: (id) => id, get: () => ({ fetch }) } },
      path,
    )
    expect(fetch).toHaveBeenCalledOnce()
    expect(response.status).toBe(status)
    expect(response.headers.get('access-control-allow-origin')).toBe('tauri://localhost')
    expect(await response.json()).toEqual({ status })
  })
})
