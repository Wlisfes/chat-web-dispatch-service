# chat-web-dispatch-service

调度服务基础工程。当前只包含与其他 Nest 服务一致的启动、配置、健康检查和数据库连接骨架，业务模块后续再接入。

- 端口：`5080`
- Redis database：`5`
- Nacos Data ID：`chat-web-dispatch-service-development.yaml`
- 数据库配置键：`database.chat-web-dispatch`

本地启动前复制 `.env.example` 为 `.env` 并填写 Nacos 连接信息，然后执行 `yarn dev`。
