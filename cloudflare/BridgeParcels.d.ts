export interface ParcelStorage {
  get(key: string): Promise<unknown>
  put(key: string, value: unknown): Promise<unknown>
  delete(key: string): Promise<unknown>
  transaction<T>(callback: (store: unknown) => Promise<T>): Promise<T>
  setAlarm?(at: number): Promise<unknown>
}
export const PARCEL_LIMIT: number
export function handleParcel(
  request: Request,
  storage: ParcelStorage,
  client?: string,
): Promise<Response>
export function cleanupParcels(storage: ParcelStorage, now?: number): Promise<unknown[]>
