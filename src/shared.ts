import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import type { SharedKeyState, SharedProviderState, SharedState } from "./types.ts"

export const PLUGIN_NAME = "opencode-relay-pool"

export const KEYCHAIN_JSON_KEY = "OPENCODE_RELAY_POOL_KEYS"
export const PROVIDERS_ENV_KEY = "OPENCODE_RELAY_POOL_PROVIDERS"
export const ENV_KEYS_SUFFIX = "_API_KEYS"
export const ENV_BASE_URL_SUFFIX = "_BASE_URL"

export function envNameForProvider(providerID: string, suffix: string): string {
  return `${providerID.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}${suffix}`
}

export function configDir(): string {
  const custom = process.env.OPENCODE_CONFIG_DIR
  if (custom) return custom
  const xdg = process.env.XDG_CONFIG_HOME
  if (xdg) return path.join(xdg, "opencode")
  return path.join(os.homedir(), ".config", "opencode")
}

export function dataDir(): string {
  const custom = process.env.OPENCODE_DATA_DIR
  if (custom) return custom
  const xdg = process.env.XDG_DATA_HOME
  if (xdg) return path.join(xdg, "opencode")
  return path.join(os.homedir(), ".local", "share", "opencode")
}

export function authFilePath(): string {
  const config = process.env.OPENCODE_CONFIG_DIR
  if (config) return path.join(config, "auth.json")
  return path.join(dataDir(), "auth.json")
}

export function sharedStateFilePath(): string {
  const testDir = process.env.OPENCODE_RELAY_POOL_TEST_DIR
  if (testDir) return path.join(testDir, "relay-pool-state.json")
  return path.join(configDir(), "relay-pool-state.json")
}

export function envFilePath(directory: string): string {
  const custom = process.env.OPENCODE_RELAY_POOL_ENV_FILE
  if (custom) return path.isAbsolute(custom) ? custom : path.resolve(directory, custom)
  return path.join(directory, ".env")
}

export function maskKey(key: string): string {
  if (key.length <= 7) return "<key>"
  return `${key.slice(0, 4)}...${key.slice(-3)}`
}

export function displayProviderName(id: string): string {
  const known: Record<string, string> = {
    openai: "OpenAI",
    anthropic: "Anthropic",
    google: "Google",
    groq: "Groq",
    deepseek: "DeepSeek",
    openrouter: "OpenRouter",
    nvidia: "NVIDIA NIM",
    together: "Together AI",
    fireworks: "Fireworks AI",
    mistral: "Mistral",
    moonshot: "Moonshot",
    zhipu: "Zhipu GLM",
    "z-ai": "Z-AI",
    qwen: "Qwen",
    siliconflow: "SiliconFlow",
    "github-copilot": "GitHub Copilot",
  }
  return known[id.toLowerCase()] ?? id.charAt(0).toUpperCase() + id.slice(1)
}

export function envVars(): Map<string, string> {
  return new Map(
    Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string"),
  )
}

export function getEnv(name: string): string | undefined {
  return process.env[name]
}

export function setEnv(name: string, value: string): void {
  process.env[name] = value
}

// ---------- auth.json ----------

export interface AuthEntry {
  type?: string
  key?: string
  metadata?: Record<string, string>
  accountId?: string
  token?: string
  refresh?: string
  access?: string
  expires?: number
  enterpriseUrl?: string
}

export function readAuth(): Record<string, AuthEntry> {
  const p = authFilePath()
  if (!existsSync(p)) return {}
  try {
    return JSON.parse(readFileSync(p, "utf-8"))
  } catch {
    return {}
  }
}

export function writeAuthKey(providerID: string, key: string, metadata?: Record<string, string>): void {
  const p = authFilePath()
  const dir = path.dirname(p)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const all = readAuth()
  const existing = all[providerID]
  const entry: AuthEntry = {
    type: existing?.type ?? "api",
    key,
  }
  if (metadata) entry.metadata = metadata
  else if (existing?.metadata) entry.metadata = existing.metadata
  for (const field of ["accountId", "token", "refresh", "access", "expires", "enterpriseUrl"] as const) {
    if (existing?.[field] !== undefined) {
      ;(entry as Record<string, unknown>)[field] = existing[field]
    }
  }
  all[providerID] = entry
  writeFileSync(p, JSON.stringify(all, null, 2), "utf-8")
  try {
    chmodSync(p, 0o600)
  } catch {
    // ignore
  }
}

export function removeAuthKey(providerID: string): void {
  const all = readAuth()
  if (!all[providerID]) return
  delete all[providerID]
  const p = authFilePath()
  writeFileSync(p, JSON.stringify(all, null, 2), "utf-8")
  try {
    chmodSync(p, 0o600)
  } catch {
    // ignore
  }
}

export function importFromAuthJson(): Map<string, { keys: string[]; metadata?: Record<string, string> }> {
  const result = new Map<string, { keys: string[]; metadata?: Record<string, string> }>()
  const auth = readAuth()
  for (const [id, entry] of Object.entries(auth)) {
    if (entry?.type !== "api" || !entry?.key) continue
    if (result.has(id)) continue
    const metadata: Record<string, string> = {}
    if (entry.metadata?.account_id) metadata.account_id = entry.metadata.account_id
    if (entry.metadata?.accountId) metadata.account_id = entry.metadata.accountId
    result.set(id, {
      keys: [entry.key],
      metadata: Object.keys(metadata).length ? metadata : undefined,
    })
  }
  return result
}

// ---------- shared state ----------

export function writeSharedState(providers: SharedProviderState[]): void {
  const state: SharedState = {
    version: "1.0.0",
    updatedAt: Date.now(),
    providers,
  }
  try {
    const filePath = sharedStateFilePath()
    const dir = path.dirname(filePath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(filePath, JSON.stringify(state, null, 2), "utf-8")
    chmodSync(filePath, 0o600)
  } catch {
    // best-effort
  }
}

export function readSharedState(): SharedState | null {
  const filePath = sharedStateFilePath()
  if (!existsSync(filePath)) return null
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as SharedState
  } catch {
    return null
  }
}

// ---------- .env file ----------

export function readEnvFile(filePath: string): Map<string, string> {
  const result = new Map<string, string>()
  if (!existsSync(filePath)) return result
  const content = readFileSync(filePath, "utf-8")
  for (const line of content.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const eq = trimmed.indexOf("=")
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "")
    if (key) result.set(key, value)
  }
  return result
}

export async function writeEnvKey(filePath: string, key: string, value: string): Promise<void> {
  const lines: string[] = []
  let replaced = false
  if (existsSync(filePath)) {
    const content = readFileSync(filePath, "utf-8")
    for (const line of content.split("\n")) {
      const trimmed = line.trim()
      if (trimmed.startsWith(`${key}=`)) {
        lines.push(`${key}=${value}`)
        replaced = true
      } else {
        lines.push(line)
      }
    }
  }
  if (!replaced) lines.push(`${key}=${value}`)
  const { writeFile } = await import("node:fs/promises")
  await writeFile(filePath, lines.join("\n") + "\n", "utf-8")
  try {
    chmodSync(filePath, 0o600)
  } catch {
    // ignore
  }
}

export async function removeEnvKey(filePath: string, key: string): Promise<boolean> {
  if (!existsSync(filePath)) return false
  const content = readFileSync(filePath, "utf-8")
  const lines = content.split("\n")
  const filtered = lines.filter((line) => !line.trim().startsWith(`${key}=`))
  if (filtered.length === lines.length) return false
  const { writeFile } = await import("node:fs/promises")
  await writeFile(filePath, filtered.join("\n"), "utf-8")
  return true
}
