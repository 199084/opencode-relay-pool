export const ErrorAction = {
  Rotate: "rotate",
  Disable: "disable",
  Ignore: "ignore",
  Overload: "overload",
} as const

export type ErrorActionValue = (typeof ErrorAction)[keyof typeof ErrorAction]

export interface ClassifierResult {
  action: ErrorActionValue
  retryAfterMs: number | null
  reason: string
}

interface APIError {
  statusCode?: number
  responseHeaders?: Record<string, string | null>
  responseBody?: string
  message?: string
  isRetryable?: boolean
}

export function classify(raw: unknown): ClassifierResult {
  const error = (raw as Record<string, unknown>).data ?? raw
  const status = Number((error as APIError).statusCode ?? (error as Record<string, unknown>).status ?? 0)
  const headers = lowerHeaders(
    ((error as APIError).responseHeaders ?? (error as Record<string, unknown>).headers ?? {}) as Record<
      string,
      string | null | undefined
    >,
  )
  const body = String((error as APIError).responseBody ?? (error as Record<string, unknown>).body ?? "")
  const message = String((error as APIError).message ?? (error as Record<string, unknown>).message ?? "")
  const isRetryable = Boolean((error as APIError).isRetryable ?? (error as Record<string, unknown>).isRetryable ?? false)

  let retryAfterMs = parseRetryAfter(headers as Record<string, string>)
  if (retryAfterMs === null) {
    retryAfterMs = parseBodyRetryAfter(message) ?? parseBodyRetryAfter(body)
  }

  // 认证/账户类错误优先：无论响应体里写了什么（中转站常见 "quota"/"capacity" 等字眼），
  // 401/402/403 都是 key 本身的问题，必须禁用该 key，而不是当成服务器过载去换 key 重试。
  if (status === 401 || status === 403 || status === 402) {
    const label = status === 402 ? "Payment required" : status === 401 ? "Authentication failed" : "Forbidden"
    return { action: ErrorAction.Disable, retryAfterMs: null, reason: `${label} — HTTP ${status}` }
  }

  if (status === 429) {
    return { action: ErrorAction.Rotate, retryAfterMs, reason: "Rate limited — HTTP 429" }
  }

  if (status >= 500 && status < 600) {
    if (hasOverloadPattern(body, message)) {
      return {
        action: ErrorAction.Overload,
        retryAfterMs: retryAfterMs ?? 2000,
        reason: `Server overload — pattern: ${detectOverloadPattern(body, message)}`,
      }
    }
    return { action: ErrorAction.Rotate, retryAfterMs: null, reason: `Server error — HTTP ${status}` }
  }

  if (hasOverloadPattern(body, message)) {
    return { action: ErrorAction.Overload, retryAfterMs: retryAfterMs ?? 2000, reason: `Server overload — pattern: ${detectOverloadPattern(body, message)}` }
  }

  if (hasRateLimitPattern(body, message)) {
    return { action: ErrorAction.Rotate, retryAfterMs, reason: `Rate limit — pattern: ${detectPattern(body, message)}` }
  }

  if (isRetryable) {
    return { action: ErrorAction.Rotate, retryAfterMs: retryAfterMs ?? 2000, reason: "Retryable error (client marked)" }
  }

  return { action: ErrorAction.Ignore, retryAfterMs: null, reason: "Non-retryable error" }
}

function lowerHeaders(headers: Record<string, string | null | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") out[key.toLowerCase()] = value
  }
  return out
}

function parseRetryAfter(headers: Record<string, string>): number | null {
  const retryAfterMs = headers["retry-after-ms"]
  if (retryAfterMs) {
    const parsed = Number.parseFloat(retryAfterMs)
    if (!Number.isNaN(parsed) && parsed > 0) return Math.ceil(parsed)
  }
  const retryAfter = headers["retry-after"]
  if (retryAfter) {
    const parsed = Number.parseFloat(retryAfter)
    if (!Number.isNaN(parsed) && parsed > 0) return Math.ceil(parsed * 1000)
    const dateParsed = Date.parse(retryAfter)
    if (!Number.isNaN(dateParsed)) {
      const ms = dateParsed - Date.now()
      if (ms > 0) return Math.ceil(ms)
    }
  }
  return null
}

function parseBodyRetryAfter(text: string): number | null {
  const match = text.match(/\bin\s+(?:(\d+)\s*h(?:ours?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?\s*(?:(\d+)\s*s(?:ec(?:onds?)?)?)?\b/i)
  if (!match) return null
  const h = parseInt(match[1] || "0", 10)
  const m = parseInt(match[2] || "0", 10)
  const s = parseInt(match[3] || "0", 10)
  if (h === 0 && m === 0 && s === 0) return null
  return (h * 3600 + m * 60 + s) * 1000
}

function detectOverloadPattern(body: string, message: string): string | null {
  const lower = body.toLowerCase() + message.toLowerCase()
  // 只匹配明确的过载描述。不要用 "capacity"/"quota"/"exhausted" 等宽泛词——
  // 中转站常见 "quota exceeded"（余额/配额）会被误判为过载。
  const patterns = [
    "server is overloaded",
    "server overloaded",
    "overloaded",
    "worker local total request limit",
    "resource exhausted",
    "resource_exhausted",
    "res_exhausted",
    "res exhausted",
  ]
  for (const p of patterns) {
    if (lower.includes(p)) return `"${p}"`
  }
  return null
}

function hasOverloadPattern(body: string, message: string): boolean {
  return detectOverloadPattern(body, message) !== null
}

function detectPattern(body: string, message: string): string | null {
  const lower = body.toLowerCase() + message.toLowerCase()
  const patterns = [
    "rate increased too quickly",
    "rate limit",
    "too many requests",
    "unavailable",
    "too_many_requests",
    "rate_limit",
  ]
  for (const p of patterns) {
    if (lower.includes(p)) return `"${p}"`
  }

  try {
    const json = JSON.parse(body)
    if (json?.type === "error" && json?.error?.type === "too_many_requests") return `"too_many_requests" (json.type)`
    const code = typeof json?.code === "string" ? json.code : ""
    if (code.includes("unavailable")) return `"${code}" (json.code)`
    if (json?.type === "error" && typeof json?.error?.code === "string" && json.error.code.includes("rate_limit")) {
      return `"${json.error.code}" (json.error.code)`
    }
  } catch {
    // not JSON
  }

  return null
}

function hasRateLimitPattern(body: string, message: string): boolean {
  return detectPattern(body, message) !== null
}