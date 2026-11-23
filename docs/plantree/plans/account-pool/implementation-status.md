# 状态

Current Phase：resume → execute-ready，工具与 MCP 兼容性复测。

Next Target：支持 JSON Schema draft/2020-12，验证真实 Claude Code 内置工具与 MCP；保持个人 CLI 配置不变。

Last Landed：2026-11-23，87 已运行改造版；原地址和账密保留。

Active TODO：schema 方言修复、自动工具及 MCP 发现/回传验证、候选验证与远端更新。

Last Verified：38 项测试通过；候选三协议、五型号、工具回传、原图识别、2/4 路真实请求通过；更新后公网模型列表和对话通过。

证据：87 `/root/docker-compose/aws-quick-comparison/enhanced-deployment.json` 与 `enhanced-smoke-59162.json`、`enhanced-smoke-59158.json`。

边界：当前仅 1 个真实账号，20 账号验证使用模拟账号；跨实例刷新未协调。

复现：Claude Code 2.1.280 使用 draft/2020-12 的 Bash / Read schema，现有 Ajv 默认 draft-07 编译失败，首请求返回 400。独立 MCP 普通 schema 的两次真实调用与结果回传已成功；deferred discovery 继续验证。

约束：独立 CLAUDE_CONFIG_DIR、空 setting-sources、strict-mcp-config；不修改个人 Claude Code 设置或连接个人 MCP。
