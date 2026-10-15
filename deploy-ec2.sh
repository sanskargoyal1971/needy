#!/bin/bash
#
# Provision one EC2 host and bring the production stack up on it.
#
#   DOMAIN=needy.example.in ./deploy-ec2.sh
#
# Before running:
#   - `DOMAIN` and `api.DOMAIN` will need DNS A records pointing at the instance's public IP
#     (printed below). Caddy cannot obtain certificates until they resolve.
#   - The host must have /etc/needy/needy.env (root-owned, mode 600) holding the production
#     secrets, written from AWS Secrets Manager / SSM. This script never copies secrets from
#     this machine — see the note at step 7.
#
# This script does not transfer .env files, private keys or KYC uploads to the host.

set -euo pipefail

: "${DOMAIN:?set DOMAIN to the public hostname, e.g. DOMAIN=needy.example.in}"

echo "Starting deployment to EC2..."

# 1. Check AWS CLI configuration
if ! aws sts get-caller-identity > /dev/null 2>&1; then
    echo "ERROR: AWS CLI is not configured or credentials are invalid."
    echo "Please run 'aws configure' first."
    exit 1
fi

# Configuration
REGION="${AWS_REGION:-ap-south-2}" # Hyderabad region
INSTANCE_TYPE="${INSTANCE_TYPE:-t3.small}"
KEY_NAME="needy-deploy-key"
SECURITY_GROUP_NAME="needy-sg"
# Pinned, not `latest`: an unpinned download runs whatever was published most recently, as
# root, on the host that holds the database.
COMPOSE_VERSION="v2.29.7"
REMOTE_ENV_FILE="/etc/needy/needy.env"

# SSH is opened to the address this script is run from and nowhere else. Override with
# ADMIN_CIDR for a fixed office range or a bastion.
ADMIN_CIDR="${ADMIN_CIDR:-$(curl -fsS https://checkip.amazonaws.com)/32}"
echo "SSH will be allowed from: $ADMIN_CIDR"

# 2. Create Key Pair if it doesn't exist
if ! aws ec2 describe-key-pairs --key-names "$KEY_NAME" --region "$REGION" > /dev/null 2>&1; then
    echo "Creating new key pair: $KEY_NAME"
    (umask 077 && aws ec2 create-key-pair --key-name "$KEY_NAME" --region "$REGION" \
        --query 'KeyMaterial' --output text > "${KEY_NAME}.pem")
    chmod 400 "${KEY_NAME}.pem"
else
    echo "Key pair $KEY_NAME already exists in AWS."
fi
if [ ! -f "${KEY_NAME}.pem" ]; then
    echo "ERROR: ${KEY_NAME}.pem is not in this directory, so the host cannot be reached."
    exit 1
fi

# 3. Create Security Group if it doesn't exist
SG_ID=$(aws ec2 describe-security-groups --group-names "$SECURITY_GROUP_NAME" --region "$REGION" \
    --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || echo "")

if [ -z "$SG_ID" ] || [ "$SG_ID" == "None" ]; then
    echo "Creating security group: $SECURITY_GROUP_NAME"
    VPC_ID=$(aws ec2 describe-vpcs --region "$REGION" --query 'Vpcs[?IsDefault==`true`].VpcId' --output text)

    if [ -z "$VPC_ID" ] || [ "$VPC_ID" == "None" ]; then
        echo "No default VPC found, falling back to first available VPC..."
        VPC_ID=$(aws ec2 describe-vpcs --region "$REGION" --query 'Vpcs[0].VpcId' --output text)
    fi

    if [ -z "$VPC_ID" ] || [ "$VPC_ID" == "None" ]; then
        echo "ERROR: No VPCs found in region $REGION. Cannot create Security Group."
        exit 1
    fi

    SG_ID=$(aws ec2 create-security-group --group-name "$SECURITY_GROUP_NAME" --description "Needy SG" \
        --vpc-id "$VPC_ID" --region "$REGION" --query 'GroupId' --output text)

    # The public surface is HTTP (redirects to HTTPS, and the ACME challenge) and HTTPS.
    # The app and API ports are NOT opened: both sit behind Caddy on the compose network.
    aws ec2 authorize-security-group-ingress --group-id "$SG_ID" --region "$REGION" --protocol tcp --port 80 --cidr 0.0.0.0/0
    aws ec2 authorize-security-group-ingress --group-id "$SG_ID" --region "$REGION" --protocol tcp --port 443 --cidr 0.0.0.0/0
    aws ec2 authorize-security-group-ingress --group-id "$SG_ID" --region "$REGION" --protocol tcp --port 22 --cidr "$ADMIN_CIDR"
else
    echo "Security group $SECURITY_GROUP_NAME already exists ($SG_ID)."
    echo "NOTE: its rules were not changed. If it was created by an older version of this"
    echo "      script it still allows SSH, 3000 and 8080 from anywhere — remove those rules."
fi

# 4. Get latest Amazon Linux 2023 AMI
AMI_ID=$(aws ssm get-parameters --names /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-6.1-x86_64 \
    --region "$REGION" --query 'Parameters[0].Value' --output text)

# 5. Launch EC2 Instance with User Data (Swap file + Docker)
#    - IMDSv2 only, so a server-side request forgery cannot read instance credentials.
#    - Hop limit 2, not 1. The backend fetches its S3 credentials from IMDS from inside a
#      container, and Docker's bridge network is one extra hop: with a limit of 1 the IMDSv2
#      token response is dropped before it reaches the container and S3 signing fails. 2 is
#      the value AWS documents for containers; it is still not reachable off-host, and
#      HttpTokens=required still blocks the IMDSv1 GET an SSRF would use.
#    - But hop limit 2 opens IMDS to EVERY container on the host, not just the backend — and
#      the role reads and writes every KYC object. So the user data below installs a
#      DOCKER-USER firewall rule that drops container traffic to 169.254.169.254 unless it
#      comes from 172.30.0.10/31: the backend (.10) and the backup sidecar (.11), both pinned in
#      docker-compose.prod.yml. The sidecar needs the role to upload database backups.
#      Without it, code execution in the internet-facing web or Caddy container would be one
#      metadata request away from every government ID in the bucket.
#      Residual exposure, stated plainly: processes on the host itself still reach IMDS (they
#      run as root or ec2-user anyway); and a container that could forge its source address
#      could pass the rule. web, backend and Caddy drop every capability, so cannot; redis
#      and postgres keep Docker's defaults, NET_RAW among them. If the instance is ever given
#      IPv6 metadata (HttpProtocolIpv6=enabled), add the same rule for fd00:ec2::254.
#    - S3 credentials come from the instance role, so the instance needs an instance profile
#      whose role allows, on the KYC bucket only:
#          s3:PutObject, s3:GetObject, s3:DeleteObject, s3:AbortMultipartUpload
#        on  arn:aws:s3:::<S3_BUCKET>/kyc/*
#      Each is used: GetObject because a presigned document link acts as the role, so it is
#      what a reviewer's link is allowed to read; DeleteObject because a retaken selfie
#      replaces the old object and a rejected upload is removed. No ListBucket, no wildcard.
#      (plus kms:GenerateDataKey / kms:Decrypt on the bucket's key if it uses SSE-KMS).
#      And, for the backup sidecar, on the BACKUP bucket only:
#          s3:PutObject  on  arn:aws:s3:::<BACKUP_S3_BUCKET>/<BACKUP_S3_PREFIX>*
#        (plus kms:GenerateDataKey on its key). Write-only on purpose: a compromised host can
#        add backups but cannot read or delete the ones already there. See ops/README.md.
#      This script does not create or attach one. Create the role + profile once, then either
#      add `--iam-instance-profile Name=<profile>` to the run-instances call below or attach
#      it afterwards with `aws ec2 associate-iam-instance-profile`. Leave S3_ACCESS_KEY_ID /
#      S3_SECRET_ACCESS_KEY out of needy.env.
#    - Encrypted root volume: Postgres data (PII) lives on it.
echo "Launching EC2 instance ($INSTANCE_TYPE)..."
INSTANCE_ID=$(aws ec2 run-instances \
    --image-id "$AMI_ID" \
    --instance-type "$INSTANCE_TYPE" \
    --key-name "$KEY_NAME" \
    --security-group-ids "$SG_ID" \
    --region "$REGION" \
    --metadata-options "HttpTokens=required,HttpEndpoint=enabled,HttpPutResponseHopLimit=2" \
    --block-device-mappings '[{"DeviceName":"/dev/xvda","Ebs":{"VolumeSize":30,"VolumeType":"gp3","Encrypted":true,"DeleteOnTermination":true}}]' \
    --user-data "#!/bin/bash
# Add 2GB Swap to prevent OOM during image builds
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile swap swap defaults 0 0' >> /etc/fstab

# Install Docker
dnf update -y
dnf install -y docker iptables-nft
systemctl enable docker

# Only the backend and backup containers (172.30.0.10/31) may reach the instance metadata
# service (see the note on the hop limit in deploy-ec2.sh). A unit rather than a one-off command: iptables rules do not
# survive a reboot, and DOCKER-USER only exists once Docker has started, so it is re-applied
# after every Docker start. Inserted at the top of DOCKER-USER, which Docker evaluates before
# any rule of its own for forwarded container traffic.
cat > /etc/systemd/system/needy-imds-guard.service <<'UNIT'
[Unit]
Description=Allow only the Needy backend and backup containers to reach instance metadata
After=docker.service
Requires=docker.service
PartOf=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c 'iptables -C DOCKER-USER -d 169.254.169.254/32 ! -s 172.30.0.10/31 -j DROP 2>/dev/null || iptables -I DOCKER-USER 1 -d 169.254.169.254/32 ! -s 172.30.0.10/31 -j DROP'

[Install]
WantedBy=docker.service
UNIT
systemctl daemon-reload
systemctl enable needy-imds-guard.service
systemctl start docker
systemctl start needy-imds-guard.service
usermod -a -G docker ec2-user

# Install Docker Compose (pinned)
curl -fL \"https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-x86_64\" -o /usr/local/bin/docker-compose
chmod +x /usr/local/bin/docker-compose

# Where the production secrets file goes. Root only.
install -d -m 700 -o root -g root /etc/needy" \
    --query 'Instances[0].InstanceId' \
    --output text)

echo "Waiting for instance $INSTANCE_ID to be running..."
aws ec2 wait instance-running --instance-ids "$INSTANCE_ID" --region "$REGION"

PUBLIC_IP=$(aws ec2 describe-instances --instance-ids "$INSTANCE_ID" --region "$REGION" \
    --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
echo "Instance is running! Public IP: $PUBLIC_IP"
echo "Point DNS A records for $DOMAIN and api.$DOMAIN at $PUBLIC_IP now."
echo "Please wait ~2 minutes for the instance to finish installing Docker..."
sleep 120

# `accept-new` records the host key on first contact and refuses a changed one afterwards.
# `StrictHostKeyChecking=no` accepted any key every time, which is no check at all.
SSH_OPTS=(-o StrictHostKeyChecking=accept-new -i "${KEY_NAME}.pem")

# 6. Deploy Code
#    Secrets, keys and local data are excluded explicitly. The private key used for this very
#    connection used to be copied onto the server it unlocks.
echo "Syncing local code to EC2 (this may take a minute)..."
rsync -avz \
    --exclude 'node_modules' --exclude '.git' --exclude '.next' --exclude 'dist' \
    --exclude '.env' --exclude '.env.*' --exclude '*.pem' --exclude '*.key' \
    --exclude 'private-uploads' --exclude '*.log' --exclude '.claude' --exclude '1st.md' \
    -e "ssh ${SSH_OPTS[*]}" ./ "ec2-user@$PUBLIC_IP:~/needy-app"

# 7. Build and Run
#    The stack reads its secrets from a root-only file on the host. It is written there from
#    Secrets Manager / SSM by whoever operates the deployment — not by this script, and not
#    from a file on a laptop. docker-compose.prod.yml lists every variable it needs and
#    refuses to start without them.
if ! ssh "${SSH_OPTS[@]}" "ec2-user@$PUBLIC_IP" "sudo test -f $REMOTE_ENV_FILE"; then
    echo "==============================================="
    echo "Code is on the host, but the stack was NOT started:"
    echo "  $REMOTE_ENV_FILE does not exist on $PUBLIC_IP."
    echo "Create it (root-owned, mode 600) with the variables named in docker-compose.prod.yml,"
    echo "including DOMAIN=$DOMAIN, then run on the host:"
    echo "  cd ~/needy-app && sudo /usr/local/bin/docker-compose --env-file $REMOTE_ENV_FILE -f docker-compose.prod.yml up --build -d"
    echo "==============================================="
    exit 1
fi

echo "Building and starting containers on EC2..."
ssh "${SSH_OPTS[@]}" "ec2-user@$PUBLIC_IP" \
    "cd ~/needy-app && sudo /usr/local/bin/docker-compose --env-file $REMOTE_ENV_FILE -f docker-compose.prod.yml up --build -d"

echo "==============================================="
echo "Deployment Complete!"
echo "App: https://$DOMAIN"
echo "API: https://api.$DOMAIN"
echo "==============================================="
