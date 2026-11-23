# Magpie Usage for Cindy

在 Cindy 的状态栏和用量卡片里查看 Magpie 网关各账号的额度、当前会话实际路由和重置时间。

仓库：https://github.com/hsthanb4/cindy-magpie-usage
欢迎提交 Issue 和 PR。

[English](README.en.md)

## 功能

- **状态栏胶囊**：跟随当前任务，显示实际服务的 provider、账号和额度窗口。使用 group/task-auto 时显示 auto→，并读取 Magpie 路由日志确认真实落点，而不是猜 provider 的最近账号。
- **用量卡片**：所有账号的已用/剩余额度、重置倒计时、邮箱脱敏、网关来源；顶部显示全局最近一次路由链。
- **最近路由标记**：卡片里高亮最近一次请求实际使用的账号，和“最近使用”区分。
- **多账号/多窗口**：同一 provider 多个账号且无法确定会话账号时显示用量范围；多窗口时标明具体已满窗口（如 Credits 已满），不笼统说“已用尽”。
- **Agent 工具**：magpie_usage 返回账号额度、余额和 latestRoute，可按 provider 过滤。
- **多网关**：读取本机与可配置的远程 Magpie 网关额度。

## 要求

- macOS 上运行 Magpie，默认网关 http://127.0.0.1:3425。
- Cindy 0.1.137+。
- 想让胶囊显示“本会话实际路由”，需要 Magpie 的路由日志 ~/.config/magpie/routing/（默认开启）。日志缺失、远程会话或引擎未回传同一 session ID 时，回退到 provider 的最近使用账号。

## 安装

在 Cindy 的插件市场搜索 **Magpie Usage** 安装。市场版本更新后按 Cindy 的插件更新流程升级。

本地开发：把源码放到独立作者目录，用 Cindy 的插件 Forge 打包/安装；不要直接改已安装插件目录。

## 开发

纯 JavaScript，无构建步骤：

- main.js：Cindy 电子脑入口，状态栏胶囊与 MCP 工具处理。
- node/worker.cjs：Node 工作进程，读取 Magpie /v1/magpie/quotas、/v1/models 和 ~/.config/magpie/routing/*.jsonl，并只读查询 Cindy sessions 表拿 sdk_session_id。
- ui/detail.html：用量卡片页面。
- ghost.json：插件清单。

语法检查：

    node --check main.js
    node --check node/worker.cjs

手动验证：在 Cindy 里打开状态栏胶囊和用量卡片，分别看直连模型、group/task-auto、额度耗尽/多账号场景。

## 贡献

欢迎提交 Issue 和 PR。请先开 issue 说明场景；PR 保持改动小而聚焦，更新 ghost.json 的版本和 releaseNotes，并附上验证方式。不要提交 token、gateways.json 或含凭证的日志。

## 许可证

MIT
