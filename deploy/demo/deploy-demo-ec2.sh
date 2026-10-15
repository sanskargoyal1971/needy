#!/bin/bash
#
# PRIVATE DEMO deploy: one EC2 host running the sandbox stack (deploy/demo/docker-compose.demo.yml),
# reachable only from the address this script is run from.
#
#   ./deploy/demo/deploy-demo-ec2.sh            # from the repo root
#
# Not production. Sign-in uses one shared code and KYC is the sandbox adapter, which is safe only
# because of the two locks: the security group (only ALLOW_CIDR on 80/443/22, after the
# certificate is issued) and Caddy's remote_ip allowlist.
#
# HTTPS comes from a free <ip>.sslip.io name, so cookies (Secure, SameSite=Strict) work without
# owning a domain. Let's Encrypt has to reach ports 80/443 once to issue the certificate, so
# those are opened to the world for issuance only and then narrowed to ALLOW_CIDR. A renewal
# (~60 days on) would need them reopened briefly; a demo should not live that long.
#
# Secrets are generated here, streamed to a root-only file on the host over SSH, and never
# printed. The ones a person needs (sign-in code, super admin password) are written to
# .env.demo-credentials in the repo root — git-ignored, mode 600.
#
# Tear down:  ./deploy/demo/deploy-demo-ec2.sh destroy

set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
INSTANCE_TYPE="${INSTANCE_TYPE:-t3.small}"
NAME="needy-demo"
KEY_NAME="needy-demo-key"
KEY_FILE="${KEY_NAME}.pem"
SG_NAME="needy-demo-sg"
COMPOSE_VERSION="v2.29.7"
BUILDX_VERSION="v0.17.1"
CREDS_FILE=".env.demo-credentials"
TAGS="Key=Project,Value=${NAME}"

sg_id() {
  aws ec2 describe-security-groups --region "$REGION" --filters "Name=group-name,Values=$SG_NAME" \
    --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null
}

if [ "${1:-}" = "destroy" ]; then
  IDS=$(aws ec2 describe-instances --region "$REGION" \
    --filters "Name=tag:Project,Values=$NAME" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
    --query 'Reservations[].Instances[].InstanceId' --output text)
  if [ -n "$IDS" ]; then
    aws ec2 terminate-instances --region "$REGION" --instance-ids $IDS >/dev/null
    aws ec2 wait instance-terminated --region "$REGION" --instance-ids $IDS
  fi
  SG=$(sg_id); [ "$SG" != "None" ] && [ -n "$SG" ] && aws ec2 delete-security-group --region "$REGION" --group-id "$SG"
  aws ec2 delete-key-pair --region "$REGION" --key-name "$KEY_NAME"
  rm -f "$KEY_FILE"
  echo "Demo removed."
  exit 0
fi

ALLOW_CIDR="${ALLOW_CIDR:-$(curl -fsS https://checkip.amazonaws.com)/32}"
echo "Only $ALLOW_CIDR will be let in."

# ── key pair ────────────────────────────────────────────────────────────────
if ! aws ec2 describe-key-pairs --region "$REGION" --key-names "$KEY_NAME" >/dev/null 2>&1; then
  (umask 077 && aws ec2 create-key-pair --region "$REGION" --key-name "$KEY_NAME" \
    --tag-specifications "ResourceType=key-pair,Tags=[{$TAGS}]" \
    --query 'KeyMaterial' --output text > "$KEY_FILE")
fi
[ -f "$KEY_FILE" ] || { echo "ERROR: $KEY_FILE missing; run '$0 destroy' and retry."; exit 1; }
chmod 400 "$KEY_FILE"

# ── security group: SSH from ALLOW_CIDR; 80/443 open only until the cert is issued ──
SG=$(sg_id)
if [ -z "$SG" ] || [ "$SG" = "None" ]; then
  VPC=$(aws ec2 describe-vpcs --region "$REGION" --filters Name=isDefault,Values=true \
    --query 'Vpcs[0].VpcId' --output text)
  SG=$(aws ec2 create-security-group --region "$REGION" --group-name "$SG_NAME" \
    --description "Needy private demo" --vpc-id "$VPC" \
    --tag-specifications "ResourceType=security-group,Tags=[{$TAGS}]" --query GroupId --output text)
  aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG" \
    --protocol tcp --port 22 --cidr "$ALLOW_CIDR" >/dev/null
fi
for p in 80 443; do
  aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG" \
    --protocol tcp --port $p --cidr 0.0.0.0/0 >/dev/null 2>&1 || true
done

# ── instance ────────────────────────────────────────────────────────────────
AMI=$(aws ssm get-parameters --region "$REGION" \
  --names /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-6.1-x86_64 \
  --query 'Parameters[0].Value' --output text)

USER_DATA=$(cat <<EOF
#!/bin/bash
set -e
fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile swap swap defaults 0 0' >> /etc/fstab
dnf install -y docker rsync
systemctl enable --now docker
usermod -a -G docker ec2-user
mkdir -p /usr/local/lib/docker/cli-plugins
curl -fsSL "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-x86_64" -o /usr/local/lib/docker/cli-plugins/docker-compose
curl -fsSL "https://github.com/docker/buildx/releases/download/${BUILDX_VERSION}/buildx-${BUILDX_VERSION}.linux-amd64" -o /usr/local/lib/docker/cli-plugins/docker-buildx
chmod +x /usr/local/lib/docker/cli-plugins/*
install -d -m 700 -o root -g root /etc/needy
touch /var/lib/cloud/needy-ready
EOF
)

IID=$(aws ec2 describe-instances --region "$REGION" \
  --filters "Name=tag:Project,Values=$NAME" "Name=instance-state-name,Values=pending,running" \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)
if [ -z "$IID" ] || [ "$IID" = "None" ]; then
  echo "Launching $INSTANCE_TYPE in $REGION..."
  IID=$(aws ec2 run-instances --region "$REGION" --image-id "$AMI" --instance-type "$INSTANCE_TYPE" \
    --key-name "$KEY_NAME" --security-group-ids "$SG" \
    --metadata-options "HttpTokens=required,HttpEndpoint=enabled,HttpPutResponseHopLimit=1" \
    --block-device-mappings '[{"DeviceName":"/dev/xvda","Ebs":{"VolumeSize":30,"VolumeType":"gp3","Encrypted":true,"DeleteOnTermination":true}}]' \
    --tag-specifications "ResourceType=instance,Tags=[{$TAGS},{Key=Name,Value=$NAME}]" \
      "ResourceType=volume,Tags=[{$TAGS}]" \
    --user-data "$USER_DATA" --query 'Instances[0].InstanceId' --output text)
fi
aws ec2 wait instance-running --region "$REGION" --instance-ids "$IID"
IP=$(aws ec2 describe-instances --region "$REGION" --instance-ids "$IID" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
DOMAIN="${IP//./-}.sslip.io"
echo "Instance $IID at $IP ($DOMAIN)"

SSH=(ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -i "$KEY_FILE" "ec2-user@$IP")
echo "Waiting for Docker to be installed..."
for _ in $(seq 1 60); do
  "${SSH[@]}" "test -f /var/lib/cloud/needy-ready" 2>/dev/null && break
  sleep 10
done
"${SSH[@]}" "test -f /var/lib/cloud/needy-ready" || { echo "ERROR: host never finished setup."; exit 1; }

# ── code ────────────────────────────────────────────────────────────────────
rsync -az --delete \
  --exclude node_modules --exclude .git --exclude .next --exclude dist --exclude coverage \
  --exclude '.env' --exclude '.env.*' --exclude '*.pem' --exclude '*.key' \
  --exclude private-uploads --exclude '*.log' --exclude .claude --exclude 1st.md \
  -e "ssh -o StrictHostKeyChecking=accept-new -i $KEY_FILE" ./ "ec2-user@$IP:needy-app/"

# ── secrets: generated once, kept on the host, never printed ────────────────
if ! "${SSH[@]}" "sudo test -f /etc/needy/demo.env"; then
  hex() { openssl rand -hex "$1"; }
  OTP=$(printf '%06d' $(( $(od -An -N4 -tu4 /dev/urandom) % 1000000 )))
  ADMIN_PW="$(openssl rand -base64 18 | tr '+/' '-_')"
  {
    echo "DOMAIN=$DOMAIN"
    echo "ALLOW_CIDR=$ALLOW_CIDR"
    echo "POSTGRES_PASSWORD=$(hex 24)"
    echo "NEEDY_APP_DB_PASSWORD=$(hex 24)"
    echo "REDIS_PASSWORD=$(hex 24)"
    echo "JWT_SECRET=$(hex 32)"
    echo "KYC_CALLBACK_SECRET=$(hex 32)"
    echo "TOTP_ENCRYPTION_KEY=$(hex 32)"
    echo "PII_ENCRYPTION_KEY=$(hex 32)"
    echo "PII_INDEX_KEY=$(hex 32)"
    echo "DEV_FIXED_OTP=$OTP"
  } | "${SSH[@]}" "sudo sh -c 'umask 077; cat > /etc/needy/demo.env'"
  (umask 077 && {
    echo "# Needy PRIVATE DEMO — https://$DOMAIN  (only $ALLOW_CIDR can reach it)"
    echo "# Git-ignored. Destroy with: ./deploy/demo/deploy-demo-ec2.sh destroy"
    echo "SIGN_IN_CODE=$OTP            # one-time code for ANY phone number (sandbox)"
    echo "SUPER_ADMIN_USERNAME=needy_admin"
    echo "SUPER_ADMIN_PASSWORD=$ADMIN_PW"
  } > "$CREDS_FILE")
fi
# Re-read on every run so a retried deploy still seeds (the seed script is idempotent).
NEW_ADMIN_PW=$(sed -n 's/^SUPER_ADMIN_PASSWORD=//p' "$CREDS_FILE" 2>/dev/null || true)

# ── build and start ─────────────────────────────────────────────────────────
echo "Building images on the host (several minutes on $INSTANCE_TYPE)..."
# --project-directory: build contexts and bind mounts resolve from the repo root, not deploy/demo.
COMPOSE="cd needy-app && sudo docker compose --project-directory . --env-file /etc/needy/demo.env -f deploy/demo/docker-compose.demo.yml -p needy-demo"
"${SSH[@]}" "$COMPOSE up --build -d"

# ── seed the super admin (first deploy only) ────────────────────────────────
if [ -n "${NEW_ADMIN_PW:-}" ]; then
  for _ in $(seq 1 30); do
    "${SSH[@]}" "$COMPOSE exec -T backend node -e \"fetch('http://127.0.0.1:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\"" 2>/dev/null && break
    sleep 5
  done
  # `cp` writes as root whatever the container's USER, so this lands beside packages/ where the
  # script's relative imports of the compiled backend resolve.
  "${SSH[@]}" "$COMPOSE cp scripts backend:/repo/scripts" >/dev/null
  # The password travels on stdin, not argv, so it is not in the host's process list.
  printf '%s' "$NEW_ADMIN_PW" | "${SSH[@]}" "$COMPOSE exec -T -w /repo backend sh -c 'node scripts/dev-seed-super-admin.mjs needy_admin \"\$(cat)\"'"
fi

# ── wait for the certificate, then shut 80/443 to everyone else ─────────────
echo "Waiting for the HTTPS certificate..."
for _ in $(seq 1 40); do
  curl -fsS -o /dev/null "https://$DOMAIN/" 2>/dev/null && break
  sleep 6
done
for p in 80 443; do
  aws ec2 revoke-security-group-ingress --region "$REGION" --group-id "$SG" \
    --protocol tcp --port $p --cidr 0.0.0.0/0 >/dev/null 2>&1 || true
  aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG" \
    --protocol tcp --port $p --cidr "$ALLOW_CIDR" >/dev/null 2>&1 || true
done

echo "==============================================="
echo "App: https://$DOMAIN      (IP $IP)"
echo "Sign-in details: $CREDS_FILE"
echo "==============================================="
