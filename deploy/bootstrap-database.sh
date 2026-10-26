#!/bin/sh
set -eu

# Dispatch 只写 SRM 设备短信记录表，并读取发送所需快照，不建库。账号已存在时只补齐授权，不改密码。
USERNAME=${DISPATCH_MYSQL_USERNAME:-chat_web_dispatch_service}
MYSQL_CONTAINER=${DISPATCH_MYSQL_CONTAINER:-chat-web-mysql}
PASSWORD_FILE=${DISPATCH_MYSQL_PASSWORD_FILE:-/opt/chat-web-dispatch-service/.dispatch-mysql-password}
LEGACY_DATABASE=${DISPATCH_LEGACY_MYSQL_DATABASE:-chat-web-dispatch}

docker inspect "$MYSQL_CONTAINER" >/dev/null

mysql_root() {
    if docker exec -i "$MYSQL_CONTAINER" mysql -uroot -e "SELECT 1" >/dev/null 2>&1; then
        docker exec -i "$MYSQL_CONTAINER" mysql -uroot "$@"
    else
        docker exec -i "$MYSQL_CONTAINER" sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" "$@"' sh "$@"
    fi
}

user_count=$(mysql_root -N -e "SELECT COUNT(*) FROM mysql.user WHERE user='$USERNAME' AND host='%'")
if [ "$user_count" = "0" ]; then
    if [ -s "$PASSWORD_FILE" ]; then
        password=$(tr -d '\r\n' < "$PASSWORD_FILE")
    else
        password=$(docker run --rm node:22-alpine node -e "process.stdout.write(require('node:crypto').randomBytes(24).toString('base64url'))")
        umask 077
        mkdir -p "$(dirname "$PASSWORD_FILE")"
        printf '%s\n' "$password" > "$PASSWORD_FILE"
        chmod 600 "$PASSWORD_FILE"
    fi
    mysql_root -e "CREATE USER '$USERNAME'@'%' IDENTIFIED BY '$password'"
fi

sql=$(cat <<SQL
REVOKE ALL PRIVILEGES ON \`$LEGACY_DATABASE\`.* FROM '$USERNAME'@'%';
GRANT SELECT, INSERT, UPDATE ON \`chat-web-srm\`.\`tb_srm_simbank_message\` TO '$USERNAME'@'%';
GRANT SELECT ON \`chat-web-srm\`.\`tb_srm_channel\` TO '$USERNAME'@'%';
GRANT SELECT ON \`chat-web-srm\`.\`tb_srm_channel_port\` TO '$USERNAME'@'%';
GRANT SELECT ON \`chat-web-srm\`.\`tb_srm_simbank_port\` TO '$USERNAME'@'%';
GRANT SELECT ON \`chat-web-srm\`.\`tb_srm_simbank\` TO '$USERNAME'@'%';
GRANT SELECT ON \`chat-web-srm\`.\`tb_srm_user\` TO '$USERNAME'@'%';
GRANT SELECT ON \`chat-web-srm\`.\`tb_srm_simbank_quote\` TO '$USERNAME'@'%';
FLUSH PRIVILEGES;
SQL
)
printf '%s\n' "$sql" | mysql_root

echo "Dispatch 已授权写入发送记录，并读取 SRM 发送快照"
