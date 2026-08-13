import type { KeyState, RelayProvider, SharedKeyState, SharedProviderState } from "./types.ts"
import { displayProviderName, maskKey, writeSharedState } from "./shared.ts"

const QUARANTINE_BASE_MS = 60_000
const QUARANTINE_CAP_MS = 300_000

export class KeyPool {
  private pools = new Map<string, KeyState[]>()
  private indexes = new Map<string, number>()

  private serialize(): void {
    const providers: SharedProviderState[] = []
    for (const providerID of this.pools.keys()) {
      const keys = this.pools.get(providerID)!
      const sharedKeys: SharedKeyState[] = keys.map((k) => ({
        key: maskKey(k.key),
        status: k.status,
        weight: k.weight,
        quarantinedUntil: k.quarantinedUntil,
        consecutiveErrors: k.consecutiveErrors,
        lastErrorAt: k.lastErrorAt,
        lastErrorMessage: k.lastErrorMessage,
        retryAfterMs: k.retryAfterMs,
      }))
      providers.push({
        id: providerID,
        name: displayProviderName(providerID),
        baseURL: "",
        keys: sharedKeys,
      })
    }
    writeSharedState(providers)
  }

  register(provider: RelayProvider): void {
    const previous = this.pools.get(provider.id) ?? []
    const previousByKey = new Map(previous.map((entry) => [entry.key, entry]))
    this.pools.set(
      provider.id,
      provider.keys.map((key) => {
        const existing = previousByKey.get(key)
        if (existing) {
          return { ...existing, weight: provider.weight[key] ?? existing.weight }
        }
        return {
          key,
          weight: provider.weight[key] ?? 1,
          status: "active" as const,
          quarantinedUntil: 0,
          consecutiveErrors: 0,
          lastErrorAt: 0,
          lastErrorMessage: "",
          retryAfterMs: null,
        }
      }),
    )
    if (!this.indexes.has(provider.id)) this.indexes.set(provider.id, 0)
    this.serialize()
  }

  has(providerID: string): boolean {
    return this.pools.has(providerID)
  }

  private pool(providerID: string): KeyState[] {
    const pool = this.pools.get(providerID)
    if (!pool) throw new Error(`Provider "${providerID}" not registered`)
    return pool
  }

  pick(providerID: string): string {
    const pool = this.pool(providerID)
    const now = Date.now()
    const released = pool.filter(
      (k) => k.status === "quarantined" && (k.quarantinedUntil === 0 || now >= k.quarantinedUntil),
    )
    for (const k of released) {
      k.status = "active"
      k.consecutiveErrors = 0
    }
    const available = pool.filter((k) => k.status !== "disabled")
    const active = available.filter((k) => k.status === "active")
    if (active.length === 0) {
      const quarantined = available.filter((k) => k.status === "quarantined")
      if (quarantined.length === 0) {
        throw new Error(`No active keys available for provider "${providerID}"`)
      }
      const earliest = quarantined.reduce((best, curr) =>
        curr.quarantinedUntil < best.quarantinedUntil ? curr : best,
      )
      earliest.status = "active"
      earliest.consecutiveErrors = 0
      active.push(earliest)
    }
    const slots: string[] = []
    for (const k of active) {
      const copies = Number.isFinite(k.weight) && k.weight > 0 ? Math.floor(k.weight) : 1
      for (let w = 0; w < copies; w++) slots.push(k.key)
    }
    if (slots.length === 0) {
      throw new Error(`No active keys available for provider "${providerID}"`)
    }
    const idx = (this.indexes.get(providerID)! + 1) % slots.length
    this.indexes.set(providerID, idx)
    return slots[idx]!
  }

  quarantine(providerID: string, key: string, retryAfterMs: number | null, reason: string): void {
    const entry = this.pool(providerID).find((k) => k.key === key)
    if (!entry) return
    entry.status = "quarantined"
    entry.consecutiveErrors++
    const factor = Math.min(entry.consecutiveErrors - 1, 4)
    const fallbackMs = Math.min(QUARANTINE_BASE_MS * Math.pow(2, factor), QUARANTINE_CAP_MS)
    entry.quarantinedUntil = Date.now() + (retryAfterMs && retryAfterMs > 0 ? retryAfterMs : fallbackMs)
    entry.lastErrorAt = Date.now()
    entry.lastErrorMessage = reason
    entry.retryAfterMs = retryAfterMs
    this.serialize()
  }

  disable(providerID: string, key: string, reason: string): void {
    const entry = this.pool(providerID).find((k) => k.key === key)
    if (!entry) return
    entry.status = "disabled"
    entry.lastErrorAt = Date.now()
    entry.lastErrorMessage = reason
    this.serialize()
  }

  status(providerID: string): KeyState[] {
    return [...this.pool(providerID)]
  }

  resetAll(providerID: string): void {
    const pool = this.pools.get(providerID)
    if (!pool) return
    for (const k of pool) {
      k.status = "active"
      k.consecutiveErrors = 0
      k.quarantinedUntil = 0
      k.retryAfterMs = null
      k.lastErrorMessage = ""
    }
    this.serialize()
  }

  allProviderIDs(): string[] {
    return Array.from(this.pools.keys())
  }

  count(): number {
    return this.pools.size
  }
}
