# dsh-llm-rate-limiter

[![npm](https://img.shields.io/npm/v/@leaf233/dsh-llm-rate-limiter.svg)](https://www.npmjs.com/package/@leaf233/dsh-llm-rate-limiter)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![DSH 0.1.7+](https://img.shields.io/badge/DSH-0.1.7--rc.1%2B-brightgreen.svg)
[![Cordis 4.x](https://img.shields.io/badge/Cordis-%3E%3D4.0.0-brightgreen.svg)](package.json)
[![Tests](https://img.shields.io/badge/tests-375%20passing-brightgreen.svg)](test-config-schema.mjs)

[English](README.md) | 中文

[DeepSeek Harness](https://github.com/deepseek-ai/dsh) 的**按模型 LLM 调用限速插件**，支持排队/拒绝两种节流策略，并带交互式图形配置界面。

---

## 功能

- **按模型限速** —— 每个 `provider/model` 独立的并发数、RPM 与突发容量限制
- **两种算法** —— 令牌桶（允许突发）或滑动窗口（平滑、严格 RPM）
- **排队模式** —— 被限流的请求排队等待，有槽位空出时放行
- **拒绝模式** —— 被限流的请求立即失败（可与 `dsh-llm-retry` 配合自动退避重试）
- **交互式界面** —— DSH 设置 → 插件页内的可展开配置卡片
- **实时状态面板** —— 实时计数器、按模型的进度条与事件日志（v0.2.0 起）
- **热更新** —— 配置改动立即生效，无需重启
- **全量检查** —— 拦截 `llm/stream` waterfall，覆盖每个 agent 轮次里的每一次 LLM 调用

---

## 状态面板（v0.2.0）

打开卡片后，其正文顶部会显示实时面板：

```
📊 实时状态                          ● 实时   [清零]
 请求 42 · 通过 38 · 拒绝 2 · 超时 1 · 中止 1 · 平均等待 214ms
 deepseek/deepseek-chat   [令牌桶]  ▓▓▓▓▓▓▓░░░ 7.5/10   并发 2/5   排队 1
 openai/gpt-4o            [滑动窗口] ▓▓▓▓▓▓▓▓▓▓ 3/3 rpm  并发 1/5
 12:00:03  timeout   openai/gpt-4o              等待 1m
 12:00:01  rejected  openai/gpt-4o
 12:00:00  granted   deepseek/deepseek-chat     等待 4.2s
```

| 方面 | 行为 |
|------|------|
| 数据通道 | 通道 `/llm-rate-limiter` —— 带认证（401/403 栅栏），POST+JSON，随插件 fiber 自动清理 |
| 载体 | 优先用框架的 `connection.rpc.handle()`；框架路径失效时，退回到插件自注册的前缀路由并复用 `connection.requestRejection()`（见下文） |
| 轮询节奏 | 卡片展开时 1 秒轮询；连续失败后退避 2 秒 → 4 秒 → 8 秒 |
| 折叠状态 | 面板卸载，因此**完全不轮询** |
| 端点 | `snapshot`（实时计数）与 `reset`（清零统计） |
| 通道不可用时 | 显示「状态通道不可用」，卡片其余部分功能不受影响 |
| 计数器 | `requests` / `granted` / `rejected` / `timeouts` / `aborted` / `totalWaitMs`，外加最近 8 条事件（环形缓冲为 64） |
| 进度条 | 令牌桶显示 `tokens/burstSize`；滑动窗口显示 `countInWindow/maxRpm`；接近上限时变琥珀色 |

### 载体兜底（DSH 0.1.5-rc.3 起）

DSH 0.1.5-rc.3 把 `@deepseek-ai/dsh-client-connection` **这个框架插件自身**的 `inject` 从
`["webServer", "credentials"]` 改成了 `["credentials"]`，但其
`HostConnectionService.register()` 仍然解引用 `owner.webServer`。
Cordis 会把跨 fiber 读取的 service 的 `ctx` 重绑定到**读取者**的 fiber，因此
`connection.rpc.handle()` 会抛错：**在 0.1.7-rc.1 中依然存在** —— 见下文。

```
cannot get property "webServer" without inject
```

插件会检测到该错误，并自行挂载同一条通道：

| 路径 | 触发条件 | 做法 |
|------|---------|------|
| 1（首选） | `connection.rpc.handle()` 正常 | 由框架持有路由、请求校验与 fiber 级撤销 |
| 2（兜底） | 路径 1 抛错 | 插件在**自己的 fiber**（能看到 `webServer`）注册 `kind: "prefix"` 路由，并复用 `connection.requestRejection()` 作为 403/401 栅栏 |

两条载体使用逐字相同的 wire 协议，因此**浏览器端无需改动** —— 面板也分辨不出
当前是哪一条。若 `connection.requestRejection()` 不可用，插件会**拒绝挂载**，
而不是发布一条未鉴权的路由。

---

## 安装

### 方式 1：npm（推荐）

```bash
dsh plugin add <your-profile> @leaf233/dsh-llm-rate-limiter
# 或在该 profile 目录内：
pnpm add @leaf233/dsh-llm-rate-limiter
```

### 方式 2：本地路径（开发）

```bash
dsh plugin add <your-profile> ./path/to/dsh-llm-rate-limiter
# 或
dsh plugin add ./path/to/dsh-llm-rate-limiter   # 默认 profile
```

> 插件必须被加入该 profile 的 `package.json` 依赖中。
> bundle 入口（`cordis.patch.yml`）由 `reconcilePlugins` 自动识别。
>
> **0.3.0 要求 DSH 0.1.7-rc.1 或更新版本。** 若使用 DSH 0.1.5，请锁定
> `@leaf233/dsh-llm-rate-limiter@0.2.x`。见[兼容性表](#兼容性)。

### 方式 3：从 GitHub 安装

```bash
dsh plugin add <your-profile> github:Leafyezi233/dsh-llm-rate-limiter
```

> ⚠️ **重要**：从 Git 安装的插件在首次安装时会被 pnpm 的 `allowBuilds` 限制拦下。
> 若安装失败，请查看报错信息中 pnpm 给出的确切键名，然后加入该 profile 的
> `pnpm-workspace.yaml`：
>
> ```yaml
> pnpm:
>   allowBuilds:
>     - '@leaf233/dsh-llm-rate-limiter'
> ```
>
> 然后重新执行安装命令。

---

## 配置

### 通过图形界面

1. 打开 DSH Web UI（`dsh web`）
2. 进入**设置 → 插件**，展开 **Official** 分组
3. 找到 **LLM 调用限速** 卡片（`data-plugin-item="llm-rate-limiter"`）并打开
4. 配置全局默认值、按模型覆盖与节流行为 —— 改动经页面自带的表单保存，
   实时状态面板就在同一页

> 卡片出现在 **Official** 分组里，是因为 DSH 把所有 `plugins.item` 的注册者
> 都列在那里；本插件的 `order` 为 `900`，因此排在五个官方设置页之后。

### 通过配置文件

改动会被持久化到该 profile 的 Cordis patch 中该条目的 `config` 里
（0.1.7 起，插件以自己的 `Config` 作为配置来源；旧版 `settings.yaml` 由
DSH 在首次启动时导入一次并改名）。形状如下：

```yaml
llm-rate-limiter:
  enabled: true
  strategy: token-bucket       # "token-bucket" | "sliding-window"
  defaults:
    maxConcurrent: 5
    maxRpm: 60
    burstSize: 10               # 仅令牌桶
    refillRate: 1               # 仅令牌桶（每秒补充的令牌数）
  models:
    "deepseek/deepseek-chat":
      maxConcurrent: 8
      maxRpm: 120
    "openai/gpt-4o":
      maxConcurrent: 2
      maxRpm: 10
      burstSize: 3
    "anthropic/claude-3-5-sonnet":
      enabled: false            # 对该模型跳过限速
  onThrottled: queue            # "queue" | "reject"
  maxQueueWaitMs: 60000
```

---

## 设置项参考

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `enabled` | `true` | 全局总开关。关闭时零开销直接放行。 |
| `strategy` | `"token-bucket"` | `"token-bucket"`（允许突发）或 `"sliding-window"`（平滑、严格 RPM） |
| `defaults.maxConcurrent` | `5` | 每个模型的最大同时请求数 |
| `defaults.maxRpm` | `60` | 每个模型每分钟最大请求数 |
| `defaults.burstSize` | `10` | 令牌桶容量 —— 一次最多可突发多少个请求 |
| `defaults.refillRate` | `1` | 每秒补充的令牌数（令牌桶）。未设置时由 `maxRpm / 60` 自动推导。 |
| `models.<key>.maxConcurrent` | — | 该模型的并发数覆盖 |
| `models.<key>.maxRpm` | — | 该模型的 RPM 覆盖 |
| `models.<key>.burstSize` | — | 该模型的突发容量覆盖 |
| `models.<key>.refillRate` | — | 该模型的补充速率覆盖 |
| `models.<key>.enabled` | — | 设为 `false` 可对该模型跳过限速 |
| `onThrottled` | `"queue"` | 请求触限时的行为：`"queue"`（等待）或 `"reject"`（立即失败） |
| `maxQueueWaitMs` | `60000` | 请求在队列中等待多久（毫秒）后放弃并被拒绝 |

> **注意**：当模型覆盖了 `maxRpm` 但未显式设置 `refillRate` 时，补充速率会
> 自动按 `maxRpm / 60`（每秒令牌数）推导。这样才能保证「设 maxRpm=3」真的限制到
> 每分钟 3 个请求。

---

## 算法对比

| | 令牌桶 | 滑动窗口 |
|---|--------|----------|
| **突发** | 允许（由 `burstSize` 控制） | 不允许 —— 严格平滑 |
| **恢复** | 令牌按 `refillRate`/秒补充 | 窗口持续滑动 |
| **最适合** | 容忍请求尖峰 | 有硬性每分钟上限的 API |
| **界面名称** | 令牌桶 (Token Bucket) | 滑动窗口 (Sliding Window) |

---

## 工作原理

```
Agent 轮次
  → LLM 调用（例如 deepseek/deepseek-chat）
    → ctx.on("llm/stream") 拦截器
      → 为该 provider/model 解析对应的限速器
      → 令牌桶：还有令牌且并发未满？
      → 是：消耗令牌、占用槽位、转发到 API
      → 否（拒绝模式）：立即返回 RATE_LIMIT 错误
      → 否（排队模式）：进入 waiters[] 等待令牌补充
    → 请求完成 → 释放槽位 → 唤醒等待中的请求
  → dsh-llm-retry 捕获 RATE_LIMIT → 指数退避 → 重试
```

---

## 开发

```bash
# 克隆
git clone https://github.com/Leafyezi233/dsh-llm-rate-limiter.git
cd dsh-llm-rate-limiter

# 安装依赖
pnpm install

# 跑完整测试套件（6 个文件，375 条断言）
pnpm test

# 单独运行各套件
node test-strategies.mjs       # 19 —— 限速算法
node test-status-rpc.mjs       # 61 —— 通道处理器与计数器
node test-client-bundle.mjs    # 106 —— 真实客户端 bundle 跑在迷你 React 运行时上
node test-host-integration.mjs # 80 —— 真实 apply(ctx, config) 接线与 volatile 引用
node test-status-route.mjs     # 73 —— 自注册路由与 0.1.5 回归
node test-config-schema.mjs    # 36 —— 设置页所依赖的 Config volatile 契约

# 针对真实 DSH 安装的实机 HTTP 验证（真实 socket、真实 webserver）
pnpm run verify:live           # 19 —— 无 DSH 时以退出码 2 跳过

# 运行端到端限速测试
node test-3rpm.mjs

# 安装到某个 DSH profile 里测试
dsh plugin add <your-profile> .
```

通过 `link:` 安装时，插件走实时符号链接 —— 对 `lib/` 的改动在浏览器硬刷新
（`Ctrl+Shift+R`）后即生效，无需重新安装。

---

## 兼容性

| DSH 版本 | 插件版本 | 状态 | 说明 |
|----------|---------|------|------|
| 0.1.2-rc.1 | 0.2.x | ✅ 已测 | 最初目标；`connection.rpc` 载体 |
| 0.1.5-rc.3 | 0.2.x | ✅ 已测 | 需要载体兜底；已通过实机 HTTP 验证 |
| **0.1.7-rc.1+** | **0.3.x** | ✅ **已测** | **`settingsScope` → `configForms`；`settings.plugin.item` → `plugins.item`；基于 Config 的设置** |
| 0.2.x（DSH） | — | ⚠️ 未测 | 可能需要调整 API |
| Cordis 5+ | — | ⚠️ 未测 | 大版本升级多半需要重写 |

### 0.3.0 的破坏性变更

DSH 0.1.7 移除了本插件设置界面所用的两个客户端服务：

| 0.1.5 | 0.1.7 |
|-------|-------|
| `settingsScope` 服务 | `configForms` 服务 |
| `settings.plugin.item` 槽位 | `plugins.item` 槽位 |
| 宿主 `ctx.settings.register(ns, schema, { base })` | 条目自己导出的 `Config` schema |
| 宿主 `scope.get()` / `scope.watch()` | `.volatile()` 引用，用 `.get()` 读取 |

**0.3.0 只支持 DSH 0.1.7-rc.1+。使用 0.1.5 请安装 `0.2.x`。**

本次迁移所依赖的四个断裂点，已就地写在 `lib/index.js` 与 `lib/types/config.js`
的注释里；完整推理记录在 [CHANGELOG.md](CHANGELOG.md) 的 `[0.3.0]` 段落。

---

## 许可证

[MIT](LICENSE)
