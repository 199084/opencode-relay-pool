import http from "node:http"
import https from "node:https"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { KeyPool } from "./pool.ts"
import type {
  CompiledModelFieldFilter,
  ModelFieldFilter,
  OpenAIModel,
  RelayDiscoveryConfig,
  RelayProvider,
} from "./types.ts"
import { dataDir, getEnv } from "./shared.ts"

export const DEFAULT_REQUEST_TIMEOUT_MS = 3000
export const DEFAULT_MODELS_ENDPOINT = "/v1/models"
const REQUEST_USER_AGENT = "opencode-relay-pool"

export interface ModelsDiscoveryResult {
  ok: boolean
  models: OpenAIModel[]
  statusCode?: number
}

export interface ModelInfoDiscoveryResult {
  ok: boolean
  data: unknown
}

function requestJson<T>(
  urlStr: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ ok: boolean; statusCode?: number; data?: T }> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (result: { ok: boolean; statusCode?: number; data?: T }) => {
      if (!settled) {
        settled = true
        resolve(result)
      }
    }

    let urlObj: URL
    try {
      urlObj = new URL(urlStr)
    } catch {
      finish({ ok: false })
      return
    }
    const mod = urlObj.protocol === "https:" ? https : http

    const req = mod.get(
      urlObj,
      {
        headers: { "User-Agent": REQUEST_USER_AGENT, ...headers },
        timeout: timeoutMs,
      },
      (res) => {
        let data = ""
        res.setEncoding("utf8")
        res.on("data", (chunk: string) => {
          data += chunk
        })
        res.on("end", () => {
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            finish({ ok: false, statusCode: res.statusCode })
            return
          }
          try {
            finish({ ok: true, statusCode: res.statusCode, data: JSON.parse(data) as T })
          } catch {
            finish({ ok: false, statusCode: res.statusCode })
          }
        })
        res.on("error", () => finish({ ok: false, statusCode: res.statusCode }))
      },
    )

    req.on("error", () => finish({ ok: false }))
    req.on("timeout", () => {
      req.destroy()
      finish({ ok: false })
    })
  })
}

export async function discoverModelsFromProvider(
  baseURL: string,
  apiKey: string | undefined,
  endpoint: string = DEFAULT_MODELS_ENDPOINT,
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<ModelsDiscoveryResult> {
  const normalized = baseURL.replace(/\/+$/, "")
  const url = `${normalized}${endpoint}`
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`

  const result = await requestJson<{ data?: OpenAIModel[] }>(url, headers, timeoutMs)
  if (!result.ok) return { ok: false, models: [], statusCode: result.statusCode }
  return { ok: true, models: result.data?.data ?? [] }
}

export async function discoverModelInfoFromProvider(
  baseURL: string,
  apiKey: string | undefined,
  endpoint: string,
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<ModelInfoDiscoveryResult> {
  const normalized = baseURL.replace(/\/+$/, "")
  const url = `${normalized}${endpoint}`
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`

  const result = await requestJson<unknown>(url, headers, timeoutMs)
  return result.ok && result.data !== undefined
    ? { ok: true, data: result.data }
    : { ok: false, data: undefined }
}

// ---------- filtering & naming ----------

function toRegExp(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern)
  } catch {
    return null
  }
}

function toFieldFilter(filter: ModelFieldFilter): CompiledModelFieldFilter | null {
  if ("match" in filter) {
    const re = toRegExp(filter.match)
    if (!re) return null
    return { field: filter.field, match: re }
  }
  return filter
}

export type ModelType = "chat" | "embedding" | "unknown"

export function categorizeModel(id: string): ModelType {
  const lower = id.toLowerCase()
  if (/embed|text-embedding|embedding-/.test(lower)) return "embedding"
  // image/audio/video/rerank 模型不硬过滤——它们也可能被当作 chat 使用
  // (如 gpt-image 有文本输出、reranker 有输入文本)。embedding 是唯一明确
  // 不可用于 chat 的类型。其余一律视为 chat 保留。
  if (/(^|[-_:/])chat[-_/]?|gpt-|claude|gemini|deepseek|qwen|llama|glm|kimi|moonshot|mistral|command|o1|o3|o4|grok|doubao|ernie|hunyuan|minimax|step-|spark|abab|yi-|phi|granite|internlm/.test(lower)) {
    return "chat"
  }
  return "chat"
}

function extractModelOwner(id: string): string | undefined {
  const first = id.split("/")[0]
  return first && first !== id ? first : undefined
}

function formatModelName(model: OpenAIModel): string {
  if (typeof model.owned_by === "string" && model.owned_by.length > 0 && model.owned_by !== "system") {
    const id = model.id.replace(/^[^/]+\//, "")
    return `${model.owned_by} ${id}`
  }
  return model.id
}

export function shouldDiscoverModel(id: string, includeRegex: RegExp[], excludeRegex: RegExp[]): boolean {
  if (includeRegex.length > 0) {
    return includeRegex.some((r) => r.test(id))
  }
  if (excludeRegex.length > 0) {
    return !excludeRegex.some((r) => r.test(id))
  }
  return true
}

function matchesFieldFilter(model: Record<string, unknown>, filter: CompiledModelFieldFilter): boolean {
  if (!Object.prototype.hasOwnProperty.call(model, filter.field)) return false
  const value = model[filter.field]
  if ("match" in filter) {
    return typeof value === "string" && filter.match.test(value)
  }
  return value === filter.equals
}

export function shouldDiscoverModelByFields(
  model: Record<string, unknown>,
  includeBy: CompiledModelFieldFilter[],
  excludeBy: CompiledModelFieldFilter[],
): boolean {
  if (includeBy.length > 0 && !includeBy.some((f) => matchesFieldFilter(model, f))) return false
  if (excludeBy.some((f) => matchesFieldFilter(model, f))) return false
  return true
}

// ---------- models.dev enrichment ----------

interface ModelsDevData {
  [key: string]: {
    name?: string
    reasoning?: boolean
    limit?: { context?: number }
    modalities?: { input?: string[]; output?: string[] }
    cost?: { input?: number; output?: number }
  }
}

const MODELS_DEV_CACHE_FILE = "relay-pool-modelsdev.json"
const MODELS_DEV_TTL_MS = 24 * 60 * 60 * 1000

function readJsonCache(filePath: string, ttlMs: number): Record<string, unknown> | null {
  if (!existsSync(filePath)) return null
  try {
    const stat = readFileSync(filePath, "utf-8")
    const parsed = JSON.parse(stat) as { ts: number; data: Record<string, unknown> }
    if (Date.now() - parsed.ts > ttlMs) return null
    return parsed.data
  } catch {
    return null
  }
}

function writeJsonCache(filePath: string, data: Record<string, unknown>): void {
  try {
    const dir = path.dirname(filePath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(filePath, JSON.stringify({ ts: Date.now(), data }), "utf-8")
  } catch {
    // best-effort
  }
}

// models.dev 失败冷却：网络不通时不要每次刷新都干等超时(10s)。
// 失败后 5 分钟内直接返回空结果。
const MODELS_DEV_FAIL_COOLDOWN_MS = 5 * 60 * 1000
let modelsDevLastFailAt = 0

export async function fetchModelsDevData(): Promise<Map<string, unknown>> {
  if (Date.now() - modelsDevLastFailAt < MODELS_DEV_FAIL_COOLDOWN_MS) return new Map()
  const cachePath = path.join(dataDir(), MODELS_DEV_CACHE_FILE)
  const cached = readJsonCache(cachePath, MODELS_DEV_TTL_MS)
  if (cached) {
    return new Map(Object.entries(cached))
  }
  try {
    const result = await requestJson<Record<string, unknown>>(
      "https://models.dev/api.json",
      {},
      10000,
    )
    if (result.ok && result.data) {
      writeJsonCache(cachePath, result.data as unknown as Record<string, unknown>)
      return new Map(Object.entries(result.data))
    }
  } catch {
    // fall through
  }
  modelsDevLastFailAt = Date.now()
  if (cached) return new Map(Object.entries(cached))
  return new Map()
}

// ---------- main discovery orchestration ----------

export interface DiscoveryOutcome {
  provider: RelayProvider
  models: Record<string, Record<string, unknown>>
  failed?: boolean
  usingCache?: boolean
}

function discoveryCachePath(providerID: string): string {
  return path.join(dataDir(), "relay-pool-discovery", `${providerID.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`)
}

export async function discoverForProvider(
  provider: RelayProvider,
  pool: KeyPool | null,
): Promise<DiscoveryOutcome> {
  const cfg = provider.discovery
  if (cfg.enabled === false) return { provider, models: {} }
  const endpoint = cfg.endpoint ?? DEFAULT_MODELS_ENDPOINT
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const cacheEnabled = cfg.cache?.enabled === true
  const ttlSeconds = cfg.cache?.ttlSeconds ?? 86400

  const cachePath = discoveryCachePath(provider.id)
  if (cacheEnabled) {
    const cached = readJsonCache(cachePath, ttlSeconds * 1000)
    if (cached) {
      return { provider, models: cached as Record<string, Record<string, unknown>>, usingCache: true }
    }
  }

  const apiKey = pool ? pool.pick(provider.id) : provider.keys[0]

  let result: ModelsDiscoveryResult
  try {
    result = await discoverModelsFromProvider(provider.baseURL, apiKey, endpoint, timeoutMs)
  } catch {
    result = { ok: false, models: [] }
  }
  if (!result.ok) {
    console.error(
      `[opencode-relay-pool] discovery failed for ${provider.id}: http ${result.statusCode ?? "error"} (${endpoint})`,
    )
    return { provider, models: {}, failed: true }
  }

  const includeRegex = (cfg.models?.includeRegex ?? cfg.includeRegex ?? [])
    .map(toRegExp)
    .filter((r): r is RegExp => r !== null)
  const excludeRegex = (cfg.models?.excludeRegex ?? cfg.excludeRegex ?? [])
    .map(toRegExp)
    .filter((r): r is RegExp => r !== null)
  const includeBy = (cfg.models?.includeBy ?? [])
    .map(toFieldFilter)
    .filter((f): f is CompiledModelFieldFilter => f !== null)
  const excludeBy = (cfg.models?.excludeBy ?? [])
    .map(toFieldFilter)
    .filter((f): f is CompiledModelFieldFilter => f !== null)
  const smartName = cfg.smartModelName === true
  const filterNonChat = cfg.filterNonChat !== false

  // models.dev 元数据(24h 缓存,失败静默降级)用于给新发现的模型补
  // context 上限 / reasoning 标记,否则 opencode 会套用默认上下文窗口,
  // 大上下文模型会被错误截断。
  const modelsDev = await fetchModelsDevData()

  const discovered: Record<string, Record<string, unknown>> = {}
  for (const model of result.models) {
    if (!model.id) continue
    if (!shouldDiscoverModelByFields(model as unknown as Record<string, unknown>, includeBy, excludeBy)) continue
    if (includeRegex.length > 0 || excludeRegex.length > 0) {
      if (!shouldDiscoverModel(model.id, includeRegex, excludeRegex)) continue
    }
    const type = categorizeModel(model.id)
    if (type === "embedding") continue
    if (filterNonChat && type === "unknown") continue

    const entry: Record<string, unknown> = {
      id: model.id,
      name: smartName ? formatModelName(model) : model.id,
    }
    const owner = extractModelOwner(model.id)
    if (owner) entry.organizationOwner = owner
    if (type === "chat") {
      entry.modalities = { input: ["text"], output: ["text"] }
    }
    if (typeof model.owned_by === "string" && model.owned_by) entry.ownedBy = model.owned_by

    const dev = modelsDev.get(model.id)
    if (dev && typeof dev === "object") {
      const info = dev as {
        reasoning?: boolean
        limit?: { context?: number }
        modalities?: { input?: string[]; output?: string[] }
      }
      if (typeof info.limit?.context === "number" && info.limit.context > 0) {
        entry.limit = { ...((entry.limit as object) ?? {}), context: info.limit.context }
      }
      if (info.reasoning === true) entry.reasoning = true
    }
    discovered[model.id] = entry
  }

  if (cacheEnabled && Object.keys(discovered).length > 0) {
    writeJsonCache(cachePath, discovered)
  }
  return { provider, models: discovered }
}

export function tryGetConfiguredApiKey(providerConfig: any): string | undefined {
  const key = providerConfig?.options?.apiKey
  return typeof key === "string" && key.trim().length > 0 ? key.trim() : undefined
}
