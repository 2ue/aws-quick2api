# 通用客户端兼容验收（2026-11-25）

通过上游原生 `custom_prompt` 补充通用能力契约。不修改题目，不按关键词重写任务，不要求使用者点名工具。需要环境操作时由模型选择客户端工具；普通对话、代码展示和方案讨论直接回答。测试台的题目特例已撤回。

## 最新代码对照

| 项目 | 本次检查的 main 提交 | 参考点 |
| --- | --- | --- |
| [kuk](https://github.com/kuk-888/aws-quick2api/tree/812c387e758f585d68609ea3122aa1b7115316c9) | `812c387`，v0.1.15 | 客户端工具优先、代码示例保护、Custom Agent 和会话恢复；独立运行最新版验证，未合并无关架构变更。 |
| [anon](https://github.com/anon0v0/quick2api/tree/1dc5d4d1028ed60e6be706fb35db6c9b25364eed) | `1dc5d4d` | 无工具时使用 Direct API Mode，禁用内部工作区操作；system 和工具保留在 custom_prompt。 |
| [jason](https://github.com/jasonxu114514/aws-quickwork-2api/tree/343d347ff90d5ab95f57503db91d5b04a55362e2) | `343d347` | caller_tool_interface 区分客户端执行，收到真实结果后继续任务。 |
| [avilliai](https://github.com/avilliai/awsquick2api/tree/ebc07822a5a166edcd07630fb293a90cf4fa3f32) | `ebc0782` | JSON 客户端工具适配器。与已部署版本相比，compat/native_upstream/cli_api/native_protocol 未变，更新集中在 Key/UI。 |

相同自然提示与客户端工具定义下，四套均能实际写出待办页面。无工具的原始鹈鹕提示：anon 返回完整源码，kuk 最新版、jason 和 avilliai 返回 Quick 工作区产物链接。本 fork 的通用适配同时通过两种调用。这是有限场景对比，不作为整体质量或成功率排名。

## 真实验证

| 场景 | 结果 |
| --- | --- |
| 原始鹈鹕提示，Claude Code 默认工具 | 没点名工具或文件；Opus 自行 Write，真实生成 12,888 字节 HTML/SVG，无 qw-file 链接。 |
| “做个本地待办小应用……” | 没有“项目”字样，没有工具指令；Sonnet 自行 Write，生成 index.html。 |
| 隐式多文件实现 | Opus 自行 Bash 检查、Write 生成 11 个 Node 待办应用文件、Bash 运行测试；独立再次运行，20 项全部通过。 |
| 自定义名称工具 | Messages、Chat Completions、Responses 验证 workspace_list/read/write/patch，不依赖 Claude Code 工具名。 |
| 现有代码修改 | Sonnet 先读后 patch；独立验证 total(0.1, 3) 返回数值 0.3。 |
| 读取不存在文件 | 真实错误后列目录、找到 docs/guide.md、读出隐藏标记。 |
| 普通对话、只展示代码、只讨论方案 | 有工具时仍直接回答，没有写文件；真实 CLI 闭包问答也无工具调用。 |
| 无工具交付 | Messages 返回完整 HTML/SVG，Responses 按文件展示代码，没有假称本地落盘。 |
| 不点名“项目”的 Responses 任务 | 开销记录页面、Opus think 番茄钟需求均自动读写完成。 |
| MCP 延迟加载 | CLI 完成 ToolSearch → mcp__fixture__lookup_record → Write；MCP 有实际调用记录，JSON 报告落盘。 |
| Haiku 自然任务 | 自行写出温度换算页面。 |
| tool_choice | auto、none 和指定工具分别验证；强制模式仅检查协议，不作为自发编程证据。 |
| 并发会话 | 两个独立会话各三轮，返回各自随机标记及变换，无交叉。 |
| 工具语法代码示例 | 回归覆盖反引号/波浪号代码块、行内代码、1–17 字符流式分片、示例后真实调用、文件内容中的关闭标签；真实模型解释协议时不执行示例。 |

CLI 使用独立 CLAUDE_CONFIG_DIR、空 setting-sources、strict-mcp-config。个人配置关键文件前后哈希一致；没有连接个人 MCP。详细请求、工作区、成功与失败样本存放在仓库外 `outputs/awsq-compat-20261125/`。

## 未解决的上游限制

- 一条含“私有令牌”的 Opus think 工具请求，在本 fork 与 kuk 最新版均触发 content_filtered。Sonnet 同一请求、Opus think 的真实 CLI MCP 任务成功。不静默换模型，也不把失败算作通过。
- 首轮问答一次连接失败，独立复测成功。一次 Sonnet 多文件任务完成写入后，最终确认轮 WebSocket 1006 断开，记录为失败。
- 桥接依赖上游生成正确调用；有限样本不能证明所有任务或长期负载均稳定。
- 无客户端工具时无法操作调用者磁盘，应返回内容。真实读写由提供工具的 CLI/IDE 执行。

## 发布验证

53 项回归、TypeScript、preflight 通过。继续从 fork 拉取固定提交并构建镜像，先用独立候选容器验证三协议和真实工具循环，再切换生产，保留原镜像与回滚脚本。
