# 规划入口

- [基线](baseline/README.md)
- [模型路由与账号池](plans/account-pool/README.md)：Complete，访问密钥页面、21 账号重启持久化与生产验收通过。完整工具清单的模型稳定性限制见[兼容性记录](../tool-compatibility.md)。
- [通用客户端兼容](plans/client-compatibility/README.md)：Complete，通用 system 能力契约、工具示例解析、最新项目对照及 87 生产后验通过；限制见验收记录。
- [混合任务与调度验收](../mixed-scenario-verification.md)：58项回归，额度伪成功已修复并部署；生产38个场景完成，文案质量限制单独保留。

- [临时限额冷却验收](../temporary-cooldown-verification.md)：默认300秒可配置、上游恢复时间优先、重启持久化；68项回归、87候选与生产验收。

- [限额自动查额度验收](../limit-quota-probe-verification.md)：同账号合并与节流、全局有界并发、迟到结果保护；77项回归，87候选20并发只查1次真实额度，候选/生产三协议各6/6通过。

- [yuanzhang JSON 导入](../yuanzhang-json-import.md)：实现与 17 部署完成，89 项回归、13 账号去重、候选三协议及正式内网验证通过；默认原生 JSON 不自动兼容。
- [17 部署与内网接入](../deployment-17.md)：35 账号复制，sub2api-b 账号 2471 仅改名称与 base_url，经已有 services-internal 网络访问；其它服务未重启。
