import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from './Worker.js'

describe('SRL Worker Public entry', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('serves a Koofr health endpoint with browser CORS', async () => {
    const response = await worker.fetch(
      new Request('https://worker.example/api/cloud/health', {
        headers: { origin: 'https://library.example' },
      }),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe('https://library.example')
    expect(response.headers.get('x-srl-cloud-proxy')).toBe('1')
  })

  it('forwards a Koofr request and exposes the marker header', async () => {
    const upstream = vi.fn().mockResolvedValue(
      new Response('ok', { status: 207, headers: { 'content-type': 'text/plain' } }),
    )
    vi.stubGlobal('fetch', upstream)
    const response = await worker.fetch(
      new Request(
        'https://worker.example/api/cloud/proxy/koofr?url=' +
          encodeURIComponent('https://app.koofr.net/dav/Koofr/SRL-Backups/'),
        { headers: { origin: 'https://library.example', authorization: 'Basic dGVzdA==' } },
      ),
    )
    expect(response.status).toBe(207)
    expect(response.headers.get('access-control-expose-headers')).toContain('x-srl-cloud-proxy')
    expect(upstream).toHaveBeenCalledWith(
      expect.objectContaining({ href: 'https://app.koofr.net/dav/Koofr/SRL-Backups/' }),
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('rejects non-Koofr targets without issuing an upstream request', async () => {
    const upstream = vi.fn()
    vi.stubGlobal('fetch', upstream)
    const response = await worker.fetch(
      new Request(
        'https://worker.example/api/cloud/proxy/koofr?url=' +
          encodeURIComponent('https://example.org/'),
      ),
    )
    expect(response.status).toBe(400)
    expect(upstream).not.toHaveBeenCalled()
  })
})
