// SRL-PUBLIC-SYNC: WORKER-SOURCE id=tavern-device-relay
import { json, readBody } from './WorkerHttp.js'

const BRIDGE_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'

function bridgeCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return [...bytes].map((byte) => BRIDGE_CODE_ALPHABET[byte % BRIDGE_CODE_ALPHABET.length]).join('')
}

function bridgeOriginIsAllowed(request) {
  const origin = request.headers.get('origin')
  if (!origin) return true
  // Tauri's Apple WebView uses this custom origin, unlike Windows/Android HTTP origins.
  if (origin === 'tauri://localhost') return true
  try {
    return ['http:', 'https:', 'capacitor:', 'ionic:'].includes(new URL(origin).protocol)
  } catch {
    return false
  }
}

export function withBridgeCors(response, request) {
  const origin = request.headers.get('origin')
  if (!origin || !bridgeOriginIsAllowed(request)) return response
  const headers = new Headers(response.headers)
  headers.set('access-control-allow-origin', origin)
  headers.set('access-control-allow-methods', 'GET, POST, OPTIONS')
  headers.set('access-control-allow-headers', 'content-type,x-srl-parcel-code,x-srl-parcel-index')
  headers.set('access-control-max-age', '86400')
  headers.append('vary', 'Origin')
  return new Response(response.body, { status: response.status, headers })
}

export async function handleBridge(request, env, pathname) {
  if (request.method === 'OPTIONS') {
    if (!bridgeOriginIsAllowed(request))
      return json({ code: 'ORIGIN_REJECTED', message: '中继请求来源无效' }, 403)
    return withBridgeCors(new Response(null, { status: 204 }), request)
  }
  if (!bridgeOriginIsAllowed(request))
    return json({ code: 'ORIGIN_REJECTED', message: '中继请求来源无效' }, 403)
  if (pathname === '/api/bridge/health' && request.method === 'GET')
    return withBridgeCors(
      json({ ok: true, service: 'srl-bridge-cloudflare', sessionTtlMinutes: 30 }),
      request,
    )
  if (request.method !== 'POST')
    return withBridgeCors(json({ code: 'METHOD_NOT_ALLOWED' }, 405), request)

  if (pathname.startsWith('/api/bridge/parcels/')) {
    const endpoint = pathname.slice('/api/bridge'.length)
    const headers = new Headers(request.headers)
    headers.set('x-srl-internal-client', request.headers.get('cf-connecting-ip') || 'unknown')
    const stub = env.BRIDGE_SESSIONS.get(env.BRIDGE_SESSIONS.idFromName('parcel-mailbox-v1'))
    const response = await stub.fetch(
      new Request(`https://bridge.internal${endpoint}`, {
        method: 'POST',
        headers,
        body: request.body,
        duplex: 'half',
      }),
    )
    return withBridgeCors(response, request)
  }

  if (pathname === '/api/bridge/sessions') {
    const body = await readBody(request.clone())
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = bridgeCode()
      const stub = env.BRIDGE_SESSIONS.get(env.BRIDGE_SESSIONS.idFromName(code))
      const response = await stub.fetch('https://bridge.internal/initialize', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, srlUrl: body.srlUrl }),
      })
      if (response.status !== 409) return withBridgeCors(response, request)
    }
    return withBridgeCors(
      json({ code: 'CODE_GENERATION_FAILED', message: '暂时无法创建设备码，请重试' }, 503),
      request,
    )
  }

  const body = await readBody(request.clone())
  const code = String(body.code ?? '')
    .trim()
    .toUpperCase()
  if (!/^[23456789A-HJ-NP-Z]{8}$/.test(code))
    return withBridgeCors(
      json({ code: 'INVALID_CODE', message: '请输入正确的 8 位设备码' }, 400),
      request,
    )
  const endpoint = pathname.slice('/api/bridge'.length)
  if (!['/join', '/messages', '/poll', '/close'].includes(endpoint))
    return withBridgeCors(json({ code: 'NOT_FOUND' }, 404), request)
  const stub = env.BRIDGE_SESSIONS.get(env.BRIDGE_SESSIONS.idFromName(code))
  const response = await stub.fetch(`https://bridge.internal${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return withBridgeCors(response, request)
}
