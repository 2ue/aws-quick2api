# 模型路由与账号池

三个协议共用模型路由、权限、队列和账号调度：

| 对外模型名 | 上游档位 | 思考强度 |
| --- | --- | --- |
| `claude-haiku-5-5` | `fast` | `off` |
| `claude-sonnet-5-5` | `balanced` | `off / low / medium / high` |
| `claude-opus-5-5` | `smart` | `off / low / medium / high` |
| `claude-sonnet-5-5-think` | `balanced` | 默认 `high` |
| `claude-opus-5-5-think` | `smart` | 默认 `high` |

映射在源码 `src/services/model-config.ts` 内置配置，不读取外部映射文件。`/v1/models` 只展示表中五个名称。

继续支持 `quick-fast`、`quick-balanced`、`quick-smart`、`quick-balanced-think`、`quick-smart-think`，以及明确注册的 `amazon-*`、`quick-*-5.5`、点号和区域前缀名称。未知型号返回 404，未启用的 Advanced 返回 403。Quick 仍按档位选择底层模型，版本别名不保证锁定该型号。

思考参数支持 Chat 的 `reasoning_effort`、Responses 的 `reasoning.effort`、Messages 的 `output_config.effort` 和 `thinking`。显式参数优先于模型别名默认值；多个显式参数冲突返回 400。Fast 归为 off，max/xhigh 归为 high。响应头 `X-Quick-Agent-Mode`、`X-Quick-Thinking-Effort`、`X-Quick-Normalized` 展示最终配置。模型权限按规范型号检查，别名不能绕过限制。

## Claude Code 思考控制与显示

思考是否启用与思考内容是否显示独立控制。`SHOW_THINKING_CONTENT=false` 是默认值，只过滤返回客户端的思考事件，不改变发送给 Quick 的 `thinking_effort`。管理台「路由配置 → 显示思考内容」可以立即切换并持久化；也可以管理员调用 `POST /v1/admin/settings`，请求体为 `{"showThinkingContent":true}` 或 `false`。

| 输入方式 | 选用的思考强度 |
| --- | --- |
| Sonnet / Opus 的 `-think`、`-thinking` 后缀 | 默认 high |
| `-think-low` / `-thinking-medium` / `-thinking-high` | 对应 low / medium / high |
| Claude Code `--effort low/medium/high` | 按请求中的 `output_config.effort` 选择 |
| Claude Code `--effort xhigh/max` | 归一化到 Quick 的 high |
| 当前用户请求含独立单词 `ultrathink` | 没有显式 effort 或关闭参数时选 high |
| `thinking.type=enabled/adaptive`、`thinking.enabled=true`、`enable_thinking=true`、`thinking=true` | 未给 effort 时选 high |
| `thinking.budget_tokens` | 小于 2048 为 low；2048 到 8191 为 medium；不小于 8192 为 high，属于近似映射 |
| `thinking=false`、`thinking.type=disabled`、`thinking.enabled=false` | 关闭思考；与显式非 off effort 冲突时返回 400 |

Chat 的 `reasoning_effort`、Responses 的 `reasoning.effort`、`thinking_effort`、`thinking.effort`、`effort` 也共用解析。显式请求参数优先于关键词和后缀；系统提示、工具结果和旧用户回合中的 ultrathink 不会替代最新用户请求。

Haiku / fast 当前归一化为 off；本次未声明其支持思考。Quick 只有 off/low/medium/high，不能原生执行 max/xhigh。响应头 `X-Quick-Thinking-Visible` 表示显示开关，`X-Quick-Thinking-Effort` 表示实际选用并发送的强度。

上游有时不返回思考文本，是否返回文本不能单独证明是否执行思考。开启显示只转发真实上游事件，不补造内容。`SHOW_ROUTED_MODEL_IN_THINKING=false` 默认关闭旧的路由说明；路由信息不作为思考执行证据。未报告独立 reasoning token 数时不估算该数值。

2026-11-23 候选实测：同样 high 强度，关闭显示的 JSON / SSE 回复都没有思考文本，但请求日志仍观测到真实上游思考事件；开启后分别转发 279 / 199 字符。重启容器仍保留开启设置，验收结束恢复为关闭。字数只代表这组样本，不表示固定思考预算。Claude Code 2.1.280 的 `--effort low/max/xhigh` 已实测发出对应 `output_config.effort` 并成功完成；max/xhigh 最终映射 high。

## 20 个账号的起始配置

```dotenv
LB_STRATEGY=quota-aware
SESSION_AFFINITY_ENABLED=true
ACCOUNT_MAX_CONCURRENT=2
GLOBAL_MAX_CONCURRENT=20
CLIENT_KEY_MAX_CONCURRENT=20
MAX_QUEUED_REQUESTS=200
QUEUE_WAIT_TIMEOUT_MS=30000
ENABLE_ADVANCED_MODEL=false
```

这些是网关运行参数，需按账号的真实限额逐步验证。全局 20 表示最多执行 20 个请求；每账号 2 表示任何账号不会超过两个上游请求。加账号不会自动增加全局上限。按账号权重归一化活跃负载，并优先使用有剩余额度的健康账号。额度只在手动同步后更新；未知额度不会被视为零。

客户端 Key 的并发上限、全局上限、显式会话互斥和账号容量分别检查。排队达到长度上限或等待超时返回 429 与 `Retry-After`。没有可用授权或额度耗尽返回明确错误。全部账号处于冷却时等待，不立即重打冷却账号。请求取消释放队列位置与租约。已经输出正文、思考或工具调用后不换号重发。

管理台「路由配置」可调整默认账号并发，在「凭证」页的「并发 / 权重」为单账号覆盖。全局请求接纳上限通过环境变量设置，重建容器后生效。管理接口也可操作：

```http
PATCH /v1/admin/keys/<slotId>
Authorization: Bearer <ADMIN_PASSWORD>
Content-Type: application/json

{"maxConcurrent":2,"weight":1}
```

`KEY_CONCURRENCY_LIMITS` 与 `KEY_WEIGHTS` 由系统持久化到 `.env`，键为稳定账号 slotId。默认限制通过 `POST /v1/admin/settings` 的 `accountMaxConcurrent` 设置。

## 会话和刷新

多轮请求应传稳定的 `X-Conversation-Id` 或 `X-Session-Id`。同一个显式会话串行，不同会话并发。请求 Key 的命名空间隔离用户；规范型号与思考强度隔离线程复用。已有前缀校验在历史修改、工具回合或不匹配时回退全量上下文。只用相同首句推导的亲和性不会锁死独立请求。

OAuth 刷新在进程内合并，刷新结果写回原账号后才被报告为成功。slotId 根据租户和客户端 ID 派生；令牌轮换保留账号元数据、并发限制与会话亲和性。现有 token 派生的 slotId 在首次加载时迁移元数据。

单实例拥有一份数据目录和授权。不同容器同时持有同一授权的刷新不由本进程协调；长期运行应让主网关独立负责相应账号。OAuth 账号的图片采用原生上传、扫描和会话交付，保留原始像素；单图上限 10 MiB。网页凭据继续使用已有压缩路径。`NATIVE_IMAGE_UPLOAD=false` 可切回压缩路径。模型映射固定在源码内置配置；分布式刷新锁不在本次改造中。

## 运维

`GET /v1/usage` 的 `runtime.admission` 返回活跃数、排队数和限额；`keyPool` 返回每账号的活跃数、并发上限和权重。日志同时包含请求名称、规范型号、档位、思考强度和上游实际型号。凭据仍只保存在运行配置，勿提交 `.env`、数据目录或账号文件。

工具调用返回前检查声明名称、JSON Schema、tool_choice 和并行限制；不执行客户端工具，保留流式文本输出。
