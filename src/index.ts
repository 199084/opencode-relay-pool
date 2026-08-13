import type { Plugin, PluginInput, PluginOptions as Options } from "@opencode-ai/plugin"
import type { RelayProvider } from "./types.ts"
import { KeyPool } from "./pool.ts"
import { collectProviders } from "./config.ts"
import { installFetchPatch, uninstallFetchPatch, registerProvider, isFetchPatched } from "./fetch-patch.ts"
import { discoverForProvider } from "./discovery.ts"
import { createTools } from "./tools.ts"
import { PLUGIN_NAME, writeAuthKey, displayProviderName } from "./shared.ts"

const DEBUG = Boolean(process.env.OPENCODE_RELAY_POOL_DEBUG)

function trace(msg: string, detail?: Record<string, unknown>): void {
  if (!DEBUG) return
  const time = new Date().toISOString().slice(11, 23)
  const suffix = detail ? ` | ${JSON.stringify(detail)}` : ""
  console.error(`[${PLUGIN_NAME} ${time}] ${msg}${suffix}`)
}

function providerIDFromAlias(input: string, providers: Map<string, RelayProvider>): string | undefined {
  const normalized = input.trim().toLowerCase()
  if (providers.has(normalized)) return normalized
  for (const id of providers.keys()) {
    if (id.toLowerCase() === normalized) return id
  }
  return undefined
}

export const server: Plugin = async (input: PluginInput, opts?: Options) => {
  const pool = new KeyPool()
  let providerMap = new Map<string, RelayProvider>()
  let activePoolIDs = new Set<string>()

  const toast = (message: string, variant: string, duration?: number): void => {
    try {
      void input.client.tui.showToast({
        body: { message, variant: variant as "error" | "warning" | "success" | "info", duration: duration ?? 5000 },
      })
    } catch {
      // ignore
    }
  }

  const registerIntoPool = (provider: RelayProvider): void => {
    if (provider.keys.length === 0) return
    pool.register(provider)
    registerProvider(provider.id, { header: provider.header, scheme: provider.scheme })
    activePoolIDs.add(provider.id)
    try {
      writeAuthKey(provider.id, pool.pick(provider.id))
    } catch {
      // best-effort
    }
    trace(`registered ${provider.id}`, { keyCount: provider.keys.length })
  }

  const refreshModels = async (providerID: string): Promise<{ ok: boolean; count: number }> => {
    const provider = providerMap.get(providerID)
    if (!provider) return { ok: false, count: 0 }
    const outcome = await discoverForProvider(provider, pool.has(providerID) ? pool : null)
    if (outcome.failed) return { ok: false, count: 0 }
    return { ok: true, count: Object.keys(outcome.models).length }
  }

  return {
    dispose: async () => {
      uninstallFetchPatch()
    },

    config: async (config: any) => {
      const collected = collectProviders(config, opts)
      providerMap = new Map([...collected.providers, ...collected.external])

      // register pools for configured providers
      for (const provider of collected.providers.values()) {
        if (!activePoolIDs.has(provider.id)) {
          registerIntoPool(provider)
        }
      }
      // external providers (env/auth keys) → failover only
      for (const provider of collected.external.values()) {
        if (!activePoolIDs.has(provider.id)) {
          registerIntoPool(provider)
        }
      }

      if (!isFetchPatched()) {
        installFetchPatch(pool, (message, variant) => toast(message, variant))
      }

      if (config && config.provider && typeof config.provider === "object") {
        const discoveryJobs: Promise<void>[] = []
        for (const provider of collected.providers.values()) {
          if (provider.baseURL.length === 0) continue
          const p = config.provider[provider.id]
          if (!p || typeof p !== "object") continue

          const relayCfg = p.options?.relayPool ?? p.options?.modelsDiscovery
          if (relayCfg?.enabled === false) continue

          discoveryJobs.push(
            (async () => {
              const outcome = await discoverForProvider(provider, pool.has(provider.id) ? pool : null)
              if (outcome.failed) {
                trace(`discovery failed for ${provider.id}`)
                toast(`[${PLUGIN_NAME}] model discovery failed for ${displayProviderName(provider.id)}`, "error")
                return
              }
              const discovered = outcome.models
              const existing = p.models && typeof p.models === "object" ? p.models : {}
              p.models = { ...discovered, ...existing }
              trace(`discovered ${Object.keys(discovered).length} models for ${provider.id}`)
            })(),
          )
        }
        await Promise.all(discoveryJobs)
      }
    },

    tool: createTools({
      directory: input.directory,
      pool,
      resolveProvider: (name) => providerIDFromAlias(name, providerMap),
      providers: () => providerMap,
      refreshModels,
      toast,
    }),
  }
}

export default server
