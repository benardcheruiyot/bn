#!/usr/bin/env bash
set -euo pipefail

# One-command fresh-server recovery and deployment.
#
# Usage:
#   ./deploy_and_restart.sh --host root@server-ip --domain app.example.com --email admin@app.example.com
#
# Optional:
#   --repo https://github.com/<owner>/<repo>.git
#   --branch main
#   --project-dir /var/www/<app-slug>
#   --pm2-app-name <app-slug>-backend
#   --backend-port 5002
#   --app-slug loan-clone
#   --skip-env-sync

HOST=""
DOMAIN=""
EMAIL=""
REPO_URL=""
BRANCH="main"
PROJECT_DIR=""
PM2_APP_NAME=""
BACKEND_PORT=""
APP_SLUG=""
ENV_SYNC_DIR=""
SYNC_ENV="1"

while [[ $# -gt 0 ]]; do
	case "$1" in
		--host)
			HOST="$2"
			shift 2
			;;
		--domain)
			DOMAIN="$2"
			shift 2
			;;
		--email)
			EMAIL="$2"
			shift 2
			;;
		--repo)
			REPO_URL="$2"
			shift 2
			;;
		--branch)
			BRANCH="$2"
			shift 2
			;;
		--project-dir)
			PROJECT_DIR="$2"
			shift 2
			;;
		--pm2-app-name)
			PM2_APP_NAME="$2"
			shift 2
			;;
		--backend-port)
			BACKEND_PORT="$2"
			shift 2
			;;
		--app-slug)
			APP_SLUG="$2"
			shift 2
			;;
		--env-sync-dir)
			ENV_SYNC_DIR="$2"
			shift 2
			;;
		--skip-env-sync)
			SYNC_ENV="0"
			shift
			;;
		-h|--help)
			sed -n '1,60p' "$0"
			exit 0
			;;
		*)
			echo "Unknown argument: $1"
			exit 1
			;;
	esac
done

if [[ -z "$HOST" || -z "$DOMAIN" || -z "$EMAIL" ]]; then
	echo "Missing required args. Use --host, --domain, --email."
	exit 1
fi

if [[ -z "$APP_SLUG" ]]; then
	APP_SLUG="$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')"
fi

if [[ -z "$APP_SLUG" ]]; then
	echo "Could not derive app slug. Pass --app-slug explicitly."
	exit 1
fi

if [[ -z "$PROJECT_DIR" ]]; then
	PROJECT_DIR="/var/www/${APP_SLUG}"
fi

if [[ -z "$PM2_APP_NAME" ]]; then
	PM2_APP_NAME="${APP_SLUG}-backend"
fi

if [[ -z "$ENV_SYNC_DIR" ]]; then
	ENV_SYNC_DIR="/tmp/${APP_SLUG}-recovery-env"
fi

if [[ -n "$BACKEND_PORT" ]] && ! [[ "$BACKEND_PORT" =~ ^[0-9]+$ ]]; then
	echo "Invalid --backend-port: $BACKEND_PORT"
	exit 1
fi

if [[ -z "$REPO_URL" ]]; then
	REPO_URL="$(git config --get remote.origin.url || true)"
fi

if [[ -z "$REPO_URL" ]]; then
	echo "Could not detect repository URL. Pass --repo explicitly."
	exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_BACKEND_ENV="${SCRIPT_DIR}/backend/.env"
LOCAL_FRONTEND_ENV="${SCRIPT_DIR}/frontend/.env"

SSH_BASE_OPTS=(-o StrictHostKeyChecking=accept-new)
if [[ -n "${SSH_PASSWORD:-}" ]]; then
	if ! command -v sshpass >/dev/null 2>&1; then
		echo "SSH_PASSWORD is set but sshpass is not installed."
		exit 1
	fi
	SSH_CMD=(sshpass -p "$SSH_PASSWORD" ssh "${SSH_BASE_OPTS[@]}")
	SCP_CMD=(sshpass -p "$SSH_PASSWORD" scp "${SSH_BASE_OPTS[@]}")
else
	SSH_CMD=(ssh "${SSH_BASE_OPTS[@]}")
	SCP_CMD=(scp "${SSH_BASE_OPTS[@]}")
fi

echo "Starting remote recovery on ${HOST} for ${DOMAIN}"
echo "Deployment identity: app_slug=${APP_SLUG} pm2=${PM2_APP_NAME} project_dir=${PROJECT_DIR}"

if [[ "$SYNC_ENV" == "1" ]]; then
	echo "Syncing local env files to remote temporary location"
	"${SSH_CMD[@]}" "$HOST" "mkdir -p '$ENV_SYNC_DIR'"
	if [[ -f "$LOCAL_BACKEND_ENV" ]]; then
		"${SCP_CMD[@]}" "$LOCAL_BACKEND_ENV" "$HOST:$ENV_SYNC_DIR/backend.env"
	else
		echo "Local backend/.env not found. Remote will fallback to .env.example"
	fi
	if [[ -f "$LOCAL_FRONTEND_ENV" ]]; then
		"${SCP_CMD[@]}" "$LOCAL_FRONTEND_ENV" "$HOST:$ENV_SYNC_DIR/frontend.env"
	else
		echo "Local frontend/.env not found. Remote will fallback to .env.example"
	fi
fi

"${SSH_CMD[@]}" "$HOST" bash -s -- "$DOMAIN" "$EMAIL" "$REPO_URL" "$BRANCH" "$PROJECT_DIR" "$PM2_APP_NAME" "$BACKEND_PORT" "$ENV_SYNC_DIR" <<'REMOTE_SCRIPT'
set -euo pipefail

DOMAIN="$1"
EMAIL="$2"
REPO_URL="$3"
BRANCH="$4"
PROJECT_DIR="$5"
PM2_APP_NAME="$6"
BACKEND_PORT="${7:-}"
ENV_SYNC_DIR="$8"

WWW_DOMAIN="www.${DOMAIN}"
NGINX_CONF="/etc/nginx/sites-available/${DOMAIN}.conf"
LE_CERT_DIR="/etc/letsencrypt/live/${DOMAIN}"
LE_FULLCHAIN="${LE_CERT_DIR}/fullchain.pem"
LE_PRIVKEY="${LE_CERT_DIR}/privkey.pem"

upsert_env() {
	local key="$1"
	local value="$2"
	local file="$3"
	local escaped
	escaped="$(printf '%s' "$value" | sed 's/[&|]/\\&/g')"

	if grep -q "^${key}=" "$file"; then
		sed -i "s|^${key}=.*|${key}=${escaped}|" "$file"
	else
		echo "${key}=${value}" >> "$file"
	fi
}

apt_safe() {
	local tries=18
	local delay=10
	local i

	for i in $(seq 1 "$tries"); do
		if apt-get "$@"; then
			return 0
		fi

		echo "apt-get $* failed (attempt ${i}/${tries}); waiting for package manager lock"
		sleep "$delay"
	done

	echo "apt-get $* failed after ${tries} attempts"
	return 1
}

certbot_safe() {
	local tries=18
	local delay=10
	local i

	for i in $(seq 1 "$tries"); do
		if certbot "$@"; then
			return 0
		fi

		echo "certbot $* failed (attempt ${i}/${tries}); waiting for certbot lock or concurrent renewal"
		sleep "$delay"
	done

	echo "certbot $* failed after ${tries} attempts"
	return 1
}

is_port_in_use() {
	local port="$1"
	ss -ltn | awk '{print $4}' | grep -Eq "(^|:)${port}$"
}

pick_free_port() {
	local start="${1:-5000}"
	local end="${2:-5199}"
	local p

	for p in $(seq "$start" "$end"); do
		if ! is_port_in_use "$p"; then
			echo "$p"
			return 0
		fi
	done

	return 1
}

if [[ -z "$BACKEND_PORT" ]]; then
	BACKEND_PORT="$(pick_free_port 5000 5199 || true)"
	if [[ -z "$BACKEND_PORT" ]]; then
		echo "Could not find an open backend port in 5000-5199. Pass --backend-port explicitly."
		exit 1
	fi
	echo "Auto-selected backend port: $BACKEND_PORT"
fi

echo "[1/8] Installing system dependencies"
export DEBIAN_FRONTEND=noninteractive
apt_safe update
apt_safe install -y ca-certificates curl git nginx certbot python3-certbot-nginx

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
	echo "Installing Node.js and npm"
	apt_safe install -y nodejs npm || true

	if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
		echo "Falling back to NodeSource Node.js 20 setup"
		curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
		apt_safe install -y nodejs npm
	fi
fi

if ! command -v pm2 >/dev/null 2>&1; then
	npm install -g pm2
fi

echo "[2/8] Cloning or updating project"
mkdir -p "$(dirname "$PROJECT_DIR")"
if [[ ! -d "$PROJECT_DIR/.git" ]]; then
	git clone "$REPO_URL" "$PROJECT_DIR"
fi

cd "$PROJECT_DIR"
git fetch --all --prune
git checkout "$BRANCH"
# Force the working tree to match remote branch state to avoid pull conflicts
# from local runtime files (e.g. tracked .env changes on server).
git reset --hard "origin/$BRANCH"

echo "[3/8] Preparing environment files"
if [[ -f "$ENV_SYNC_DIR/backend.env" ]]; then
	cp "$ENV_SYNC_DIR/backend.env" backend/.env
	chmod 600 backend/.env
	echo "Applied backend/.env from local machine"
elif [[ ! -f backend/.env ]]; then
	cp backend/.env.example backend/.env
	echo "Created backend/.env from template"
fi

if [[ -f "$ENV_SYNC_DIR/frontend.env" ]]; then
	cp "$ENV_SYNC_DIR/frontend.env" frontend/.env
	chmod 600 frontend/.env
	echo "Applied frontend/.env from local machine"
elif [[ ! -f frontend/.env ]]; then
	cp frontend/.env.example frontend/.env
fi

upsert_env "NODE_ENV" "production" "backend/.env"
upsert_env "PORT" "$BACKEND_PORT" "backend/.env"
upsert_env "ALLOWED_ORIGINS" "https://${DOMAIN},https://www.${DOMAIN}" "backend/.env"
upsert_env "ALLOWED_BASE_DOMAIN" "${DOMAIN}" "backend/.env"
upsert_env "APP_PUBLIC_URL" "https://${DOMAIN}" "backend/.env"
upsert_env "MPESA_CALLBACK_URL" "https://${DOMAIN}/api/mpesa/callback" "backend/.env"

upsert_env "REACT_APP_API_URL" "https://${DOMAIN}/api" "frontend/.env"

echo "[4/8] Installing backend dependencies"
cd "$PROJECT_DIR/backend"
npm ci

echo "[5/8] Installing and building frontend"
cd "$PROJECT_DIR/frontend"
npm ci
npm run build

echo "[6/8] Starting backend with PM2"
cd "$PROJECT_DIR/backend"
if pm2 describe "$PM2_APP_NAME" >/dev/null 2>&1; then
	pm2 restart "$PM2_APP_NAME" --update-env
else
	pm2 start npm --name "$PM2_APP_NAME" -- start
fi
pm2 save
pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true

echo "[7/8] Configuring Nginx"
if [[ -f "$LE_FULLCHAIN" && -f "$LE_PRIVKEY" ]]; then
cat > "$NGINX_CONF" <<NGINX
server {
	listen 80;
	server_name ${DOMAIN} ${WWW_DOMAIN};
	return 301 https://\$host\$request_uri;
}

server {
	listen 443 ssl http2;
	server_name ${DOMAIN} ${WWW_DOMAIN};

	root ${PROJECT_DIR}/frontend/build;
	index index.html;

	ssl_certificate ${LE_FULLCHAIN};
	ssl_certificate_key ${LE_PRIVKEY};
	include /etc/letsencrypt/options-ssl-nginx.conf;
	ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

	location /api/ {
		proxy_pass http://127.0.0.1:${BACKEND_PORT}/api/;
		proxy_http_version 1.1;
		proxy_set_header Host \$host;
		proxy_set_header X-Real-IP \$remote_addr;
		proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
		proxy_set_header X-Forwarded-Proto \$scheme;
	}

	location / {
		try_files \$uri /index.html;
	}
}
NGINX
else
cat > "$NGINX_CONF" <<NGINX
server {
	listen 80;
	server_name ${DOMAIN} ${WWW_DOMAIN};

	root ${PROJECT_DIR}/frontend/build;
	index index.html;

	location /api/ {
		proxy_pass http://127.0.0.1:${BACKEND_PORT}/api/;
		proxy_http_version 1.1;
		proxy_set_header Host \$host;
		proxy_set_header X-Real-IP \$remote_addr;
		proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
		proxy_set_header X-Forwarded-Proto \$scheme;
	}

	location / {
		try_files \$uri /index.html;
	}
}
NGINX
fi

ln -sf "$NGINX_CONF" "/etc/nginx/sites-enabled/${DOMAIN}.conf"
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable nginx
systemctl restart nginx

echo "[8/8] Issuing SSL certificate"
# Always run certbot with --nginx so TLS server blocks are restored after the
# temporary HTTP-only nginx config written in step [7/8].
certbot_safe --nginx -d "$DOMAIN" -d "$WWW_DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect || \
certbot_safe --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect

echo
echo "Recovery complete."
echo "Health check: https://${DOMAIN}/api/health"
echo "Removing temporary env sync files"
rm -rf "$ENV_SYNC_DIR"
REMOTE_SCRIPT

echo "Done."
