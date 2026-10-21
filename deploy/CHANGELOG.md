# Dispatch 部署变更记录

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
