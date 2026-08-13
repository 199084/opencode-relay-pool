export type KeyStatus = "active" | "quarantined" | "disabled"

export interface RelayPoolConfig {
  enabled?: boolean
  apiKeys?: string[]
  weight?: Record<string, number>
  header?: string
  scheme?: string
  discovery?: RelayDiscoveryConfig
  /** Alias kept for compatibility with opencode-models-discovery configs */
  modelsDiscovery?: RelayDiscoveryConfig
}

export interface RelayDiscoveryConfig {
  enabled?: boolean
  endpoint?: string
  timeoutMs?: number
  modelInfoEndpoint?: string
  modelInfoFormat?: "models.dev" | "litellm" | "vllm" | "lmstudio" | "bifrost"
  filterNonChat?: boolean
  smartModelName?: boolean
  /** Top-level convenience filters (merged with models.*) */
  includeRegex?: string[]
  excludeRegex?: string[]
  cache?: {
    enabled?: boolean
    ttlSeconds?: number
  }
  models?: {
    includeRegex?: string[]
    excludeRegex?: string[]
    includeBy?: ModelFieldFilter[]
    excludeBy?: ModelFieldFilter[]
  }
}

export type ModelFieldFilterValue = string | number | boolean | null

export interface ModelFieldEqualsFilter {
  field: string
  equals: ModelFieldFilterValue
}

export interface ModelFieldMatchFilter {
  field: string
  match: string
}

export type ModelFieldFilter = ModelFieldEqualsFilter | ModelFieldMatchFilter

export type CompiledModelFieldFilter =
  | ModelFieldEqualsFilter
  | (Omit<ModelFieldMatchFilter, "match"> & { match: RegExp })

/** A fully resolved relay provider: baseURL + key pool + discovery settings */
export interface RelayProvider {
  id: string
  name: string
  baseURL: string
  keys: string[]
  weight: Record<string, number>
  header: string
  scheme: string
  discovery: RelayDiscoveryConfig
}

export interface OpenAIModel {
  id: string
  object?: string
  created?: number
  owned_by?: string
  [key: string]: unknown
}

export interface OpenAIModelsResponse {
  object?: string
  data: OpenAIModel[]
}

export interface KeyState {
  key: string
  weight: number
  status: KeyStatus
  quarantinedUntil: number
  consecutiveErrors: number
  lastErrorAt: number
  lastErrorMessage: string
  retryAfterMs: number | null
}

export interface SharedKeyState {
  key: string
  status: KeyStatus
  weight: number
  quarantinedUntil: number
  consecutiveErrors: number
  lastErrorAt: number
  lastErrorMessage: string
  retryAfterMs: number | null
}

export interface SharedProviderState {
  id: string
  name: string
  baseURL: string
  keys: SharedKeyState[]
}

export interface SharedState {
  version: string
  updatedAt: number
  providers: SharedProviderState[]
}
