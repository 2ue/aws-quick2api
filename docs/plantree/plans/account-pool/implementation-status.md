# 状态

Current Phase：修复访问密钥列表的 s is not defined，并完成生产重启验收。

Next Target：运行有密钥数据的渲染回归，更新 87，核验密钥与凭证页面及账号持久化。

Last Landed：2026-11-23，87 已运行改造版；原地址和账密保留。

Active TODO：密钥页面修复上线；保留现有思考显示设置；21 账号重启与界面验证。

Last Verified：47 项测试与 preflight；真实 stdio / HTTP 延迟 MCP、Sonnet 精简工具、Opus 完整工具、24 次并发会话标记请求。思考显示开关 JSON/SSE 与重启持久化通过；最终 Opus thinking 完整工具及 HTTP MCP、Sonnet thinking 延迟 MCP 通过。结果和失败样本见[兼容性记录](../../../tool-compatibility.md)。

证据：87 `/root/docker-compose/aws-quick-comparison/enhanced-deployment.json` 与 `enhanced-smoke-59162.json`、`enhanced-smoke-59158.json`。

边界：当前 21 个真实账号；新增 20 个均参与过成功推理，40 请求全部成功。跨实例刷新未协调。

复现：Claude Code 2.1.280 使用 draft/2020-12 的 Bash / Read schema，现有 Ajv 默认 draft-07 编译失败，首请求返回 400。独立 MCP 普通 schema 的两次真实调用与结果回传已成功；deferred discovery 继续验证。

约束：独立 CLAUDE_CONFIG_DIR、空 setting-sources、strict-mcp-config；不修改个人 Claude Code 设置或连接个人 MCP。

思考实测：-think / -thinking 已选 high，但 Sonnet 的本组样本没有原生思考事件；Opus 有。ultrathink 正文仍为 off；默认路由说明误用思考块。应补齐入口并默认不生成路由思考块，不能伪造上游未返回的内容。

上述思考入口和路由说明问题已修复。思考显示默认关闭；真实日志仍可观测到上游思考事件。生产更新证据补充在 87 comparison 目录的 tool-thinking-deployment.json。
