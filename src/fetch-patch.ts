import type { KeyPool } from "./pool.ts"
import { classify, ErrorAction } from "./classify.ts"
import { maskKey, writeAuthKey } from "./shared.ts"

const MAX_RETRIES = 3
const MAX_BODY_PREVIEW = 2048
const AUTH_HEADERS = ["authorization", "x-api-key", "api-key", "x-goog-api-key"]

export interface ProviderMeta {
  header: string
  scheme: string
}

const providers = new Map<string, ProviderMeta>()

let _original: typeof fetch | null = null
let _pool: KeyPool | null = null
let _toast: ((message: string, variant: string) => void) | null = null
let _installed = false

type FetchArgs = Parameters<typeof fetch>

/** Read only the first MAX_BODY_PREVIEW bytes of a response body, then cancel the stream. */
async function readBodyPreview(res: Response): Promise<string> {
  if (!res.body) return ""
  try {
    const reader = res.clone().body!.getReader()
    let total = 0
    const chunks: string[] = []
    while (total < MAX_BODY_PREVIEW) {
      const { done, value } = await reader.read()
      if (done) break
      const text = Buffer.from(value).toString("utf8")
      chunks.push(text)
      total += text.length
    }
    await reader.cancel().catch(() => {})
    return chunks.join("")
  } catch {
    return ""
  }
}

/** Pick the next pool key; if every key is disabled/quarantined, keep using the current key. */
function safePick(providerID: string, fallbackKey: string): string {
  try {
    return _pool!.pick(providerID)
  } catch {
    return fallbackKey
  }
}

function readHeaders(req: FetchArgs[0], init?: RequestInit): Record<string, string> {
  const result: Record<string, string> = {}
  if (req instanceof Request) {
    req.headers.forEach((v, k) => {
      result[k.toLowerCase()] = v
    })
  }
  if (!init?.headers) return result
  if (init.headers instanceof Headers) {
    init.headers.forEach((v, k) => {
      result[k.toLowerCase()] = v
    })
  } else if (Array.isArray(init.headers)) {
    for (const [k, v] of init.headers) {
      if (k !== undefined) result[k.toLowerCase()] = String(v)
    }
  } else {
    for (const [k, v] of Object.entries(init.headers)) result[k.toLowerCase()] = String(v)
  }
  return result
}

function findAuthValue(hdrs: Record<string, string>): string {
  for (const name of AUTH_HEADERS) {
    if (hdrs[name]) return hdrs[name]
  }
  return ""
}

function matchPoolKey(authValue: string): { providerID: string; key: string; meta: ProviderMeta } | null {
  if (!_pool || !authValue) return null
  for (const [providerID, meta] of providers) {
    const keys = _pool.status(providerID)
    for (const k of keys) {
      if (authValue === k.key || authValue.endsWith(" " + k.key) || authValue.endsWith("=" + k.key)) {
        return { providerID, key: k.key, meta }
      }
      if (k.key.length > 10 && authValue.includes(k.key)) {
        return { providerID, key: k.key, meta }
      }
    }
  }
  return null
}

function applyAuth(init: RequestInit | undefined, meta: ProviderMeta, key: string): RequestInit {
  const hdrs = new Headers()
  if (init?.headers) {
    if (init.headers instanceof Headers) {
      init.headers.forEach((v, k) => hdrs.set(k, v))
    } else if (Array.isArray(init.headers)) {
      for (const [k, v] of init.headers) {
        if (k !== undefined) hdrs.set(k, String(v))
      }
    } else {
      for (const [k, v] of Object.entries(init.headers)) hdrs.set(k, String(v))
    }
  }
  const value = meta.scheme ? `${meta.scheme} ${key}` : key
  let found = false
  for (const name of AUTH_HEADERS) {
    if (hdrs.has(name)) {
      hdrs.set(name, value)
      found = true
      break
    }
  }
  if (!found) hdrs.set(meta.header, value)
  return { ...init, headers: hdrs }
}

export function registerProvider(providerID: string, meta: ProviderMeta): void {
  providers.set(providerID, meta)
}

export function unregisterProvider(providerID: string): void {
  providers.delete(providerID)
}

export function installFetchPatch(
  pool: KeyPool,
  toast: (message: string, variant: string) => void,
): void {
  if (_installed) return
  _installed = true
  _pool = pool
  _toast = toast
  _original = globalThis.fetch.bind(globalThis)

  globalThis.fetch = (async (req: FetchArgs[0], init?: FetchArgs[1]) => {
    if (!_original || !_pool) return _original!(req, init)

    // Materialize Request input into url+init so retries can rebuild it
    // (a Request body stream is single-use and cannot be re-passed to fetch).
    let reqUrl = req
    let reqInit = init
    if (req instanceof Request) {
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer()
      reqUrl = req.url
      reqInit = {
        method: req.method,
        headers: req.headers,
        body,
        signal: req.signal,
        redirect: req.redirect,
        integrity: req.integrity,
        keepalive: req.keepalive,
      }
    }

    const hdrs = readHeaders(reqUrl, reqInit)
    const authValue = findAuthValue(hdrs)
    const match = matchPoolKey(authValue)
    if (!match) return _original(reqUrl, reqInit)

    const { providerID, key: currentKey, meta } = match
    let key = safePick(providerID, currentKey)

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const newInit = applyAuth(reqInit, meta, key)
      const res = await _original(reqUrl, newInit)

      // success — return immediately, never buffer streaming bodies
      if (res.status >= 200 && res.status < 300) return res

      const preview = await readBodyPreview(res)
      const result = classify({
        statusCode: res.status,
        responseHeaders: Object.fromEntries(res.headers.entries()),
        responseBody: preview,
        message: preview.slice(0, 200),
      })
      if (result.action === ErrorAction.Ignore) return res
      if (attempt >= MAX_RETRIES - 1) return res

      const masked = maskKey(key)

      // 401/402/403: the key itself is invalid — disable it and move to the
      // next key immediately (no wait needed; retrying the same key is futile).
      if (result.action === ErrorAction.Disable) {
        _pool.disable(providerID, key, result.reason)
        const next = safePick(providerID, key)
        if (next !== key) {
          try {
            writeAuthKey(providerID, next)
          } catch {
            // ignore
          }
        }
        _toast?.(`${providerID} key ${masked} disabled — ${result.reason}`, "error")
        key = next
        continue
      }

      // Long rate-limit windows: quarantine the key and switch to the next one.
      if (result.retryAfterMs !== null && result.retryAfterMs >= 10_000) {
        _pool.quarantine(providerID, key, result.retryAfterMs, result.reason)
        const next = safePick(providerID, key)
        if (next !== key) {
          try {
            writeAuthKey(providerID, next)
          } catch {
            // ignore
          }
        }
        _toast?.(
          `[${providerID}] key ${masked} quarantined → ${maskKey(next)} (${Math.ceil(result.retryAfterMs / 1000)}s)`,
          "warning",
        )
        key = next
        continue
      }

      // Short delay (or no explicit retry-after): respect the server's hint —
      // or use a sane backoff — before retrying. Never hammer the relay
      // immediately after a 429/overload, even when there is only one key.
      const delay = Math.min(result.retryAfterMs ?? 2000, 9000)
      await sleep(delay)
      const next = safePick(providerID, key)
      if (next !== key) {
        try {
          writeAuthKey(providerID, next)
        } catch {
          // ignore
        }
      }
      _toast?.(
        `[${providerID}] → ${maskKey(next)} (${Math.ceil(delay / 1000)}s)`,
        "warning",
      )
      key = next
    }

    throw new Error("opencode-relay-pool: retry loop exhausted")
  }) as typeof fetch
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function uninstallFetchPatch(): void {
  if (_original) {
    globalThis.fetch = _original
    _original = null
  }
  _installed = false
  _pool = null
  _toast = null
  providers.clear()
}

export function isFetchPatched(): boolean {
  return _installed
}

export function providerCount(): number {
  return providers.size
}
