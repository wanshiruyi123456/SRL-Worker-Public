import { describe, expect, it, vi } from 'vitest'

import { BridgeSession } from './BridgeSession.js'

class MemoryStorage {
  constructor() {
    this.values = new Map()
    this.alarm = null
  }

  async get(key) {
    return this.values.get(key)
  }

  async put(key, value) {
    if (new TextEncoder().encode(JSON.stringify(value)).length >= 2 * 1024 * 1024) {
      throw new Error('SQLite value limit exceeded')
    }
    this.values.set(key, structuredClone(value))
  }

  async delete(key) {
    this.values.delete(key)
  }

  async deleteAll() {
    this.values.clear()
  }

  async setAlarm(value) {
    this.alarm = value
  }

  async transaction(callback) {
    return callback(this)
  }
}

function post(path, body) {
  return new Request(`https://example.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function read(response) {
  return response.status === 204 ? null : response.json()
}

describe('Cloudflare 设备码中继', () => {
  it('replays unacknowledged messages and deduplicates retried uploads even after acknowledgement', async () => {
    const storage = new MemoryStorage()
    const session = new BridgeSession({ storage })
    const id = crypto.randomUUID()
    const message = { type: 'file-end', transferId: 'same-import' }
    await session.enqueue('participant', message, id)
    const first = await session.takeQueue('participant', true)
    expect(await session.takeQueue('participant', true)).toEqual(first)
    expect(await session.enqueue('participant', message, id)).toBeNull()
    expect((await session.takeQueue('participant', true)).messages).toHaveLength(1)
    // An arbitrary ID cannot delete the other participant's data.
    await session.takeQueue('controller', true, first.deliveryIds)
    expect((await session.takeQueue('participant', true)).messages).toHaveLength(1)
    expect((await session.takeQueue('participant', true, first.deliveryIds)).messages).toEqual([])
    await session.enqueue('participant', message, id)
    expect((await session.takeQueue('participant', true)).messages).toEqual([])
    expect((await session.enqueue('participant', { type: 'different' }, id)).status).toBe(409)
  })
  it('stores a multi-megabyte queue as bounded values and drains legacy entries first', async () => {
    const storage = new MemoryStorage()
    const session = new BridgeSession({ storage })
    await storage.put('queue:participant', [{ type: 'legacy' }])
    for (let index = 0; index < 8; index += 1) {
      expect(await session.enqueue('participant', { index, data: 'x'.repeat(350_000) })).toBeNull()
    }
    const received = await session.takeQueue('participant')
    expect(received[0]).toEqual({ type: 'legacy' })
    expect(received.slice(1).map((entry) => entry.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(storage.values.size).toBe(0)
  })
  it('完成配对并在控制端和参与端之间传递消息', async () => {
    const storage = new MemoryStorage()
    const session = new BridgeSession({ storage })

    const initialized = await read(
      await session.fetch(
        post('/initialize', {
          code: 'AB12CD34',
          srlUrl: 'https://srl.example.test/',
        }),
      ),
    )
    const joined = await read(await session.fetch(post('/join', {})))

    expect(initialized.code).toBe('AB12CD34')
    expect(initialized.pairCode).toMatch(/^\d{6}$/)
    expect(joined.pairCode).toBe(initialized.pairCode)
    expect(joined.pairCode).not.toBe(initialized.code)
    expect(joined.srlUrl).toBe('https://srl.example.test/')
    expect(storage.alarm).toBeGreaterThan(Date.now())

    const controllerNotice = await read(
      await session.fetch(post('/poll', { token: initialized.controllerToken })),
    )
    expect(controllerNotice.messages).toEqual([
      { protocol: 'srl-tavern-bridge-v1', type: 'relay-joined' },
    ])

    const payload = { protocol: 'srl-tavern-bridge-v1', type: 'catalog', count: 12 }
    const sent = await session.fetch(
      post('/messages', {
        token: initialized.controllerToken,
        message: payload,
      }),
    )
    expect(sent.status).toBe(204)

    const participantMessages = await read(
      await session.fetch(post('/poll', { token: joined.participantToken })),
    )
    expect(participantMessages.messages).toEqual([payload])
  })

  it('拒绝无效令牌和超过 512 KB 的单条消息', async () => {
    const session = new BridgeSession({ storage: new MemoryStorage() })
    const initialized = await read(
      await session.fetch(post('/initialize', { code: 'AB12CD34', srlUrl: 'https://srl.test/' })),
    )
    await session.fetch(post('/join', {}))

    const unauthorized = await session.fetch(
      post('/messages', { token: 'invalid', message: { type: 'ping' } }),
    )
    expect(unauthorized.status).toBe(401)

    const oversized = await session.fetch(
      post('/messages', {
        token: initialized.controllerToken,
        message: { content: 'x'.repeat(513 * 1024) },
      }),
    )
    expect(oversized.status).toBe(413)
    await expect(oversized.json()).resolves.toMatchObject({ code: 'MESSAGE_TOO_LARGE' })
  })

  it('在有效轮询和传输时续期活跃会话', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-12T00:00:00.000Z'))
    try {
      const storage = new MemoryStorage()
      const session = new BridgeSession({ storage })
      const initialized = await read(
        await session.fetch(post('/initialize', { code: 'AB12CD34', srlUrl: 'https://srl.test/' })),
      )
      await session.fetch(post('/join', {}))
      const beforeExpiresAt = (await storage.get('session')).expiresAt

      vi.setSystemTime(new Date('2026-08-12T00:01:00.000Z'))
      await session.fetch(
        post('/messages', { token: initialized.controllerToken, message: { type: 'ping' } }),
      )
      const afterMessage = await storage.get('session')
      expect(afterMessage.expiresAt).toBeGreaterThan(beforeExpiresAt)
      expect(storage.alarm).toBe(afterMessage.expiresAt)
    } finally {
      vi.useRealTimers()
    }
  })
})
