# 状态

Current Phase：Complete，访问密钥页面和生产重启验收完成。

Next Target：按需扩展完整工具目录和长期负载验证。

Last Landed：2026-11-23，87 已运行改造版；原地址和账密保留。

Active TODO：无本次实施待办。

Last Verified：49 项测试与 preflight；生产浏览器密钥列表、21 行凭证表和路由开关加载正常，无页面脚本错误。实际重启保留 21 账号与思考显示现值，额度同步无错误；线上内置 Read/Bash 和延迟 HTTP MCP 实际执行通过。此前真实 stdio / HTTP MCP、完整文件工具、24 次并发标记测试结果和失败样本见[兼容性记录](../../../tool-compatibility.md)。

证据：87 `/root/docker-compose/aws-quick-comparison/enhanced-deployment.json` 与 `enhanced-smoke-59162.json`、`enhanced-smoke-59158.json`。

边界：当前 21 个真实账号；新增 20 个均参与过成功推理，40 请求全部成功。跨实例刷新未协调。

已修复：Claude Code 2.1.280 的 draft/2020-12 Schema、MCP 延迟加载 tool_reference、客户端工作区误识别、按线程连接隔离与错误参数触发账号冷却。

约束：独立 CLAUDE_CONFIG_DIR、空 setting-sources、strict-mcp-config；不修改个人 Claude Code 设置或连接个人 MCP。

思考实测：-think / -thinking 已选 high；关键词与显式参数入口已补齐。Opus 真实思考在隐藏时仍被观测到；显示开关与思考强度独立，默认关闭，运维修改后的现值按原样保留。

上述思考入口和路由说明问题已修复。思考显示默认关闭；真实日志仍可观测到上游思考事件。生产更新证据补充在 87 comparison 目录的 tool-thinking-deployment.json。

访问密钥页面曾混入账号专用并发按钮，引用未定义 s.slotId；已移除并补 populated renderer 回归。生产已实际验证密钥与接入示例恢复，21 个账号数据未丢失。


2026-11-24 follow-up: a client file request returned an AWS Quick `qw-file://workspace/artifacts/...` link instead of invoking the external client's file-writing tool. The tool bridge now explicitly routes file creation/edit/save requests through declared client tools in both custom instructions and per-turn reminders. File content belongs in tool arguments; completion requires the real client result. This follow-up intentionally does not add or run tests, per the request. Build and container health are checked separately.
