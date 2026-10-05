/* global URL */

export const CLOUD_PROXY_ERRORS = Object.freeze({
  invalidTarget: Object.freeze({
    code: 'INVALID_TARGET',
    message: '云端目标地址未获允许',
  }),
  invalidContentLength: Object.freeze({
    code: 'CLOUD_CONTENT_LENGTH_INVALID',
    message: '云端请求大小格式无效',
  }),
})

export function resolveCloudTarget(provider, rawUrl) {
  let target
  try {
    target = new URL(String(rawUrl ?? ''))
  } catch {
    return null
  }
  if (target.protocol !== 'https:') return null
  if (
    provider === 'koofr' &&
    target.hostname === 'app.koofr.net' &&
    (target.pathname === '/dav/Koofr' || target.pathname.startsWith('/dav/Koofr/'))
  ) {
    return target
  }
  return null
}
