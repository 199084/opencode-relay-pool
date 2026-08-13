## 开发命令

- 类型检查: `npx tsc --noEmit`
- 测试: `node --experimental-strip-types --test test/*.test.ts`

## 修改约定

- 插件入口 `src/index.ts`(Plugin server 导出)。`src/types.ts` 里的配置结构是公共 API,改动会破坏用户配置。
- 改配置解析必须补 `collectProviders` 的测试(test/plugin.test.ts)，包括 env/`*_BASE_URL` 路径。
- 改错误分类或 fetch 补丁必须补回归测试：401+quota 禁用、Retry-After 退避、非池子 Request 不读 body、`relaypool-refresh` 写回 live config。
- 跑测试前注意: e2e 测试依赖全局 `~/.local/share/opencode/auth.json`,测试文件里已有清理钩子。测试会设置 `OPENCODE_RELAY_POOL_SKIP_MODELS_DEV=1` 避免打外网。
- 发版: bump `package.json` version → 打 `vX.Y.Z` tag → 推送(CI 自动发布 npm, 需要仓库 secrets.NPM_TOKEN)。