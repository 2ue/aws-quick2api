# 状态

Current Phase：工具与 MCP 修复完成；追加思考控制兼容性实现与候选验证。

Next Target：补齐思考入口，远端统一发布修复镜像，核验内置工具、延迟 MCP 和思考模式。

Last Landed：2026-11-23，87 已运行改造版；原地址和账密保留。

Active TODO：思考参数与关键词兼容、真实事件验证、最终镜像更新与线上短验。

Last Verified：44 项测试与 preflight 通过；真实 stdio / HTTP 延迟 MCP、Sonnet 精简工具、Opus 完整工具、24 次并发会话标记请求。结果和失败样本见[兼容性记录](../../../tool-compatibility.md)。

证据：87 `/root/docker-compose/aws-quick-comparison/enhanced-deployment.json` 与 `enhanced-smoke-59162.json`、`enhanced-smoke-59158.json`。

边界：当前仅 1 个真实账号，20 账号验证使用模拟账号；跨实例刷新未协调。

复现：Claude Code 2.1.280 使用 draft/2020-12 的 Bash / Read schema，现有 Ajv 默认 draft-07 编译失败，首请求返回 400。独立 MCP 普通 schema 的两次真实调用与结果回传已成功；deferred discovery 继续验证。

约束：独立 CLAUDE_CONFIG_DIR、空 setting-sources、strict-mcp-config；不修改个人 Claude Code 设置或连接个人 MCP。

思考实测：-think / -thinking 已选 high，但 Sonnet 的本组样本没有原生思考事件；Opus 有。ultrathink 正文仍为 off；默认路由说明误用思考块。应补齐入口并默认不生成路由思考块，不能伪造上游未返回的内容。
