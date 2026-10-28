# Dispatch 部署变更记录

## 2026-10-28：异步提交 Observe、设备回执写回、供应商计费

- 影响机器：`chat-home-server`。
- 变更内容：
  - 提交 Observe 改为异步 `observe.sms.enqueue`：设备受理（进入端口发送队列）后立即确认 MQ 消息，并传通道 `sendInterval` 由 Observe 按端口限速；端口队列已满时换通道内其他端口，全部忙时等待重试，最长 60 秒后记为 `PORT_BUSY`。
  - 消费 `chat.sms.receipt.observe` 回执队列写回发送记录（只更新 submitted）；每 30 秒检查提交超过 10 分钟仍为 submitted 的记录，按短信ID查询 Observe 补偿，设备没有记录时记为 `RECEIPT_TIMEOUT` 失败，不重新发送。
  - 供应商计费：预付在设备受理时计费，后付在写回 success 时计费；计费事件经 `tb_srm_billing_outbox` 发件箱发布到 Finance。
- 机器侧操作：部署脚本给 `chat_web_dispatch_service` 增加 `tb_srm_billing_outbox` 的 `SELECT`、`INSERT`、`UPDATE`；RabbitMQ 账号需在 `/chat-sms` 有声明回执、计费交换机和队列的权限。
- 前置条件：先发布 base-schema，再部署 Observe、Hooks、Finance，最后部署 Dispatch。
- 回滚方法：回退 Dispatch 镜像（旧版走同步 `observe.sms.submit`，新版 Observe 仍兼容）；已写入的发送记录和计费事件保留。

## 2026-10-26：发送记录改为写入 SRM 设备短信表

- 影响机器：`chat-home-server`。
- 变更内容：Dispatch 的 MySQL 配置键从 `database.chat-web-dispatch` 改为 `database.chat-web-srm`，注册发送记录及发送快照所需的 SRM 实体；不再使用独立的 `chat-web-dispatch` 业务库。
- 机器侧操作：部署脚本给 `chat_web_dispatch_service` 授予 `chat-web-srm.tb_srm_simbank_message` 的 `SELECT`、`INSERT`、`UPDATE`，以及 `tb_srm_channel`、`tb_srm_channel_port`、`tb_srm_simbank_port`、`tb_srm_simbank`、`tb_srm_user`、`tb_srm_simbank_quote` 的 `SELECT`，收回旧 `chat-web-dispatch` 库权限，并把 Nacos 中旧的 `database.chat-web-dispatch` 节点替换为 `database.chat-web-srm`。
- 验证命令：`yarn test`；部署后 `SHOW GRANTS FOR 'chat_web_dispatch_service'@'%'` 只包含 `USAGE`、发送记录写权限和发送快照只读权限，容器 `/health` 返回 200。
- 回滚方法：回退镜像前恢复 Nacos 的 `database.chat-web-dispatch` 节点，并重新授予旧库权限；SRM 中已写入的发送记录保留。

## 2026-10-21：首次部署自动准备数据库、Nacos 和网关路由

- 影响机器：`chat-home-server`。
- 变更内容：部署前在 `chat-web-mysql` 中幂等创建 `chat-web-dispatch` 和专用账号，写入 `chat-web-dispatch-service.yaml`（Redis index 5，网关凭据从 SRM 配置复制），并给生产和开发网关配置追加 `/api/dispatch`、`/feign/dispatch`。已有 Nacos 配置只校验，不覆盖。
- 机器侧操作：无需手工建库或写 Nacos；密码保存在部署目录 `.dispatch-mysql-password`，权限 0600。
- 验证命令：`yarn test`；部署后容器 `/health` 返回 200，网关 `/api/dispatch/health` 可访问。
- 回滚方法：回退镜像不会删除数据库、账号或 Nacos 配置。
## 2026-10-21：新增构建部署流水线

- 影响机器：`chat-home-server`。
- 变更内容：新增 GitHub Actions 流水线，`main` 推送后校验、构建 GHCR 镜像并部署到 `/opt/chat-web-dispatch-service`；容器端口 `5080`，接入 `chat-web-infrastructure` 外部网络。
- 机器侧操作：首次部署前需在 Nacos 创建 `chat-web-dispatch-service.yaml`，并创建数据库 `chat-web-dispatch` 和专用账号。部署脚本会从 Finance 或 Gateway 的 `.env` 继承 Nacos 连接参数。
- 验证命令：`yarn format:check`、`yarn test`；部署后 `docker exec chat-web-dispatch-service` 访问 `http://127.0.0.1:5080/health` 返回 200。
- 回滚方法：首次部署失败时停止并删除容器 `chat-web-dispatch-service`；后续版本回退到上一完整 Git SHA 镜像。
