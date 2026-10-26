#!/bin/sh
set -eu

IMAGE=${1:?Usage: deploy.sh IMAGE [COMPOSE_FILE]}
SERVICE_VERSION=${SERVICE_VERSION:-${IMAGE##*:}}
COMPOSE_FILE=${2:-compose.yml}
SERVICE=dispatch-service
CONTAINER=chat-web-dispatch-service
HEALTH_TIMEOUT=${HEALTH_TIMEOUT:-180}
PULL_ATTEMPTS=${PULL_ATTEMPTS:-8}

test -f "$COMPOSE_FILE"
test -f .env

temporary_env=$(mktemp .env.XXXXXX)
if ! awk '
    /^OTEL_/ { next }
    /^NODE_OPTIONS=.*@opentelemetry\/auto-instrumentations-node\/register/ { next }
    { print }
' .env > "$temporary_env"; then
    rm -f "$temporary_env"
    exit 1
fi
chmod 600 "$temporary_env"
mv "$temporary_env" .env

old_image=$(docker inspect --format '{{.Config.Image}}' "$CONTAINER" 2>/dev/null || true)

compose() {
    IMAGE="$IMAGE" SERVICE_VERSION="$SERVICE_VERSION" docker compose -f "$COMPOSE_FILE" "$@"
}

rollback() {
    docker logs --tail 100 "$CONTAINER" 2>&1 || true
    if [ -n "$old_image" ] && [ "$old_image" != "$IMAGE" ]; then
        IMAGE="$old_image" SERVICE_VERSION="${old_image##*:}" docker compose -f "$COMPOSE_FILE" up -d --no-deps "$SERVICE"
    fi
}

attempt=1
until docker pull "$IMAGE"; do
    [ "$attempt" -lt "$PULL_ATTEMPTS" ] || exit 1
    sleep $((attempt * 5))
    attempt=$((attempt + 1))
done

# 部署前授权 SRM 发送记录表，并补齐 Nacos 的 SRM 库连接和网关路由。
script_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
export DISPATCH_MYSQL_PASSWORD_FILE="$script_dir/.dispatch-mysql-password"
sh "$script_dir/bootstrap-database.sh"
dispatch_password_file="$DISPATCH_MYSQL_PASSWORD_FILE"
DISPATCH_MYSQL_PASSWORD=$(tr -d '\r\n' < "$dispatch_password_file")
export DISPATCH_MYSQL_PASSWORD
export DISPATCH_MYSQL_USERNAME=${DISPATCH_MYSQL_USERNAME:-chat_web_dispatch_service}
export DISPATCH_MYSQL_DATABASE=${DISPATCH_MYSQL_DATABASE:-chat-web-srm}
docker run --rm --network host --env-file .env \
    -e DISPATCH_MYSQL_PASSWORD -e DISPATCH_MYSQL_USERNAME -e DISPATCH_MYSQL_DATABASE \
    -v "$script_dir/bootstrap-nacos-config.cjs:/app/bootstrap-nacos-config.cjs:ro" \
    -w /app node:22-alpine node bootstrap-nacos-config.cjs

if ! compose up -d --no-deps "$SERVICE"; then
    rollback
    exit 1
fi

elapsed=0
while [ "$elapsed" -lt "$HEALTH_TIMEOUT" ]; do
    state=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$CONTAINER" 2>/dev/null || true)
    case "$state" in
        healthy)
            if ! docker exec "$CONTAINER" node -e "require('http').get('http://127.0.0.1:5080/health', response => process.exit(response.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"; then
                echo "Dispatch health endpoint failed after the container became healthy." >&2
                rollback
                exit 1
            fi
            register_ip=$(sed -n 's/^NACOS_REGISTER_IP=//p' .env | tail -n 1 | tr -d '\r')
            if [ -n "$register_ip" ]; then
                if ! printf '%s' "$register_ip" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$'; then
                    echo "NACOS_REGISTER_IP must be a valid IPv4 address: $register_ip" >&2
                    rollback
                    exit 1
                fi
                if ! docker exec -e CHECK_IP="$register_ip" chat-web-gateway-service node -e 'fetch("http://" + process.env.CHECK_IP + ":5080/health").then(async response => { const body = await response.text(); console.log("Nacos register IP probe status=" + response.status + " body=" + body); if (response.status !== 200) process.exit(1); }).catch(error => { console.error(String(error)); process.exit(1); })'; then
                    echo "NACOS_REGISTER_IP=${register_ip}:5080 is not reachable from Gateway. Docker port publishing to the WireGuard address may not work on Windows. Unset NACOS_REGISTER_IP so the service registers the container network IP." >&2
                    rollback
                    exit 1
                fi
            fi
            echo "Deployment succeeded: $IMAGE"
            exit 0
            ;;
        exited|dead|unhealthy)
            rollback
            exit 1
            ;;
    esac
    sleep 3
    elapsed=$((elapsed + 3))
done

rollback
exit 1
