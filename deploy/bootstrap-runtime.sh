#!/bin/sh
set -eu

# Dispatch 运行时只需要启动参数和 Nacos 连接参数；数据库、Redis、Feign 配置全部由 Nacos 管理。
DEPLOY_PATH=${1:-/opt/chat-web-dispatch-service}
ENV_FILE="$DEPLOY_PATH/.env"

read_value() {
    key=$1
    file=$2
    [ -f "$file" ] || return 0
    sed -n "s/^${key}=//p" "$file" | tail -n 1
}

valid_value() {
    case "$1" in
        ''|replace-with-*) return 1 ;;
        *) return 0 ;;
    esac
}

find_infrastructure_env() {
    if [ -n "${DISPATCH_INFRA_ENV_SOURCE:-}" ] && [ -f "$DISPATCH_INFRA_ENV_SOURCE" ]; then
        printf '%s' "$DISPATCH_INFRA_ENV_SOURCE"
        return
    fi
    for candidate in /opt/chat-web-finance-service/.env /opt/chat-web-gateway-service/.env; do
        if [ -f "$candidate" ]; then
            printf '%s' "$candidate"
            return
        fi
    done
    return 1
}

resolve_value() {
    key=$1
    fallback=${2:-}
    current=$(read_value "$key" "$ENV_FILE")
    if valid_value "$current"; then
        printf '%s' "$current"
        return
    fi
    inherited=$(read_value "$key" "$INFRA_ENV_FILE")
    if valid_value "$inherited"; then
        printf '%s' "$inherited"
        return
    fi
    printf '%s' "$fallback"
}

mkdir -p "$DEPLOY_PATH"
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"
INFRA_ENV_FILE=$(find_infrastructure_env) || {
    echo '无法找到现有的 Chat Web 基础设施环境文件' >&2
    exit 1
}

namespace=$(resolve_value NACOS_NAMESPACE)
valid_value "$namespace" || {
    echo 'NACOS_NAMESPACE 缺失，请先在部署主机配置 Nacos 命名空间' >&2
    exit 1
}

temporary_env=$(mktemp "$DEPLOY_PATH/.env.XXXXXX")
{
    printf 'NODE_ENV=%s\n' "$(resolve_value NODE_ENV production)"
    printf 'PORT=%s\n' "$(resolve_value PORT 5080)"
    printf 'TZ=%s\n' "$(resolve_value TZ Asia/Shanghai)"
    printf 'BIND_ADDRESS=%s\n' "$(resolve_value BIND_ADDRESS 0.0.0.0)"
    printf 'HOST_PORT=%s\n' "$(resolve_value HOST_PORT 5080)"
    printf 'DOCKER_NETWORK=%s\n' "$(resolve_value DOCKER_NETWORK chat-web-infrastructure)"
    printf '\n'
    printf 'NACOS_SERVER=%s\n' "$(resolve_value NACOS_SERVER chat-web-nacos:8848)"
    printf 'NACOS_NAMESPACE=%s\n' "$namespace"
    printf 'NACOS_CONFIG_DATA_ID=%s\n' "$(resolve_value NACOS_CONFIG_DATA_ID chat-web-dispatch-service.yaml)"
    printf 'NACOS_USERNAME=%s\n' "$(resolve_value NACOS_USERNAME)"
    printf 'NACOS_PASSWORD=%s\n' "$(resolve_value NACOS_PASSWORD)"
    printf 'NACOS_REGISTER_ENABLED=true\n'
    register_ip=$(read_value NACOS_REGISTER_IP "$ENV_FILE")
    if ! valid_value "$register_ip"; then
        register_ip=${DEFAULT_NACOS_REGISTER_IP:-}
    fi
    if [ -n "$register_ip" ]; then
        printf 'NACOS_REGISTER_IP=%s\n' "$register_ip"
    fi
    printf 'NACOS_SERVICE_NAME=chat-web-dispatch-service\n'
    printf 'HOST_BIND_IP=%s\n' "$(resolve_value HOST_BIND_IP 0.0.0.0)"
} > "$temporary_env"
chmod 600 "$temporary_env"
mv "$temporary_env" "$ENV_FILE"

echo 'Dispatch 运行时启动参数已准备，数据库、Redis 和 Feign 配置由 Nacos 提供'
