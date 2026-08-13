import { tool } from "@opencode-ai/plugin"
import type { KeyPool } from "./pool.ts"
import type { RelayProvider } from "./types.ts"
import {
  KEYCHAIN_JSON_KEY,
  ENV_KEYS_SUFFIX,
  envFilePath,
  readEnvFile,
  writeEnvKey,
  removeEnvKey,
  writeAuthKey,
  removeAuthKey,
  maskKey,
  displayProviderName,
  importFromAuthJson,
} from "./shared.ts"
import { readKeychainJson, writeKeychainJson } from "./config.ts"

export interface ToolContext {
  directory: string
  pool: KeyPool
  resolveProvider: (input: string) => string | undefined
  providers: () => Map<string, RelayProvider>
  refreshModels: (providerID: string) => Promise<{ ok: boolean; count: number }>
  toast: (message: string, variant: string, duration?: number) => void
}

function authEnvKey(providerID: string): string {
  return `${providerID.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}${ENV_KEYS_SUFFIX}`
}

function allKeysFor(ctx: ToolContext, providerID: string): string[] {
  const envPath = envFilePath(ctx.directory)
  const envVars = readEnvFile(envPath)
  const json = readKeychainJson(envVars)
  const fromJson = json.get(providerID)
  if (fromJson && fromJson.length > 0) return fromJson
  const raw = envVars.get(authEnvKey(providerID))
  if (raw) return raw.split(",").map((k) => k.trim()).filter(Boolean)
  return []
}

function rehydratePool(ctx: ToolContext, providerID: string, keys: string[]): void {
  const provider = ctx.providers().get(providerID)
  if (!provider) return
  const updated: RelayProvider = { ...provider, keys }
  ctx.pool.register(updated)
}

export function createTools(ctx: ToolContext) {
  return {
    "relaypool-status": tool({
      description:
        "opencode-relay-pool: Show live status of all relay account pools — active, quarantined, disabled keys, weights, retry timers, and discovered model counts.",
      args: {},
      async execute() {
        const ids = ctx.pool.allProviderIDs()
        if (ids.length === 0) {
          return "opencode-relay-pool: No relay providers configured. Configure `provider.<id>.options.relayPool` in opencode.json or run relaypool-setup."
        }
        const lines: string[] = []
        for (const providerID of ids) {
          const keys = ctx.pool.status(providerID)
          const discovered = ctx.providers().get(providerID)?.discovery
          lines.push(`## ${displayProviderName(providerID)} (${keys.length} key${keys.length === 1 ? "" : "s"})`)
          for (const k of keys) {
            const masked = maskKey(k.key)
            const weight = k.weight > 1 ? ` — weight: ${k.weight}x` : ""
            if (k.status === "active") {
              lines.push(`  [active]   ${masked}${weight}`)
            } else if (k.status === "quarantined") {
              const backoff = k.retryAfterMs
                ? `${Math.ceil(k.retryAfterMs / 1000)}s`
                : `${Math.ceil((k.quarantinedUntil - Date.now()) / 1000)}s`
              lines.push(`  [QUAR]     ${masked}${weight} — backoff ${backoff}, error #${k.consecutiveErrors}: ${k.lastErrorMessage}`)
            } else {
              lines.push(`  [DISABLED] ${masked}${weight} — reason: ${k.lastErrorMessage}`)
            }
          }
          const active = keys.filter((k) => k.status === "active").length
          const quarantined = keys.filter((k) => k.status === "quarantined").length
          const disabled = keys.filter((k) => k.status === "disabled").length
          lines.push(`  ### Summary: ${active} active, ${quarantined} quarantined, ${disabled} disabled`)
          if (discovered?.enabled === false) lines.push("  ### Model discovery: disabled")
          lines.push("")
        }
        return lines.join("\n")
      },
    }),

    "relaypool-setup": tool({
      description:
        "opencode-relay-pool: Save API keys into a relay provider account pool. Keys can be comma or newline separated. Supports multi-key failover and auto model discovery.",
      args: {
        provider: tool.schema.string().describe("Provider/relay id, e.g. myrelay, nexusvai, openrouter"),
        keys: tool.schema.string().describe("API keys, comma or newline separated (multi-key enables failover), e.g. sk-xxx,sk-yyy"),
        base_url: tool.schema
          .string()
          .optional()
          .describe("Optional base URL of the relay (e.g. https://api.example.com/v1). Needed only when provider is not yet in opencode.json."),
      },
      async execute({ provider, keys, base_url }: { provider: string; keys: string; base_url?: string }) {
        const resolved = ctx.resolveProvider(provider) ?? provider
        const newKeys = keys.replace(/\n/g, ",").split(",").map((k) => k.trim()).filter(Boolean)
        if (newKeys.length === 0) return "opencode-relay-pool: No valid keys provided."

        const envPath = envFilePath(ctx.directory)
        const envVars = readEnvFile(envPath)
        const json = readKeychainJson(envVars)
        const existing = json.get(resolved) ?? []
        const merged = [...new Set([...existing, ...newKeys])]
        json.set(resolved, merged)
        await writeKeychainJson(envPath, json)
        await writeEnvKey(envPath, authEnvKey(resolved), merged.join(","))
        process.env[authEnvKey(resolved)] = merged.join(",")
        process.env[KEYCHAIN_JSON_KEY] = JSON.stringify(Object.fromEntries(json))

        if (base_url && base_url.trim().length > 0) {
          await writeEnvKey(envPath, `${authEnvKey(resolved).slice(0, -ENV_KEYS_SUFFIX.length)}_BASE_URL`, base_url.trim())
        }

        rehydratePool(ctx, resolved, merged)
        if (merged.length > 0) {
          try {
            writeAuthKey(resolved, merged[0])
          } catch {
            // best-effort
          }
        }
        ctx.toast(`Saved ${newKeys.length} key(s) for ${resolved}.`, "success")
        return `opencode-relay-pool: Successfully saved ${newKeys.length} key(s) for ${resolved}. Use /models to pick a model.`
      },
    }),

    "relaypool-remove": tool({
      description:
        "opencode-relay-pool: Remove API keys from a relay account pool. Without 'key' arg removes ALL keys; with 'key' removes specific key(s).",
      args: {
        provider: tool.schema.string().describe("Provider/relay id"),
        key: tool.schema.string().optional().describe("Optional: key(s) to remove, comma-separated"),
      },
      async execute({ provider, key }: { provider: string; key?: string }) {
        const resolved = ctx.resolveProvider(provider) ?? provider
        const envPath = envFilePath(ctx.directory)
        const envVars = readEnvFile(envPath)
        const json = readKeychainJson(envVars)
        const existingKeys = json.get(resolved) ?? []
        if (existingKeys.length === 0) return `No keys found for ${displayProviderName(resolved)}.`

        if (key) {
          const toRemove = key.split(",").map((k) => k.trim()).filter(Boolean)
          const remaining = existingKeys.filter((k) => !toRemove.includes(k))
          if (remaining.length === existingKeys.length) return "Specified key(s) not found."
          if (remaining.length === 0) {
            json.delete(resolved)
            removeAuthKey(resolved)
          } else {
            json.set(resolved, remaining)
            try {
              writeAuthKey(resolved, remaining[0])
            } catch {
              // best-effort
            }
          }
          await writeKeychainJson(envPath, json)
          await writeEnvKey(envPath, authEnvKey(resolved), remaining.join(","))
          process.env[authEnvKey(resolved)] = remaining.join(",")
          process.env[KEYCHAIN_JSON_KEY] = JSON.stringify(Object.fromEntries(json))
          rehydratePool(ctx, resolved, remaining)
          ctx.toast(`Removed ${existingKeys.length - remaining.length} key(s).`, "success")
          return `Removed ${existingKeys.length - remaining.length} key(s).`
        }

        json.delete(resolved)
        await writeKeychainJson(envPath, json)
        await removeEnvKey(envPath, authEnvKey(resolved))
        delete process.env[authEnvKey(resolved)]
        process.env[KEYCHAIN_JSON_KEY] = json.size > 0 ? JSON.stringify(Object.fromEntries(json)) : ""
        removeAuthKey(resolved)
        ctx.toast(`Removed all keys from ${displayProviderName(resolved)}.`, "success")
        return `Removed all keys.`
      },
    }),

    "relaypool-reset": tool({
      description:
        "opencode-relay-pool: Reset all quarantined/disabled keys back to active. No arguments.",
      args: {},
      async execute() {
        const reset: string[] = []
        for (const providerID of ctx.pool.allProviderIDs()) {
          const before = ctx.pool.status(providerID).filter((k) => k.status !== "active").length
          ctx.pool.resetAll(providerID)
          reset.push(`${displayProviderName(providerID)}: ${before} keys reset`)
        }
        return reset.length > 0 ? `Reset: ${reset.join(", ")}` : "All keys already active."
      },
    }),

    "relaypool-switch": tool({
      description:
        "opencode-relay-pool: Manually switch the active key of a provider's account pool. Without 'key', rotates to the next usable key. With 'key', switches to that specific key. Updates auth.json immediately.",
      args: {
        provider: tool.schema.string().describe("Provider/relay id, e.g. nexusvai, myrelay"),
        key: tool.schema.string().optional().describe("Optional: specific full key to switch to"),
      },
      async execute({ provider, key }: { provider: string; key?: string }) {
        const resolved = ctx.resolveProvider(provider) ?? provider
        if (!ctx.pool.has(resolved)) {
          return `opencode-relay-pool: No account pool for ${displayProviderName(resolved)}. Configure keys first (relaypool-setup).`
        }
        const all = ctx.pool.status(resolved)
        if (all.length === 0) return `No keys in pool for ${displayProviderName(resolved)}.`

        let next: string
        if (key) {
          const target = all.find((k) => k.key === key)
          if (!target) return "Specified key is not in the pool."
          if (target.status === "disabled") return "Specified key is disabled (auth failed previously). Use relaypool-reset to re-enable."
          next = target.key
        } else {
          next = ctx.pool.pick(resolved)
        }
        try {
          writeAuthKey(resolved, next)
        } catch {
          // best-effort
        }
        ctx.toast(`Switched ${displayProviderName(resolved)} to ${maskKey(next)}.`, "success")
        return `Switched ${displayProviderName(resolved)} to ${maskKey(next)}.`
      },
    }),

    "relaypool-refresh": tool({
      description:
        "opencode-relay-pool: Manually trigger model discovery for a relay provider, refreshing the /models list immediately.",
      args: {
        provider: tool.schema.string().optional().describe("Provider/relay id. Omit to refresh all configured providers."),
      },
      async execute({ provider }: { provider?: string }) {
        const ids = provider
          ? [ctx.resolveProvider(provider) ?? provider]
          : Array.from(ctx.providers().keys())
        if (ids.length === 0) return "relaypool-refresh: No relay providers configured."
        const results: string[] = []
        for (const id of ids) {
          if (!ctx.providers().has(id)) {
            results.push(`${id}: not a registered relay provider`)
            continue
          }
          const r = await ctx.refreshModels(id)
          results.push(`${id}: ${r.ok ? `${r.count} models` : "discovery failed"}`)
        }
        return `relaypool-refresh:\n${results.join("\n")}`
      },
    }),

    "relaypool-import": tool({
      description:
        "opencode-relay-pool: Import existing API keys from opencode auth.json into relay pools (one key per provider).",
      args: {},
      async execute() {
        const imported = importFromAuthJson()
        if (imported.size === 0) return "No API-type credentials found in auth.json."
        const envPath = envFilePath(ctx.directory)
        const envVars = readEnvFile(envPath)
        const json = readKeychainJson(envVars)
        let added = 0
        for (const [id, entry] of imported) {
          if (json.has(id)) continue
          json.set(id, entry.keys)
          rehydratePool(ctx, id, entry.keys)
          added++
        }
        if (added > 0) {
          await writeKeychainJson(envPath, json)
          process.env[KEYCHAIN_JSON_KEY] = JSON.stringify(Object.fromEntries(json))
        }
        return `Imported ${added} provider(s) from auth.json.`
      },
    }),
  }
}
