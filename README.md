# TT Agent 站点限流 0.2.0

**按上游站点统一设置 RPM 和请求并发，继续选择原来的模型。** 无需选“限流 ·”模型，无需逐个接入 Agent。适用于 Windows TauriTavern 2.4.0 的自定义 HTTP/SSE API 连接。

这是独立的第三方扩展与本机服务项目，不修改 TT 安装程序。运行时没有 npm 依赖；开发与测试依赖单独列在 `devDependencies`。源码采用 [MIT 许可证](LICENSE)，与 TauriTavern 官方项目无隶属关系。

[下载安装包](https://github.com/luicarstar/tauritavern-agent-site-limiter/releases) · [反馈问题](https://github.com/luicarstar/tauritavern-agent-site-limiter/issues)

## 使用

1. 从本仓库的 Releases 下载 ZIP，解压到一个固定目录。安装 Node.js 22 或更新版本后，在 PowerShell 中运行 `./安装插件.ps1`。使用非默认数据目录时：`./安装插件.ps1 -DataRoot '你的 TT 数据根目录'`。
2. 重新加载 TT，在 **扩展设置 → Agent 站点限流** 中，为需要限制的站点勾选启用，填写 RPM 与请求并发数，保存。
3. 继续使用原模型与 Agent。启用规则的站点自动经本机服务发送；其他站点保持原连接方式。
4. 重启电脑后，先运行 `启动限流服务.ps1`，或用 `启动TT与限流.ps1` 一起启动。此版本不添加开机启动项。

一起启动时可指定 TT 可执行文件：`./启动TT与限流.ps1 -TauriTavernExe 'C:\Apps\TauriTavern\tauritavern.exe'`。如果 TT 已经打开，则不必指定路径。

这不是只粘贴 Git URL 就能完成安装的纯前端扩展；请使用发布包和安装脚本，以便同时配置本机服务。不要只在 TT 内的扩展安装器中填写本仓库地址。

升级时在原目录覆盖发布包并保留 `runtime/`，然后重新运行安装脚本。更换存放目录前先停止原服务，保留并迁移本机 `runtime/`，避免出现两个不同配对令牌的服务占用同一端口。

从 0.1 升级时，自动迁移为站点规则、恢复旧版改过的 Agent 模型绑定，改用原名称的模型列表。旧版生成的、未被用户修改的写作 Agent 会切回原来的当前 Agent；如面板提示，请再重新加载一次界面。用户改过的指令与工具设置保留。

## 规则如何计算

- 每个站点一组额度，默认 RPM 30、实际请求并发 2、均匀发送开启，可分别修改。
- 站点是 URL 的 **协议 + 域名 + 端口**。例如 `https://api.example.com/v1` 和 `/v2` 共用额度。HTTP 与 HTTPS、不同端口分别计数，不合并子域名。
- 同一站点上的不同模型、主 Agent、子 Agent、工具循环和重试共用额度。不同站点独立计数，不互相占用并发。
- RPM 按滚动 60 秒计算。排队请求不计数；实际发出的失败、重试或取消请求都计数。RPM 为 0 表示不限频率，仍限制并发。
- 均匀发送另外保持 `60/RPM` 秒的最小发送间隔，避免集中突发。
- 一次 HTTP 请求从开始发送到完整响应或 SSE 结束、失败、取消期间占用并发。父 Agent 等待子任务时不占用请求槽位。
- 保存规则对后续请求生效；降低额度不会中断已发出的请求。关闭站点规则时恢复后续连接直连，已准备的旧连接经过服务时也不再受该站点额度限制。
- 队列每站点最多 512 项、最多等待 15 分钟，仍受 TT 自己的连接超时约束；上游连续空闲 10 分钟会结束。

## 与模型、Agent 配置的关系

模型名称、模型 ID、原 API 配置与 Profile 的模型绑定保持原样。插件只在 Agent 捕获模型连接快照与保存原生模型连接时，按规则替换实际传输地址。TT 的模型连接同步也经过同一入口，不需要给每个 Agent 重新选特殊模型。

“同步已保存模型”把普通 API 连接转换成 TT 可供子 Agent 选择的“仅模型配置”，使用原连接名称，不添加限流前缀。原普通连接保留。

子 Agent 数量仍是 Profile 的 `delegation.maxConcurrentInvocations`，与实际请求并发是两项设置。面板的折叠区保留子 Agent 数量入口；内置 Default Writer 要创建副本才能修改这项策略。

## 支持范围

- 支持自定义 API 的 OpenAI Chat Completions、OpenAI Responses HTTP、Claude Messages、Gemini GenerateContent 和 Gemini Interactions，包括 SSE。
- 作用于当前 TT 页面在插件初始化后创建的 Agent 连接快照、独立绑定连接，以及其主 Agent／子 Agent 模型请求。普通聊天和其他软件没有被系统全局接管。
- 已经运行的 Agent 可能已冻结旧连接；请从下一次新运行验证。插件加载前冻结的历史 Run 续接不保证自动补接路由。
- 内置供应商固定端点、Responses WebSocket、AWS/Vertex 专用认证不在当前支持范围。匹配站点的 WebSocket 会明确报错，可切换 HTTP/SSE。
- TT 升级后若更改 Agent API，需要重新验证。插件依赖 2.4.0 的连接快照与模型连接 API 方法。
- 本机服务直接连接上游，不继承 TT 内的 Request Proxy；需代理的站点应填写可直接访问的中转 Base URL。
- 新的本机模型端点可能触发 TT 自己的原生端点授权对话框，需要用户确认。

## 本机服务与数据

模型调用在 TT 的 Rust 后端执行，前端计时器无法限制每轮请求，因此仍需只监听 `127.0.0.1:19377` 的本机转发服务。这个服务自动按站点排队，不需要手动改模型名或连接地址。

不记录提示词、响应正文或 API Key，不发送统计数据；认证仅随请求转发。`runtime/state.json` 保存配对令牌、站点规则、路由与请求时间戳。TT 的扩展存储保存连接原值、旧版迁移备份与规则；连接中的凭据引用仍由 TT 解析。请勿分享本机 `runtime/` 或安装后的 `client-config.json`。

停用前先在面板关闭所有站点规则并保存，让已物化连接恢复直连，然后再停用插件和服务。直接停服务时，已经路由的模型请求会失败，不会偷偷绕过限流。原 API 连接配置没有被改成 localhost。

## 验证

源码测试运行 `npm ci --ignore-scripts`、`npm test`。21 项测试覆盖排队、取消、流式并发、滚动 RPM、站点合并与隔离、原生协议转发、自动路由、面板和旧版迁移。测试仅使用本机模拟上游，不产生真实模型费用。

更多信息见 [工作原理与兼容边界](docs/ARCHITECTURE.md)、[开发与打包](docs/DEVELOPMENT.md) 和 [版本记录](CHANGELOG.md)。
