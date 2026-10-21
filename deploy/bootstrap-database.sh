#!/bin/sh
set -eu

# 在部署主机的 MySQL 容器中幂等创建 Dispatch 独占库和账号。密码只写入受保护文件，不打印。
DATABASE=${DISPATCH_MYSQL_DATABASE:-chat-web-dispatch}
USERNAME=${DISPATCH_MYSQL_USERNAME:-chat_web_dispatch_service}
MYSQL_CONTAINER=${DISPATCH_MYSQL_CONTAINER:-chat-web-mysql}
PASSWORD_FILE=${DISPATCH_MYSQL_PASSWORD_FILE:-/opt/chat-web-dispatch-service/.dispatch-mysql-password}

docker inspect "$MYSQL_CONTAINER" >/dev/null

if [ -s "$PASSWORD_FILE" ]; then
    password=$(tr -d '\r\n' < "$PASSWORD_FILE")
else
    password=$(docker run --rm node:22-alpine node -e "process.stdout.write(require('node:crypto').randomBytes(24).toString('base64url'))")
    umask 077
    mkdir -p "$(dirname "$PASSWORD_FILE")"
    printf '%s\n' "$password" > "$PASSWORD_FILE"
    chmod 600 "$PASSWORD_FILE"
fi

sql=$(cat <<SQL
CREATE DATABASE IF NOT EXISTS \`$DATABASE\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '$USERNAME'@'%' IDENTIFIED BY '$password';
ALTER USER '$USERNAME'@'%' IDENTIFIED BY '$password';
GRANT ALL PRIVILEGES ON \`$DATABASE\`.* TO '$USERNAME'@'%';
FLUSH PRIVILEGES;
SQL
)

if docker exec -i "$MYSQL_CONTAINER" mysql -uroot -e "SELECT 1" >/dev/null 2>&1; then
    printf '%s\n' "$sql" | docker exec -i "$MYSQL_CONTAINER" mysql -uroot
else
    printf '%s\n' "$sql" | docker exec -i "$MYSQL_CONTAINER" sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD"'
fi

echo "Dispatch 数据库已准备：$DATABASE"