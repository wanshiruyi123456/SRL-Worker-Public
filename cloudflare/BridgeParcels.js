// SRL-PUBLIC-SYNC: WORKER-SOURCE id=tavern-encrypted-parcels
// Shared by the Durable Object and the VPS relay. Only encrypted binary chunks reach this store.
export const PARCEL_LIMIT = 17 * 1024 * 1024
const TOTAL_LIMIT = 128 * 1024 * 1024
const CHUNK_LIMIT = 256 * 1024 + 28
const TTL = 30 * 60 * 1000
const encoder = new TextEncoder()
const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
const fail = (message, status) => Object.assign(new Error(message), { status })
async function digest(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', value))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}
async function boundedBody(request, limit) {
  const reader = request.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.length
      if (length > limit) {
        await reader.cancel()
        throw fail('暂存请求超过大小限制', 413)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return bytes
}

export async function cleanupParcels(storage, now = Date.now()) {
  const index = (await storage.get('parcel-index')) ?? []
  const retained = []
  for (const item of index) {
    if (item.expiresAt > now) {
      retained.push(item)
      continue
    }
    for (let part = 0; part < item.chunks; part++) await storage.delete(`parcel:${item.id}:${part}`)
    await storage.delete(`parcel:${item.id}`)
  }
  await storage.put('parcel-index', retained)
  if (retained.length && storage.setAlarm)
    await storage.setAlarm(Math.min(...retained.map((item) => item.expiresAt)))
  return retained
}

export async function handleParcel(request, storage, client = 'local') {
  if (request.method !== 'POST') return json({ message: '暂存只支持 POST' }, 405)
  const action = new URL(request.url).pathname.split('/').at(-1)
  try {
    const upload = action === 'upload'
    const bytes = await boundedBody(request, upload ? CHUNK_LIMIT : 2048)
    const body = upload ? {} : JSON.parse(new TextDecoder().decode(bytes) || '{}')
    const code = upload ? request.headers.get('x-srl-parcel-code') : body.code
    if (action !== 'create' && (typeof code !== 'string' || !/^[a-f0-9]{64}$/.test(code)))
      throw fail('提取口令无效', 400)
    const id = action === 'create' ? '' : await digest(encoder.encode(code))
    const chunkHash = upload ? await digest(bytes) : ''
    const clientHash = await digest(encoder.encode(client))
    const response = await storage.transaction(async (store) => {
      const now = Date.now()
      const index = await cleanupParcels(store, now)
      if (action === 'create') {
        if (
          !Number.isInteger(body.size) ||
          body.size < 1 ||
          body.size > PARCEL_LIMIT ||
          !Number.isInteger(body.chunks) ||
          body.chunks < 1 ||
          body.chunks > 65
        )
          throw fail('单次暂存最多 16 MiB，最多 65 个分块', 413)
        if (
          index.length >= 16 ||
          index.reduce((sum, item) => sum + item.size, 0) + body.size > TOTAL_LIMIT
        )
          throw fail('暂存空间繁忙，请稍后重试', 429)
        if (index.filter((item) => item.client === clientHash).length >= 4)
          throw fail('当前设备已有 4 个暂存，请先领取或删除', 429)
        const code = [...crypto.getRandomValues(new Uint8Array(32))]
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join('')
        const id = await digest(encoder.encode(code))
        const meta = {
          id,
          size: body.size,
          chunks: body.chunks,
          expiresAt: now + TTL,
          client: clientHash,
          received: {},
          sealed: false,
        }
        await store.put(`parcel:${id}`, meta)
        await store.put('parcel-index', [
          ...index,
          {
            id,
            size: meta.size,
            chunks: meta.chunks,
            expiresAt: meta.expiresAt,
            client: clientHash,
          },
        ])
        if (store.setAlarm)
          await store.setAlarm(Math.min(meta.expiresAt, ...index.map((item) => item.expiresAt)))
        return json({ code, expiresAt: meta.expiresAt })
      }
      const meta = await store.get(`parcel:${id}`)
      if (!meta && action === 'remove') return new Response(null, { status: 204 })
      if (!meta) throw fail('暂存不存在或已过期，请重新发送', 410)
      if (action === 'upload') {
        if (meta.sealed) throw fail('暂存已封存，不能修改', 409)
        const part = Number(request.headers.get('x-srl-parcel-index'))
        if (!Number.isInteger(part) || part < 0 || part >= meta.chunks || bytes.length < 28)
          throw fail('暂存分块无效', 400)
        if (meta.received[part]) {
          if (meta.received[part].hash !== chunkHash) throw fail('重复分块内容不一致', 409)
        } else {
          if (
            Object.values(meta.received).reduce((sum, item) => sum + item.size, 0) + bytes.length >
            meta.size
          )
            throw fail('暂存超过声明大小', 413)
          await store.put(`parcel:${id}:${part}`, bytes.buffer)
          meta.received[part] = { size: bytes.length, hash: chunkHash }
          await store.put(`parcel:${id}`, meta)
        }
        return new Response(null, { status: 204 })
      }
      if (action === 'seal') {
        if (
          Object.keys(meta.received).length !== meta.chunks ||
          Object.values(meta.received).reduce((sum, item) => sum + item.size, 0) !== meta.size
        )
          throw fail('暂存尚未完整上传', 409)
        meta.sealed = true
        await store.put(`parcel:${id}`, meta)
        return json({ expiresAt: meta.expiresAt })
      }
      if (action === 'remove') {
        meta.expiresAt = 0
        await store.put(
          'parcel-index',
          index.map((item) => (item.id === id ? { ...item, expiresAt: 0 } : item)),
        )
        await cleanupParcels(store, now)
        return new Response(null, { status: 204 })
      }
      if (!meta.sealed) throw fail('发送端尚未完成上传，请等待“可以切换”提示', 409)
      if (action === 'info')
        return json({ size: meta.size, chunks: meta.chunks, expiresAt: meta.expiresAt })
      if (action === 'download') {
        if (!Number.isInteger(body.index) || body.index < 0 || body.index >= meta.chunks)
          throw fail('分块序号无效', 400)
        return new Response(await store.get(`parcel:${id}:${body.index}`), {
          headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' },
        })
      }
      return json({ message: '暂存操作不存在' }, 404)
    })
    if (storage.setAlarm) {
      const remaining = (await storage.get('parcel-index')) ?? []
      if (remaining.length)
        await storage.setAlarm(Math.min(...remaining.map((item) => item.expiresAt)))
    }
    return response
  } catch (error) {
    return json(
      { message: error.status ? error.message : '暂存服务无法处理请求' },
      error.status || 400,
    )
  }
}
