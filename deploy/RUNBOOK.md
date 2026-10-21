# Dispatch 服务运行手册

## 运行基线

| 项目                   | 基线                                                           |
| ---------------------- | -------------------------------------------------------------- |
| 容器                   | `chat-web-dispatch-service`                                    |
| 端口                   | `5080`                                                         |
| Nacos Data ID / 服务名 | `chat-web-dispatch-service.yaml` / `chat-web-dispatch-service` |
| 数据库配置键           | `database.chat-web-dispatch`                                   |
| Redis                  | index `5`                                                      |
| Feign Gateway          | `http://chat-web-gateway-service:5000`                         |
| 部署目录               | `/opt/chat-web-dispatch-service`                               |

## 首次部署前准备

1. 在 Nacos 创建 `chat-web-dispatch-service.yaml`，至少包含 `database.chat-web-dispatch`、Redis 和 `gateway.feign` / `gateway.principal` 配置，结构参考 SRM。
2. 创建数据库 `chat-web-dispatch` 和只授权该库的专用账号。当前没有业务表，就绪检查只验证能连上数据库。
3. 部署主机已存在外部网络 `chat-web-infrastructure`，并且有 Finance 或 Gateway 的 `.env` 可供 `bootstrap-runtime.sh` 继承 Nacos 连接参数。

缺少以上任一项时，新容器健康检查会失败，部署脚本会自动回滚到旧镜像（首次部署没有旧镜像可回滚）。

## 流水线

推送 `main` 或手动触发 `workflow_dispatch` 后执行：

1. GitHub Hosted Runner 安装依赖、格式检查、构建并运行测试。
2. 构建一次 `ghcr.io/wlisfes/chat-web-dispatch-service:<Git SHA>` 镜像并推送 GHCR。
3. `chat-home-server` 自托管 Runner 拉取镜像，执行 `deploy/deploy.sh`，等待容器健康后再检查 `/health`。

## 日志排障

```bash
docker logs --tail 100 chat-web-dispatch-service
docker inspect chat-web-dispatch-service --format '{{json .HostConfig.LogConfig}}'
docker exec chat-web-dispatch-service node -e "require('http').get('http://127.0.0.1:5080/health', r => { let b=''; r.on('data', c => b += c); r.on('end', () => console.log(r.statusCode, b)) })"
```

## 回滚

重新运行上一次成功的流水线，或在部署目录执行 `./deploy.sh ghcr.io/wlisfes/chat-web-dispatch-service:<上一个 Git SHA> compose.yml`。
