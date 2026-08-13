# opencode-relay-pool

[![npm version](https://img.shields.io/npm/v/opencode-relay-pool.svg?color=blue)](https://www.npmjs.com/package/opencode-relay-pool)
[![license](https://img.shields.io/github/license/199084/opencode-relay-pool.svg)](https://github.com/199084/opencode-relay-pool/blob/main/LICENSE)
[![OpenCode](https://img.shields.io/badge/OpenCode-%3E%3D1.4.0-blueviolet)](https://opencode.ai)

> 一个融合 **动态模型发现** + **账号池 failover** 的 OpenCode 插件：
> 自动兼容任意 OpenAI 兼容第三方中转站（`/v1`），把中转站的真实模型动态同步进 `/models` 列表，
> 并为每个中转站维护多 Key 账号池 —— 限流自动隔离、失效自动禁用、加权轮询切换，零人工干预。

本插件是以下两个插件功能的合体：

| 功能 | 来源 |
| --- | --- |
| 动态模型发现（模型列表随中转站真实变化） | [opencode-models-discovery](https://github.com/yuhp/opencode-models-discovery) |
| 多 Key 账号池 / failover 轮换 | [opencode-failover](https://github.com/bulutmuf/opencode-failover) |

## 特性

- **任意 OpenAI 兼容中转站**：只需 `baseURL` + 一个或多个 key，无需额外代码
- **模型动态发现**：启动时拉取中转站 `/v1/models`，注入 OpenCode provider 配置 —— 中转站增删模型，`/models` 跟着变
- **账号池 failover**：多 key 加权轮询；`429` 按 `Retry-After` 隔离（指数退避），`401/403/402` 永久禁用并切换，`5xx` 自动重试
- **请求拦截轮换**：fetch 补丁自动识别池子 key，出错时透明切换下一个 key，并把激活 key 写入 `auth.json`；支持 `fetch(url, init)` 与 `fetch(new Request(...))` 两种调用形式
- **流式零缓冲**：2xx 响应原样直通，不 clone 不缓冲 —— SSE 流式输出零延迟
- **安全落盘**：`.env` / `auth.json` 写入即 `chmod 0600`，共享状态文件中的 key 已脱敏
- **模型过滤**：正则 `includeRegex/excludeRegex`、字段级 `includeBy/excludeBy`、自动剔除 embedding 模型
- **模型名称增强**：`smartModelName` 把 `owned_by` 拼进显示名（如 `openai gpt-5.2`）
- **发现结果缓存**：可选（默认关闭），开启后默认 24h TTL
- **可视化工具**：`relaypool-status` / `relaypool-setup` / `relaypool-remove` / `relaypool-reset` / `relaypool-refresh` / `relaypool-import`
- **配置兼容**：同时兼容 `relayPool`、`modelsDiscovery` 两种配置块，以及 `opencode-failover` 风格的 `*_API_KEYS` 环境变量和 `.env`

## 安装

```bash
npm install -g opencode-relay-pool
# 或
opencode plugin opencode-relay-pool
```

在 `opencode.json` 中启用：

```json
{
  "plugin": ["opencode-relay-pool@latest"]
}
```

## 快速开始

### 方式一：零配置（推荐）—— 只写中转站标准配置

你只需要按 OpenCode 原生方式配置中转站，插件自动接管一切：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-relay-pool@latest"],
  "provider": {
    "myrelay": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "我的中转站",
      "options": {
        "baseURL": "https://relay.example.com/v1",
        "apiKey": "sk-xxx"
      }
    }
  }
}
```

重启 OpenCode 后 `/models` 里自动出现该中转站的全部真实模型（随中转站增删自动变化）。想要多 key 轮换，把 `apiKey` 换成数组：

```json
"options": {
  "baseURL": "https://relay.example.com/v1",
  "apiKeys": ["sk-1", "sk-2", "sk-3"]
}
```

三个 key 自动组成账号池：限流的隔离、失效的禁用、按权重轮询切换。

### 方式二：对话式添加 key（无需改配置）

对话中直接说：

> Add these API keys for myrelay: sk-xxx, sk-yyy, sk-zzz

或用工具：

```
relaypool-setup(provider="myrelay", keys="sk-xxx,sk-yyy", base_url="https://relay.example.com/v1")
```

key 会保存到项目 `.env`，插件自动注册账号池和模型发现。

### 方式三：环境变量 / .env（failover 兼容风格）

```bash
MYRELAY_API_KEYS="sk-xxx,sk-yyy,sk-zzz"
MYRELAY_BASE_URL="https://relay.example.com/v1"
```

### 高级配置（可选）

想精细控制过滤/缓存/权重时，用 `relayPool` 配置块：

```json
{
  "provider": {
    "myrelay": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "我的中转站",
      "options": {
        "baseURL": "https://relay.example.com/v1",
        "relayPool": {
          "apiKeys": ["sk-key1", "sk-key2", "sk-key3"],
          "weight": { "sk-key1": 3 },
          "header": "Authorization",
          "scheme": "Bearer",
          "discovery": {
            "enabled": true,
            "timeoutMs": 5000,
            "models": {
              "excludeRegex": ["embedding", "^tts"]
            }
          }
        }
      }
    }
  }
}
```

## 配置说明

### provider 级配置（`provider.<id>.options.relayPool`）

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 是否启用该中转站的 relay-pool |
| `apiKeys` | string[] | `[]` | 账号池 key 列表（多 key 自动 failover） |
| `weight` | Record<string, number> | `{}` | 加权轮询，如 `{"sk-1": 3}` 表示该 key 权重 3x |
| `header` | string | `Authorization` | 认证头名称 |
| `scheme` | string | `Bearer` | 认证 scheme，设为空字符串可传裸 key |
| `discovery` | RelayDiscoveryConfig | — | 模型发现配置 |

### discovery 配置

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 是否动态拉取模型 |
| `endpoint` | string | `/v1/models` | 模型列表端点 |
| `timeoutMs` | number | `3000` | 发现请求超时 |
| `smartModelName` | boolean | `false` | 用 `owned_by + id` 生成显示名 |
| `filterNonChat` | boolean | `true` | 过滤非聊天模型（image/tts/embedding 等） |
| `includeRegex` / `excludeRegex` | string[] | `[]` | 模型 ID 正则过滤 |
| `models.includeBy` / `models.excludeBy` | {field, match\|equals}[] | `[]` | 模型字段级过滤 |
| `cache.enabled` | boolean | `false` | 开启发现结果缓存 |
| `cache.ttlSeconds` | number | `86400` | 缓存 TTL |

### 兼容 models-discovery 配置

`modelsDiscovery` 配置块同样被识别（与 `relayPool` 等价）：

```json
{
  "options": {
    "baseURL": "https://relay.example.com/v1",
    "modelsDiscovery": {
      "enabled": true,
      "models": { "includeRegex": ["^gpt|^deepseek"] }
    }
  }
}
```

## 工具（Tools）

| 工具 | 作用 |
| --- | --- |
| `relaypool-status` | 查看所有账号池状态：active / QUAR / DISABLED、权重、退避倒计时 |
| `relaypool-setup` | 保存 key（provider, keys 逗号/换行分隔, base_url） |
| `relaypool-switch` | 手动切换当前激活 key（不传 key 轮换到下一个，传 key 指定） |
| `relaypool-remove` | 移除 key（不传 `key` 参数则清空该 provider 全部 key） |
| `relaypool-reset` | 把所有隔离/禁用的 key 重置为 active |
| `relaypool-refresh` | 立即重新拉取某 provider 的模型列表 |
| `relaypool-import` | 从 opencode `auth.json` 导入已有 key |

## 状态存储

- key 池：项目 `.env`（`<ID>_API_KEYS` + `OPENCODE_RELAY_POOL_KEYS`，写入后自动 `chmod 0600`）
- 共享状态：`~/.config/opencode/relay-pool-state.json`（key 已脱敏）
- 激活 key：写入 `auth.json`（自动 `chmod 0600`），OpenCode 请求直接带上当前激活 key；出错时由 fetch 补丁透明切换
- 发现缓存：`~/.local/share/opencode/relay-pool-discovery/<id>.json`

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `OPENCODE_RELAY_POOL_DEBUG` | 设为 `1` 输出调试日志 |
| `OPENCODE_RELAY_POOL_ENV_FILE` | 自定义 `.env` 路径 |
| `OPENCODE_RELAY_POOL_KEYS` | keychain JSON（内部使用） |
| `OPENCODE_RELAY_POOL_PROVIDERS` | provider 配置 JSON（内部使用） |

## 工作原理

```
启动 → 解析 provider.relayPool / options.apiKeys 配置 → KeyPool 注册多 key
     → config hook: 请求 {baseURL}/v1/models → 过滤 → 注入 config.provider.<id>.models
     → fetch 补丁: 识别请求携带的池子 key 后进入轮换逻辑
       ├─ 2xx → 原样直通（不 clone、不缓冲，SSE 流式输出零延迟）
       ├─ 401/403/402 → 禁用该 key, 切换下一个, 写入 auth.json
       ├─ 429 → Retry-After ≥ 10s 隔离(指数退避)；< 10s 直接切换
       ├─ 5xx/overload → 切换重试（最多 3 次）
       └─ 全部 key 不可用 → 降级用当前 key，请求绝不抛异常
     错误响应 body 仅读取前 2KB 用于分类，不影响原响应
     兼容 fetch(url, init) 与 fetch(new Request(...)) 两种调用形式
```

## 常见问题（FAQ）

**`/models` 里没有出现中转站的模型？**

按顺序排查：`discovery.enabled` 是否被设为 `false`；`excludeRegex` / `filterNonChat` 是否把模型过滤掉了；中转站 `/v1/models` 是否可达。打开 `OPENCODE_RELAY_POOL_DEBUG=1` 可看到发现请求的日志。

**模型列表不更新？**

开启 `discovery.cache.enabled` 后默认缓存 24h；用 `relaypool-refresh` 可立即强制刷新，或直接重启 OpenCode。

**key 全部变成 DISABLED / QUAR？**

用 `relaypool-status` 查看每个 key 的禁用原因和退避倒计时；`relaypool-reset` 一键全部重置回 active。

**中转站不支持 `/v1/models`？**

把 `discovery.enabled` 设为 `false`，然后在 provider 里手动写 `models` 即可，账号池 failover 不受影响。

**流式输出很卡 / 半天才出第一个字？**

这是旧版本 `clone().text()` 缓冲整个响应导致的，升级到含 fetch 补丁修复的版本即可（2xx 响应现在零缓冲直通）。

**key 会明文暴露吗？**

`.env` 与 `auth.json` 写入后自动 `chmod 0600`（仅当前用户可读写）；共享状态文件 `relay-pool-state.json` 中的 key 已脱敏。

## 开发

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # node --experimental-strip-types --test
```

## 发布

推荐方式（打 tag 触发 CI 自动发布 npm，需仓库配置 `secrets.NPM_TOKEN`）：

```bash
npm version patch
git push --follow-tags
```

CI（`.github/workflows/publish.yml`）会在 tag 上自动跑 typecheck + 全量测试并 `npm publish --provenance`。

也可以手动发布：

```bash
npm login
npm version patch
npm publish
```

## 协议

[MIT](./LICENSE)
