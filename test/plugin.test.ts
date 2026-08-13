import { test, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { KeyPool } from "../src/pool.ts"
import { classify, ErrorAction } from "../src/classify.ts"
import { discoverForProvider } from "../src/discovery.ts"
import { collectProviders } from "../src/config.ts"
import { authFilePath } from "../src/shared.ts"
import type { RelayProvider } from "../src/types.ts"

function cleanAuth(...ids: string[]): void {
  const p = authFilePath()
  if (!existsSync(p)) return
  try {
    const d = JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>
    let changed = false
    for (const id of ids) {
      if (id in d) {
        delete d[id]
        changed = true
      }
    }
    if (changed) writeFileSync(p, JSON.stringify(d, null, 2), "utf-8")
  } catch {
    // ignore
  }
}

beforeEach(() => cleanAuth("myrelay", "mockrelay", "nexusvai", "simple", "minimal", "other"))
afterEach(() => cleanAuth("myrelay", "mockrelay", "nexusvai", "simple", "minimal", "other"))

let server: Server

function mockRelay(): Promise<{ port: number; hits: string[] }> {
  const hits: string[] = []
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on("data", (c) => chunks.push(c))
      req.on("end", () => {
        hits.push(req.url ?? "")
        if (req.url === "/v1/models") {
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(
            JSON.stringify({
              object: "list",
              data: [
                { id: "gpt-5.2", object: "model", owned_by: "openai" },
                { id: "deepseek-chat", object: "model", owned_by: "deepseek" },
                { id: "text-embedding-3-small", object: "model", owned_by: "openai" },
                { id: "myrelay/qwen-max", object: "model", owned_by: "qwen" },
              ],
            }),
          )
          return
        }
        res.writeHead(404)
        res.end("{}")
      })
    })
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()
      resolve({ port: (addr as { port: number }).port, hits })
    })
  })
}

function providerWithKeys(baseURL: string, keys: string[]): RelayProvider {
  return {
    id: "mockrelay",
    name: "Mock Relay",
    baseURL,
    keys,
    weight: { [keys[0]]: 2 },
    header: "Authorization",
    scheme: "Bearer",
    discovery: { enabled: true, timeoutMs: 3000 },
  }
}

test("KeyPool: weighted round-robin rotates across keys", () => {
  const pool = new KeyPool()
  pool.register(providerWithKeys("http://x", ["sk-a", "sk-b", "sk-c"]))
  const picks = [pool.pick("mockrelay"), pool.pick("mockrelay"), pool.pick("mockrelay")]
  assert.equal(new Set(picks).size, 3)
})

test("KeyPool: quarantine and re-pick", () => {
  const pool = new KeyPool()
  pool.register(providerWithKeys("http://x", ["sk-a", "sk-b"]))
  const first = pool.pick("mockrelay")
  pool.quarantine("mockrelay", first, 60_000, "429")
  const second = pool.pick("mockrelay")
  assert.notEqual(second, first)
  const status = pool.status("mockrelay")
  assert.equal(status.find((k) => k.key === first)?.status, "quarantined")
})

test("classify: 429 rotates, 401 disables, 503 rotates", () => {
  assert.equal(classify({ statusCode: 429 }).action, ErrorAction.Rotate)
  assert.equal(classify({ statusCode: 401 }).action, ErrorAction.Disable)
  assert.equal(classify({ statusCode: 403 }).action, ErrorAction.Disable)
  assert.equal(classify({ statusCode: 503 }).action, ErrorAction.Rotate)
  assert.equal(classify({ statusCode: 200 }).action, ErrorAction.Ignore)
  const overload = classify({ statusCode: 200, responseBody: "rate limit exceeded, server overloaded" })
  assert.equal(overload.action, ErrorAction.Overload)
})

test("collectProviders: parses relayPool config from opencode config", () => {
  const config = {
    provider: {
      myrelay: {
        npm: "@ai-sdk/openai-compatible",
        name: "My Relay",
        options: {
          baseURL: "https://relay.example.com/v1",
          relayPool: {
            apiKeys: ["sk-1", "sk-2"],
            weight: { "sk-1": 3 },
            discovery: { enabled: true },
          },
        },
      },
      other: {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "https://other.example.com/v1" },
      },
    },
  }
  const { providers } = collectProviders(config, {})
  assert.ok(providers.has("myrelay"))
  const p = providers.get("myrelay")!
  assert.equal(p.baseURL, "https://relay.example.com")
  assert.deepEqual(p.keys, ["sk-1", "sk-2"])
  assert.equal(p.weight["sk-1"], 3)
  assert.ok(!providers.has("other"))
})

test("collectProviders: zero-config mode — options.apiKeys enables pool+discovery", () => {
  const config = {
    provider: {
      simple: {
        npm: "@ai-sdk/openai-compatible",
        name: "Simple Relay",
        options: {
          baseURL: "https://relay.example.com/v1",
          apiKeys: ["sk-a", "sk-b", "sk-c"],
        },
      },
    },
  }
  const { providers } = collectProviders(config, {})
  assert.ok(providers.has("simple"))
  assert.deepEqual(providers.get("simple")!.keys, ["sk-a", "sk-b", "sk-c"])
})

test("collectProviders: zero-config mode — single options.apiKey works", () => {
  const config = {
    provider: {
      minimal: {
        npm: "@ai-sdk/openai-compatible",
        name: "Minimal Relay",
        options: {
          baseURL: "https://relay.example.com/v1",
          apiKey: "sk-only",
        },
      },
    },
  }
  const { providers } = collectProviders(config, {})
  assert.ok(providers.has("minimal"))
  assert.deepEqual(providers.get("minimal")!.keys, ["sk-only"])
})

test("collectProviders: official providers without custom baseURL are untouched", () => {
  const config = {
    provider: {
      openai: {
        npm: "@ai-sdk/openai",
        options: { blacklist: ["gpt-4o"] },
      },
      google: {
        npm: "@ai-sdk/google",
        options: { models: { "gemini-3-pro": { name: "x" } } },
      },
    },
  }
  const { providers } = collectProviders(config, {})
  assert.equal(providers.size, 0)
})

test("discovery: fetches /v1/models, filters embeddings, injects into config", async () => {
  const { port } = await mockRelay()
  try {
    const provider = providerWithKeys(`http://127.0.0.1:${port}`, ["sk-test"])
    const outcome = await discoverForProvider(provider, null)
    assert.notEqual(outcome.failed, true)
    const ids = Object.keys(outcome.models)
    assert.deepEqual(ids.sort(), ["deepseek-chat", "gpt-5.2", "myrelay/qwen-max"])
    const gpt = outcome.models["gpt-5.2"] as { modalities?: { input?: string[] } }
    assert.equal(gpt.modalities?.input?.length, 1)
    assert.equal(outcome.models["myrelay/qwen-max"].organizationOwner, "myrelay")
  } finally {
    server.close()
  }
})

test("discovery: includeRegex filter", async () => {
  const { port } = await mockRelay()
  try {
    const provider: RelayProvider = {
      ...providerWithKeys(`http://127.0.0.1:${port}`, ["sk-test"]),
      discovery: { includeRegex: ["^deepseek"], timeoutMs: 3000 },
    } 
    const outcome = await discoverForProvider(provider, null)
    assert.deepEqual(Object.keys(outcome.models), ["deepseek-chat"])
  } finally {
    server.close()
  }
})
