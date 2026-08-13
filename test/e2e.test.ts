process.env.OPENCODE_RELAY_POOL_SKIP_MODELS_DEV = "1"

import { test, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { server } from "../src/index.ts"
import { authFilePath } from "../src/shared.ts"

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

beforeEach(() => {
  cleanAuth("myrelay", "mockrelay", "nexusvai", "simple", "minimal")
})

afterEach(() => {
  cleanAuth("myrelay", "mockrelay", "nexusvai", "simple", "minimal")
})

let relay: Server
let failoverServer: Server
const relayHits: { url: string; auth: string | null }[] = []
const failoverHits: { url: string; auth: string | null }[] = []

function startMockRelay(): Promise<number> {
  return new Promise((resolve) => {
    relay = createServer((req, res) => {
      relayHits.push({ url: req.url ?? "", auth: req.headers.authorization ?? null })
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ object: "list", data: [
        { id: "gpt-5.2", object: "model", owned_by: "openai" },
        { id: "deepseek-chat", object: "model", owned_by: "deepseek" },
      ] }))
    })
    relay.listen(0, "127.0.0.1", () => resolve((relay.address() as { port: number }).port))
  })
}

function startFailoverRelay(): Promise<number> {
  return new Promise((resolve) => {
    let requests = 0
    failoverServer = createServer((req, res) => {
      const auth = req.headers.authorization ?? null
      failoverHits.push({ url: req.url ?? "", auth })
      requests++
      // first key is bad: 401 then 429; second key works
      if (auth?.includes("sk-bad")) {
        res.writeHead(requests % 2 === 1 ? 401 : 429, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: { message: "rate limit" } }))
        return
      }
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ id: "chatcmpl", choices: [{ message: { role: "assistant", content: "ok" } }] }))
    })
    failoverServer.listen(0, "127.0.0.1", () => resolve((failoverServer.address() as { port: number }).port))
  })
}

function mockClient() {
  const toasts: string[] = []
  const tui = {
    showToast: async ({ body }: { body: { message: string } }) => {
      toasts.push(body.message)
    },
  }
  const input = {
    client: { app: { log: async () => {} }, tui },
    project: {},
    directory: "/tmp/opencode/relay-pool-e2e",
    worktree: "/tmp/opencode/relay-pool-e2e",
    serverUrl: new URL("http://localhost:0"),
    experimental_workspace: { register: async () => {} },
    $: {} as any,
  } as any
  return { input, toasts }
}

test("E2E: plugin config hook discovers models and injects into config", async () => {
  const port = await startMockRelay()
  const m = mockClient()
  const hooks = await server(m.input)
  try {
    const config: any = {
      provider: {
        myrelay: {
          npm: "@ai-sdk/openai-compatible",
          name: "My Relay",
          options: {
            baseURL: `http://127.0.0.1:${port}/v1`,
            relayPool: {
              apiKeys: ["sk-test"],
              discovery: { enabled: true, timeoutMs: 3000 },
            },
          },
        },
      },
    }
    await hooks.config!(config)
    const models = config.provider.myrelay.models
    assert.ok(models["gpt-5.2"], "gpt-5.2 should be injected")
    assert.ok(models["deepseek-chat"], "deepseek-chat should be injected")
    assert.equal(relayHits.some((h) => h.url === "/v1/models" && h.auth === "Bearer sk-test"), true)
    // auth.json should have been written with the pool key
  } finally {
    await hooks.dispose!()
    relay.close()
  }
})

test("E2E: fetch patch rotates bad key on 401 and 429", async () => {
  const port = await startFailoverRelay()
  const m = mockClient()
  const hooks = await server(m.input)
  try {
    const config: any = {
      provider: {
        myrelay: {
          npm: "@ai-sdk/openai-compatible",
          name: "My Relay",
          options: {
            baseURL: `http://127.0.0.1:${port}/v1`,
            relayPool: {
              apiKeys: ["sk-bad", "sk-good"],
              discovery: { enabled: false, timeoutMs: 3000 },
            },
          },
        },
      },
    }
    await hooks.config!(config)

    // simulate opencode calling the relay for a chat completion with the active pool key
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: "Bearer sk-bad", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "deepseek-chat" }),
    })
    assert.equal(res.status, 200)
    const body = (await res.json()) as { choices: { message: { content: string } }[] }
    assert.equal(body.choices[0].message.content, "ok")
    assert.ok(failoverHits.some((h) => h.auth === "Bearer sk-good"), "should have retried with sk-good")
  } finally {
    await hooks.dispose!()
    failoverServer.close()
  }
})

test("E2E: fetch patch does not buffer streaming 2xx bodies", async () => {
  const streamServer = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" })
    res.write('data: {"choices":[{"delta":{"content":"first chunk"}}]}\n\n')
    setTimeout(() => {
      res.write('data: {"choices":[{"delta":{"content":"second chunk"}}]}\n\n')
      res.end()
    }, 500)
  })
  await new Promise<void>((resolve) => streamServer.listen(0, "127.0.0.1", () => resolve()))
  const port = (streamServer.address() as { port: number }).port
  const m = mockClient()
  const hooks = await server(m.input)
  try {
    const config: any = {
      provider: {
        myrelay: {
          npm: "@ai-sdk/openai-compatible",
          name: "My Relay",
          options: {
            baseURL: `http://127.0.0.1:${port}/v1`,
            relayPool: { apiKeys: ["sk-good"], discovery: { enabled: false } },
          },
        },
      },
    }
    await hooks.config!(config)

    const started = Date.now()
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: "Bearer sk-good", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "x" }),
    })
    const elapsed = Date.now() - started
    assert.equal(res.status, 200)
    const reader = res.body!.getReader()
    const first = await reader.read()
    const text = Buffer.from(first.value ?? new Uint8Array()).toString("utf8")
    assert.ok(text.includes("first chunk"), "first chunk should arrive immediately")
    assert.ok(elapsed < 300, `should not wait for full body, took ${elapsed}ms`)
    await reader.cancel().catch(() => {})
  } finally {
    await hooks.dispose!()
    streamServer.close()
  }
})

test("E2E: fetch patch matches pool key on fetch(new Request(...)) form", async () => {
  const auths: (string | null)[] = []
  const reqServer = createServer((req, res) => {
    const auth = req.headers.authorization ?? null
    auths.push(auth)
    if (auth?.includes("sk-bad")) {
      res.writeHead(401, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: { message: "auth failed" } }))
      return
    }
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ id: "chatcmpl", choices: [] }))
  })
  await new Promise<void>((resolve) => reqServer.listen(0, "127.0.0.1", () => resolve()))
  const port = (reqServer.address() as { port: number }).port
  const m = mockClient()
  const hooks = await server(m.input)
  try {
    const config: any = {
      provider: {
        myrelay: {
          npm: "@ai-sdk/openai-compatible",
          name: "My Relay",
          options: {
            baseURL: `http://127.0.0.1:${port}/v1`,
            relayPool: { apiKeys: ["sk-bad", "sk-good"], discovery: { enabled: false } },
          },
        },
      },
    }
    await hooks.config!(config)

    const res = await fetch(
      new Request(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { Authorization: "Bearer sk-bad", "Content-Type": "application/json" },
        body: JSON.stringify({ model: "x" }),
      }),
    )
    assert.equal(res.status, 200)
    assert.ok(auths.some((h) => h === "Bearer sk-good"), "should have retried with sk-good")
  } finally {
    await hooks.dispose!()
    reqServer.close()
  }
})


function toolCtx(directory = "/tmp/opencode/relay-pool-e2e") {
  return {
    sessionID: "s",
    messageID: "m",
    agent: "test",
    directory,
    worktree: directory,
    abort: new AbortController().signal,
    metadata() {},
    ask: async () => {},
  } as any
}

test("E2E: fetch patch does not consume Request body for non-pool requests", async () => {
  const bodies: string[] = []
  const bodyServer = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => {
      bodies.push(Buffer.concat(chunks).toString("utf8"))
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end("{}")
    })
  })
  await new Promise<void>((resolve) => bodyServer.listen(0, "127.0.0.1", () => resolve()))
  const port = (bodyServer.address() as { port: number }).port
  const m = mockClient()
  const hooks = await server(m.input)
  try {
    await hooks.config!({
      provider: {
        myrelay: {
          npm: "@ai-sdk/openai-compatible",
          options: {
            baseURL: `http://127.0.0.1:${port}/v1`,
            relayPool: { apiKeys: ["sk-pool-aaaaaaa", "sk-pool-bbbbbbb"], discovery: { enabled: false } },
          },
        },
      },
    })
    const payload = JSON.stringify({ hello: "world", n: 42 })
    const res = await fetch(
      new Request(`http://127.0.0.1:${port}/unrelated`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
      }),
    )
    assert.equal(res.status, 200)
    assert.equal(bodies[0], payload)
  } finally {
    await hooks.dispose!()
    bodyServer.close()
  }
})

test("E2E: fetch patch still forwards Request body for pool-matched retries", async () => {
  const bodies: string[] = []
  const auths: (string | null)[] = []
  const bodyServer = createServer((req, res) => {
    const auth = req.headers.authorization ?? null
    auths.push(auth)
    const chunks: Buffer[] = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => {
      bodies.push(Buffer.concat(chunks).toString("utf8"))
      if (auth?.includes("sk-bad")) {
        res.writeHead(401, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: { message: "quota exceeded" } }))
        return
      }
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ id: "chatcmpl", choices: [] }))
    })
  })
  await new Promise<void>((resolve) => bodyServer.listen(0, "127.0.0.1", () => resolve()))
  const port = (bodyServer.address() as { port: number }).port
  const m = mockClient()
  const hooks = await server(m.input)
  try {
    await hooks.config!({
      provider: {
        myrelay: {
          npm: "@ai-sdk/openai-compatible",
          options: {
            baseURL: `http://127.0.0.1:${port}/v1`,
            relayPool: { apiKeys: ["sk-bad", "sk-good"], discovery: { enabled: false } },
          },
        },
      },
    })
    const payload = JSON.stringify({ model: "x", prompt: "keep-me" })
    const started = Date.now()
    const res = await fetch(
      new Request(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { Authorization: "Bearer sk-bad", "Content-Type": "application/json" },
        body: payload,
      }),
    )
    const elapsed = Date.now() - started
    assert.equal(res.status, 200)
    assert.ok(auths.some((h) => h === "Bearer sk-good"))
    assert.ok(bodies.some((b) => b.includes("keep-me")), "retried request must still carry the original body")
    assert.ok(elapsed < 500, `401+quota should rotate immediately, took ${elapsed}ms`)
  } finally {
    await hooks.dispose!()
    bodyServer.close()
  }
})

test("E2E: 429 with retry-after-ms waits then retries the next key", async () => {
  const auths: (string | null)[] = []
  const limited = createServer((req, res) => {
    const auth = req.headers.authorization ?? null
    auths.push(auth)
    if (auth?.includes("sk-slow")) {
      res.writeHead(429, { "Content-Type": "application/json", "retry-after-ms": "80" })
      res.end(JSON.stringify({ error: { message: "rate limit" } }))
      return
    }
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ id: "chatcmpl", choices: [{ message: { content: "ok" } }] }))
  })
  await new Promise<void>((resolve) => limited.listen(0, "127.0.0.1", () => resolve()))
  const port = (limited.address() as { port: number }).port
  const m = mockClient()
  const hooks = await server(m.input)
  try {
    await hooks.config!({
      provider: {
        myrelay: {
          npm: "@ai-sdk/openai-compatible",
          options: {
            baseURL: `http://127.0.0.1:${port}/v1`,
            relayPool: { apiKeys: ["sk-slow", "sk-good"], discovery: { enabled: false } },
          },
        },
      },
    })
    const started = Date.now()
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: "Bearer sk-slow", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "x" }),
    })
    const elapsed = Date.now() - started
    assert.equal(res.status, 200)
    assert.ok(auths.some((h) => h === "Bearer sk-good"))
    assert.ok(elapsed >= 70, `should honor retry-after-ms, took ${elapsed}ms`)
    assert.ok(elapsed < 1500, `should not fall back to the 2s default, took ${elapsed}ms`)
  } finally {
    await hooks.dispose!()
    limited.close()
  }
})

test("E2E: relaypool-refresh writes newly discovered models back into live config", async () => {
  let models = [{ id: "gpt-old", object: "model", owned_by: "openai" }]
  const refreshServer = createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ object: "list", data: models }))
      return
    }
    res.writeHead(404)
    res.end("{}")
  })
  await new Promise<void>((resolve) => refreshServer.listen(0, "127.0.0.1", () => resolve()))
  const port = (refreshServer.address() as { port: number }).port
  const m = mockClient()
  const hooks = await server(m.input)
  try {
    const config: any = {
      provider: {
        myrelay: {
          npm: "@ai-sdk/openai-compatible",
          name: "My Relay",
          models: { "user-pinned": { id: "user-pinned", name: "pinned" } },
          options: {
            baseURL: `http://127.0.0.1:${port}/v1`,
            relayPool: { apiKeys: ["sk-test"], discovery: { enabled: true, timeoutMs: 3000 } },
          },
        },
      },
    }
    await hooks.config!(config)
    assert.ok(config.provider.myrelay.models["gpt-old"])
    assert.ok(config.provider.myrelay.models["user-pinned"], "user-specified models must be preserved")

    models = [
      { id: "gpt-new", object: "model", owned_by: "openai" },
      { id: "deepseek-chat", object: "model", owned_by: "deepseek" },
    ]
    const result = await hooks.tool!["relaypool-refresh"].execute({ provider: "myrelay" }, toolCtx())
    assert.equal(typeof result, "string")
    assert.match(String(result), /2 models written to live config/)
    assert.ok(config.provider.myrelay.models["gpt-new"], "refresh must inject newly discovered models")
    assert.ok(config.provider.myrelay.models["deepseek-chat"])
    assert.equal(config.provider.myrelay.models["gpt-old"], undefined, "models removed on the relay must drop")
    assert.ok(config.provider.myrelay.models["user-pinned"], "user-specified models must survive refresh")
  } finally {
    await hooks.dispose!()
    refreshServer.close()
  }
})
