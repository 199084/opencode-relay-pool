import type { Plugin, PluginInput, PluginOptions as Options } from "@opencode-ai/plugin"
import type { RelayProvider } from "./types.ts"
import { KeyPool } from "./pool.ts"
import { collectProviders, normalizeBaseURL } from "./config.ts"
import { installFetchPatch, uninstallFetchPatch, registerProvider, isFetchPatched } from "./fetch-patch.ts"
import { discoverForProvider } from "./discovery.ts"
import { createTools } from "./tools.ts"
import {
  PLUGIN_NAME,
  writeAuthKey,
  readAuth,
  displayProviderName,
  envFilePath,
  readEnvFile,
} from "./shared.ts"

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

function hydrateProcessEnv(fileEnv: Map<string, string>): void {
  for (const [key, value] of fileEnv) {
    if (process.env[key] === undefined) process.env[key] = value
  }
}

export const server: Plugin = async (input: PluginInput, opts?: Options) => {
  const pool = new KeyPool()
  let providerMap = new Map<string, RelayProvider>()
  const userModels = new Map<string, Record<string, unknown>>()
  const discoveredCounts = new Map<string, number>()
  let liveConfig: Record<string, any> | null = null

  const toast = (message: string, variant: string, duration?: number): void => {
    try {
      void input.client.tui.showToast({
        body: { message, variant: variant as "error" | "warning" | "success" | "info", duration: duration ?? 5000 },
      })
    } catch {
      // ignore
    }
  }

  const applyDiscoveredModels = (
    providerID: string,
    discovered: Record<string, Record<string, unknown>>,
  ): void => {
    discoveredCounts.set(providerID, Object.keys(discovered).length)
    if (!liveConfig?.provider || typeof liveConfig.provider !== "object") return
    const p = liveConfig.provider[providerID]
    if (!p || typeof p !== "object") return
    const preserved = userModels.get(providerID) ?? {}
    p.models = { ...discovered, ...preserved }
  }

  const registerIntoPool = (provider: RelayProvider): void => {
    if (provider.keys.length === 0) return
    pool.register(provider)
    registerProvider(provider.id, { header: provider.header, scheme: provider.scheme })
    try {
      const current = readAuth()[provider.id]?.key
      if (!current || !provider.keys.includes(current)) {
        writeAuthKey(provider.id, pool.pick(provider.id))
      }
    } catch {
      // best-effort
    }
    trace(`registered ${provider.id}`, { keyCount: provider.keys.length })
  }

  const upsertProvider = (provider: RelayProvider): void => {
    const next: RelayProvider = {
      ...provider,
      baseURL: provider.baseURL ? normalizeBaseURL(provider.baseURL) : "",
    }
    providerMap.set(next.id, next)
    registerIntoPool(next)
  }

  const refreshModels = async (providerID: string): Promise<{ ok: boolean; count: number }> => {
    const provider = providerMap.get(providerID)
    if (!provider) return { ok: false, count: 0 }
    if (!provider.baseURL) return { ok: false, count: 0 }
    const outcome = await discoverForProvider(provider, pool.has(providerID) ? pool : null, { force: true })
    if (outcome.failed) return { ok: false, count: 0 }
    applyDiscoveredModels(providerID, outcome.models)
    return { ok: true, count: Object.keys(outcome.models).length }
  }

  return {
    dispose: async () => {
      uninstallFetchPatch()
    },

    config: async (config: any) => {
      liveConfig = config
      const fileEnv = readEnvFile(envFilePath(input.directory))
      hydrateProcessEnv(fileEnv)
      const collected = collectProviders(config, opts, fileEnv)
      providerMap = new Map([...collected.providers, ...collected.external])

      for (const provider of collected.providers.values()) {
        registerIntoPool(provider)
      }
      for (const provider of collected.external.values()) {
        registerIntoPool(provider)
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

          if (!userModels.has(provider.id)) {
            const existing = p.models && typeof p.models === "object" ? { ...p.models } : {}
            userModels.set(provider.id, existing)
          }

          discoveryJobs.push(
            (async () => {
              const outcome = await discoverForProvider(provider, pool.has(provider.id) ? pool : null)
              if (outcome.failed) {
                trace(`discovery failed for ${provider.id}`)
                toast(`[${PLUGIN_NAME}] model discovery failed for ${displayProviderName(provider.id)}`, "error")
                return
              }
              applyDiscoveredModels(provider.id, outcome.models)
              trace(`discovered ${Object.keys(outcome.models).length} models for ${provider.id}`)
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
      upsertProvider,
      refreshModels,
      discoveredCount: (providerID) => discoveredCounts.get(providerID) ?? 0,
      toast,
    }),
  }
}

export default server
