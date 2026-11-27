# 17 部署与 sub2api-b 内网接入

日期：2026-11-27。实现提交：`730fa4266fde2a32aa7f4a58bcc771d94995ccae`，本地镜像：`aws-quick/kuk-enhanced:730fa42`。

- 源码：17 的 `/root/code/aws-quick2api-tool-bridge`，从 fork 的 `feat/model-routing-account-pool` 分支拉取构建。
- 部署：`/root/docker-compose/aws-quick2api-kuk-59158/compose.yaml`。
- 后台：`http://192.6.47.17:59158/dashboard`；API：`http://192.6.47.17:59158`。
- 内网：`http://aws-quick-17:3456`，加入已存在的 `services-internal` Docker 网络；端口不经过 87 或公网转发。
- 从 87 复制 35 账号（17 启用、18 停用）、原客户端访问密钥及权限、身份信息、历史账本与调度配置。管理密码按部署要求设置，仅存放于远端受限文件，原管理员会话签名密钥不复制。
- 保留 quota-aware、单账号并发 2、全局并发 20、会话亲和 3600 秒、临时冷却现值 60 秒、思考显示现值 true。

## 验证

本地 preflight 的凭证扫描、类型检查、构建与 89 项回归全部通过。候选绑定 `127.0.0.1:59162`，校验迁移的启停账号 ID、调度设置、客户端密钥文件与账本哈希；Haiku/Messages、Sonnet/Chat Completions、Opus/Responses 三协议真实请求均返回原随机标记。

候选的原生 JSON 导入接口对来源文件返回 400；显式 yuanzhang 接口返回导入 0、跳过 13，账号仍为 35 个。公网后台与默认原生/可选 yuanzhang 选择器已验证。

候选停止后，正式容器使用同一数据目录与镜像启动。健康检查通过，重启计数 0，无 OOM。从 `sub2api-b-app` 的网络命名空间使用原账号 API Key，通过内网 DNS 获取模型目录并完成带随机标记的真实 Messages 请求。

## sub2api-b 切换

复用账号 **2471**：`87-aws-quick` → `17-aws-quick`，Base URL 从 `http://152.53.242.87:59158` 改为 `http://aws-quick-17:3456`。通过现有管理 API 更新；凭证仅改变 base_url，保留 API Key、五个模型映射、pool_mode、重试次数、分组 253、倍率、并发 100、优先级、代理与启停状态。应用自行清理旧上游的额度探测缓存并更新时间，不修改其它业务配置。

定向账号 SSE 测试返回 content 与 test_complete/success。已观察到通过新服务完成的实际业务请求。原 87:59158 的账号地址在 sub2api-b 中剩余 0 个。sub2api-b 应用、Postgres、Redis 的容器 ID、启动时间、重启次数均保持不变。

87 的服务保持 healthy、原镜像与原重启计数；本次未更新或停止 87。已观测到少量 AWS 上游 content_filtered，沿用既有错误处理，不把它标记为部署连通性失败。

## 证据与回滚

远端受限证据：部署目录的 `deployment-20261127.json` 与 `validation/`，包含候选协议验证、迁移一致性、内网调用与账号切换前后记录。初始副本保存在 `backups/initial-copy-20261127/state-before-start.tar.gz`。凭证与备份不进入仓库。

将 sub2api-b 账号恢复到原 87 地址与名称：在部署目录运行 `python3 validation/switch-sub2api.py rollback`，无需重启其它服务。两机账号状态、配置、令牌刷新与新导入账号不自动同步；跨实例刷新锁仍是独立后续工作。
