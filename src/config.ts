import type { RelayPoolConfig, RelayProvider } from "./types.ts"
import {
  KEYCHAIN_JSON_KEY,
  PROVIDERS_ENV_KEY,
  ENV_KEYS_SUFFIX,
  envVars,
  readAuth,
  importFromAuthJson,
} from "./shared.ts"

export interface PluginOptions {
  providers?: Record<string, RelayPoolConfig>
  enabled?: boolean
}

function normalizeBaseURL(baseURL: string): string {
  let normalized = baseURL.replace(/\/+$/, "")
  if (normalized.endsWith("/v1")) {
    normalized = normalized.slice(0, -3)
  }
  return normalized
}

export function isOpenAICompatibleProvider(provider: any): boolean {
  return (
    provider !== null &&
    typeof provider === "object" &&
    (provider.npm === "@ai-sdk/openai-compatible" ||
      provider.npm === "openai" ||
      /\/v1(\/|$)/.test(provider.options?.baseURL ?? ""))
  )
}

export function readKeychainJson(env: Map<string, string>): Map<string, string[]> {
  const result = new Map<string, string[]>()
  const raw = env.get(KEYCHAIN_JSON_KEY)
  if (!raw) return result
  try {
    const parsed = JSON.parse(raw) as Record<string, string[]>
    for (const [id, keys] of Object.entries(parsed)) {
      if (Array.isArray(keys)) {
        const filtered = keys.filter((k) => typeof k === "string" && k.length > 0)
        if (filtered.length > 0) result.set(id, filtered)
      }
    }
  } catch {
    // invalid json
  }
  return result
}

export async function writeKeychainJson(filePath: string, providers: Map<string, string[]>): Promise<void> {
  const obj: Record<string, string[]> = {}
  for (const [id, keys] of providers) {
    if (keys.length > 0) obj[id] = keys
  }
  const { writeEnvKey } = await import("./shared.ts")
  await writeEnvKey(filePath, KEYCHAIN_JSON_KEY, JSON.stringify(obj))
}

export function discoverEnvProviders(): Map<string, string[]> {
  const result = new Map<string, string[]>()
  for (const [id, keys] of readKeychainJson(envVars())) {
    if (keys.length === 0) continue
    result.set(id, keys)
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.endsWith(ENV_KEYS_SUFFIX)) continue
    if (key === PROVIDERS_ENV_KEY || key === KEYCHAIN_JSON_KEY) continue
    const id = key.slice(0, -ENV_KEYS_SUFFIX.length).toLowerCase()
    if (!value || result.has(id)) continue
    const keys = value.split(",").map((k) => k.trim()).filter(Boolean)
    if (keys.length === 0) continue
    result.set(id, keys)
  }
  return result
}

function parseOptionsProviders(options: unknown): Map<string, RelayPoolConfig> {
  const result = new Map<string, RelayPoolConfig>()
  if (!options || typeof options !== "object") return result
  const providers = (options as Record<string, unknown>).providers
  if (!providers || typeof providers !== "object") return result
  for (const [id, cfg] of Object.entries(providers as Record<string, RelayPoolConfig>)) {
    if (cfg && typeof cfg === "object") result.set(id, cfg)
  }
  return result
}

function normalizeKeys(cfg: RelayPoolConfig | undefined): string[] {
  const keys = cfg?.apiKeys ?? []
  return Array.isArray(keys) ? keys.filter((k) => typeof k === "string" && k.length > 0) : []
}

function resolveKeys(
  providerID: string,
  opts: unknown,
  keychain: Map<string, string[]>,
  optionsKeys: string[],
): string[] {
  if (optionsKeys.length > 0) return optionsKeys
  const fromKeychain = keychain.get(providerID)
  if (fromKeychain && fromKeychain.length > 0) return fromKeychain
  return []
}

function normalizeProvider(
  id: string,
  name: string,
  baseURL: string,
  keys: string[],
  cfg: RelayPoolConfig | undefined,
): RelayProvider {
  return {
    id,
    name,
    baseURL: normalizeBaseURL(baseURL),
    keys,
    weight: cfg?.weight ?? {},
    header: cfg?.header ?? "Authorization",
    scheme: cfg?.scheme ?? "Bearer",
    discovery: cfg?.discovery ?? cfg?.modelsDiscovery ?? {},
  }
}

export interface ProviderCollection {
  providers: Map<string, RelayProvider>
  /** providers discovered from env/auth but not present in opencode config (need injection) */
  external: Map<string, RelayProvider>
}

export function collectProviders(config: any, opts: unknown): ProviderCollection {
  const keychain = readKeychainJson(envVars())
  const providers = new Map<string, RelayProvider>()
  const external = new Map<string, RelayProvider>()

  const fromOpts = parseOptionsProviders(opts)
  const envProviderKeys = discoverEnvProviders()
  const authProviders = importFromAuthJson()

  const configProviders = (config?.provider ?? {}) as Record<string, any>

  // 1. providers defined in opencode config with relayPool/modelsDiscovery options
  for (const [id, p] of Object.entries(configProviders)) {
    if (!p || typeof p !== "object") continue
    const baseURL = p.options?.baseURL
    if (typeof baseURL !== "string" || baseURL.length === 0) continue

    const relayCfg: RelayPoolConfig | undefined = p.options?.relayPool ?? p.options?.modelsDiscovery
    if (relayCfg?.enabled === false) continue

    // key sources in priority order: relayPool.apiKeys > options.apiKeys > options.apiKey
    const optionsKeys = relayCfg ? normalizeKeys(relayCfg) : []
    const directKeys = Array.isArray(p.options?.apiKeys)
      ? p.options.apiKeys.filter((k: unknown): k is string => typeof k === "string" && k.length > 0)
      : []
    const singleKey =
      typeof p.options?.apiKey === "string" && p.options.apiKey.trim().length > 0
        ? [p.options.apiKey.trim()]
        : []

    // explicit relay intent → always participate (keys may come from keychain/auth)
    if (relayCfg) {
      const keys = resolveKeys(id, opts, keychain, [...optionsKeys, ...directKeys, ...singleKey])
      const authKeys = authProviders.get(id)?.keys ?? []
      const allKeys = [...new Set([...keys, ...authKeys])]
      providers.set(id, normalizeProvider(id, p.name ?? id, baseURL, allKeys, relayCfg))
      continue
    }

    // zero-config mode: any OpenAI-compatible relay with keys participates automatically
    const keys = [...new Set([...directKeys, ...singleKey])]
    if (keys.length === 0) continue
    providers.set(id, normalizeProvider(id, p.name ?? id, baseURL, keys, {}))
  }

  // 2. plugin-options providers (failover style) with explicit baseURL
  for (const [id, cfg] of fromOpts) {
    if (providers.has(id)) continue
    const baseURL = (cfg as any).baseURL
    if (typeof baseURL !== "string" || baseURL.length === 0) continue
    const keys = normalizeKeys(cfg)
    if (keys.length === 0) continue
    providers.set(id, normalizeProvider(id, id, baseURL, keys, cfg))
  }

  // 3. env/keychain/auth providers that are not in opencode config → remember for injection
  const allIds = new Set<string>(providers.keys())
  const envIds = new Set<string>([...envProviderKeys.keys(), ...fromOpts.keys()])
  for (const [id, cfg] of fromOpts) {
    if (!(cfg as any).baseURL) envIds.delete(id)
  }
  for (const id of envIds) {
    if (allIds.has(id) || providers.has(id)) continue
    const keys = resolveKeys(id, opts, keychain, normalizeKeys(fromOpts.get(id)))
    if (keys.length === 0) continue
    const cfg = fromOpts.get(id) ?? {}
    external.set(
      id,
      normalizeProvider(id, id, "", keys, cfg),
    )
  }
  for (const [id, entry] of authProviders) {
    if (providers.has(id) || external.has(id)) continue
    const keys = entry.keys
    if (keys.length === 0) continue
    external.set(id, normalizeProvider(id, id, "", keys, {}))
  }

  return { providers, external }
}
