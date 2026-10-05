import { describe, expect, it } from 'vitest'
import { cleanupParcels, handleParcel } from './BridgeParcels.js'

class MemoryStorage {
  values = new Map()
  alarm = 0

  async get(key) {
    return structuredClone(this.values.get(key))
  }

  async put(key, value) {
    this.values.set(key, structuredClone(value))
  }

  async delete(key) {
    this.values.delete(key)
  }

  async transaction(task) {
    return task(this)
  }

  async setAlarm(value) {
    this.alarm = value
  }
}

function create(storage, size = 40) {
  return handleParcel(
    new Request('https://worker.example/api/bridge/parcels/create', {
      method: 'POST',
      body: JSON.stringify({ size, chunks: 1 }),
    }),
    storage,
    'test-device',
  )
}

describe('BridgeParcels', () => {
  it('expires incomplete uploads and frees their per-device capacity', async () => {
    const storage = new MemoryStorage()
    for (let index = 0; index < 4; index++) expect((await create(storage)).status).toBe(200)
    expect((await create(storage)).status).toBe(429)

    await cleanupParcels(storage, Date.now() + 31 * 60 * 1000)

    expect([...storage.values.keys()]).toEqual(['parcel-index'])
    expect((await create(storage)).status).toBe(200)
  })

  it('rejects parcel allocations outside the declared size and chunk limits', async () => {
    const storage = new MemoryStorage()
    expect((await create(storage, 18 * 1024 * 1024)).status).toBe(413)
    const response = await handleParcel(
      new Request('https://worker.example/api/bridge/parcels/create', {
        method: 'POST',
        body: JSON.stringify({ size: 40, chunks: 66 }),
      }),
      storage,
      'test-device',
    )
    expect(response.status).toBe(413)
  })
})
