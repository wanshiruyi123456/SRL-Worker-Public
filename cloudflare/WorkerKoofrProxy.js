import { CLOUD_PROXY_ERRORS, resolveCloudTarget } from '../server-shared/CloudProxyProtocol.mjs'
import { json } from './WorkerHttp.js'

// SRL-PUBLIC-SYNC: WORKER-SOURCE id=koofr-proxy-endpoint
const MAX_BODY_BYTES = 64 * 1024 * 1024
const REQUEST_HEADERS = [
  'accept',
  'authorization',
  'content-type',
  'depth',
  'destination',
  'if-match',
  'if-none-match',
  'overwrite',
  'range',
]
const RESPONSE_HEADERS = [
  'accept-ranges',
  'content-disposition',
  'content-length',
  'content-range',
  'content-type',
  'etag',
  'last-modified',
  'location',
  'retry-after',
]
const ALLOWED_METHODS = 'GET, HEAD, PUT, POST, DELETE, MKCOL, PROPFIND, OPTIONS'
const ALLOWED_HEADERS =
  'accept, authorization, content-type, depth, destination, if-match, if-none-match, overwrite, range, x-srl-content-length'
const EXPOSED_HEADERS = [...RESPONSE_HEADERS, 'x-srl-cloud-proxy'].join(', ')

function originIsAllowed(origin) {
  if (!origin) return true
  if (origin === 'tauri://localhost') return true
  try {
    return ['http:', 'https:', 'capacitor:', 'ionic:'].includes(new URL(origin).protocol)
  } catch {
    return false
  }
}

export function withKoofrCors(response, request) {
  const origin = request.headers.get('origin')
  if (!origin || !originIsAllowed(origin)) return response
  const headers = new Headers(response.headers)
  headers.set('access-control-allow-origin', origin)
  headers.set('access-control-allow-methods', ALLOWED_METHODS)
  headers.set('access-control-allow-headers', ALLOWED_HEADERS)
  headers.set('access-control-expose-headers', EXPOSED_HEADERS)
  headers.set('access-control-max-age', '86400')
  headers.append('vary', 'Origin')
  return new Response(response.body, { status: response.status, headers })
}

function proxyResponse(body, status = 200, headers = {}) {
  return json(body, status, { 'x-srl-cloud-proxy': '1', ...headers })
}

function requestHeaders(source) {
  const headers = new Headers()
  for (const name of REQUEST_HEADERS) {
    const value = source.get(name)
    if (value) headers.set(name, value)
  }
  return headers
}

export async function handleKoofrProxy(request, pathname) {
  if (request.method === 'OPTIONS') {
    if (!originIsAllowed(request.headers.get('origin')))
      return withKoofrCors(proxyResponse({ code: 'ORIGIN_REJECTED' }, 403), request)
    return withKoofrCors(new Response(null, { status: 204 }), request)
  }
  if (pathname === '/api/cloud/health' && request.method === 'GET')
    return withKoofrCors(proxyResponse({ ok: true, service: 'srl-koofr-worker' }), request)
  if (pathname !== '/api/cloud/proxy/koofr')
    return withKoofrCors(
      proxyResponse({ code: 'NOT_FOUND', message: '云端代理接口不存在' }, 404),
      request,
    )
  if (!originIsAllowed(request.headers.get('origin')))
    return withKoofrCors(proxyResponse({ code: 'ORIGIN_REJECTED' }, 403), request)

  const target = resolveCloudTarget('koofr', new URL(request.url).searchParams.get('url'))
  if (!target)
    return withKoofrCors(proxyResponse(CLOUD_PROXY_ERRORS.invalidTarget, 400), request)

  const hasBody = !['GET', 'HEAD'].includes(request.method)
  const declaredLength = Number(
    request.headers.get('x-srl-content-length') ?? request.headers.get('content-length') ?? 0,
  )
  if (
    hasBody &&
    (!Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength > MAX_BODY_BYTES)
  ) {
    return withKoofrCors(
      proxyResponse(
        {
          code: 'CLOUD_REQUEST_TOO_LARGE',
          message: '单次云端请求不能超过 64 MiB，请使用自动分卷上传',
        },
        declaredLength > MAX_BODY_BYTES ? 413 : 400,
      ),
      request,
    )
  }

  let body
  if (hasBody) {
    body = await request.arrayBuffer()
    if (declaredLength && body.byteLength !== declaredLength) {
      return withKoofrCors(
        proxyResponse(
          {
            code: 'CLOUD_CONTENT_LENGTH_MISMATCH',
            message: '云端上传内容长度不一致，请重试当前分卷',
          },
          400,
        ),
        request,
      )
    }
  }

  let upstream
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers: requestHeaders(request.headers),
      body,
      redirect: 'follow',
      signal: request.signal,
    })
  } catch {
    return withKoofrCors(
      proxyResponse(
        {
          code: 'CLOUD_UPSTREAM_UNREACHABLE',
          message: 'Koofr 上游暂时无法连接，请稍后重试',
        },
        502,
      ),
      request,
    )
  }

  const headers = new Headers()
  for (const name of RESPONSE_HEADERS) {
    const value = upstream.headers.get(name)
    if (value) headers.set(name, value)
  }
  headers.set('x-srl-cloud-proxy', '1')
  return withKoofrCors(
    new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    }),
    request,
  )
}
