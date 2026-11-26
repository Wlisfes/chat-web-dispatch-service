# chat-web-dispatch-service

短信发送调度服务。消费通道队列 `chat.sms.channel.*`，选择端口并校验供应商预付余额，通过 TCP 交给 Observe 发送，同时把发送记录写入 SRM 库。不提供业务 HTTP 接口，只有健康检查。设备回执写回和供应商计费由 Hooks 处理。

- 端口：`5080`
- Redis database：`5`
- 钱包 Redis：Nacos `walletRedis`，读取 Finance Redis index `3` 的供应商余额
- Nacos Data ID：`chat-web-dispatch-service.yaml`（本地开发为 `chat-web-dispatch-service-development.yaml`）
- 数据库配置键：`database.chat-web-srm`，读写发送记录，只读通道、端口、设备、供应商和报价
- RabbitMQ 虚拟主机：`/chat-sms`

本地启动前复制 `.env.example` 为 `.env` 并填写 Nacos 连接信息，然后执行 `yarn dev`。

生产部署由 main 分支流水线构建镜像并部署到 chat-home-server。服务不建独立业务库，也不对外暴露 `/api/dispatch` 或 `/feign/dispatch`。详见 deploy/RUNBOOK.md。
