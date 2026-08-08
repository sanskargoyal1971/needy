#!/bin/bash

# Exit on any error
set -e

echo "Starting deployment to EC2..."

# 1. Check AWS CLI configuration
if ! aws sts get-caller-identity > /dev/null 2>&1; then
    echo "ERROR: AWS CLI is not configured or credentials are invalid."
    echo "Please run 'aws configure' first."
    exit 1
fi

# Configuration
REGION="ap-south-2" # Hyderabad region
INSTANCE_TYPE="t3.micro"
KEY_NAME="needy-deploy-key"
SECURITY_GROUP_NAME="needy-sg"

# 2. Create Key Pair if it doesn't exist
if ! aws ec2 describe-key-pairs --key-names $KEY_NAME --region $REGION > /dev/null 2>&1; then
    echo "Creating new key pair: $KEY_NAME"
    aws ec2 create-key-pair --key-name $KEY_NAME --region $REGION --query 'KeyMaterial' --output text > ${KEY_NAME}.pem
    chmod 400 ${KEY_NAME}.pem
else
    echo "Key pair $KEY_NAME already exists in AWS."
fi

# 3. Create Security Group if it doesn't exist
SG_ID=$(aws ec2 describe-security-groups --group-names $SECURITY_GROUP_NAME --region $REGION --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || echo "")

if [ -z "$SG_ID" ]; then
    echo "Creating security group: $SECURITY_GROUP_NAME"
    VPC_ID=$(aws ec2 describe-vpcs --region $REGION --query 'Vpcs[?IsDefault==`true`].VpcId' --output text)
    
    if [ -z "$VPC_ID" ] || [ "$VPC_ID" == "None" ]; then
        echo "No default VPC found, falling back to first available VPC..."
        VPC_ID=$(aws ec2 describe-vpcs --region $REGION --query 'Vpcs[0].VpcId' --output text)
    fi
    
    if [ -z "$VPC_ID" ] || [ "$VPC_ID" == "None" ]; then
        echo "ERROR: No VPCs found in region $REGION. Cannot create Security Group."
        exit 1
    fi
    
    SG_ID=$(aws ec2 create-security-group --group-name $SECURITY_GROUP_NAME --description "Needy SG" --vpc-id $VPC_ID --region $REGION --query 'GroupId' --output text)
    
    # Allow SSH, HTTP, Next.js (3000), Backend (8080)
    aws ec2 authorize-security-group-ingress --group-id $SG_ID --region $REGION --protocol tcp --port 22 --cidr 0.0.0.0/0
    aws ec2 authorize-security-group-ingress --group-id $SG_ID --region $REGION --protocol tcp --port 80 --cidr 0.0.0.0/0
    aws ec2 authorize-security-group-ingress --group-id $SG_ID --region $REGION --protocol tcp --port 3000 --cidr 0.0.0.0/0
    aws ec2 authorize-security-group-ingress --group-id $SG_ID --region $REGION --protocol tcp --port 8080 --cidr 0.0.0.0/0
else
    echo "Security group $SECURITY_GROUP_NAME already exists ($SG_ID)."
fi

# 4. Get latest Amazon Linux 2023 AMI
AMI_ID=$(aws ssm get-parameters --names /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-6.1-x86_64 --region $REGION --query 'Parameters[0].Value' --output text)

# 5. Launch EC2 Instance with User Data (Swap file + Docker)
echo "Launching EC2 instance ($INSTANCE_TYPE)..."
INSTANCE_ID=$(aws ec2 run-instances \
    --image-id $AMI_ID \
    --instance-type $INSTANCE_TYPE \
    --key-name $KEY_NAME \
    --security-group-ids $SG_ID \
    --region $REGION \
    --user-data "#!/bin/bash
# Add 2GB Swap to prevent OOM on 1GB RAM instances
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile swap swap defaults 0 0' >> /etc/fstab

# Install Docker
dnf update -y
dnf install -y docker
systemctl enable docker
systemctl start docker
usermod -a -G docker ec2-user

# Install Docker Compose
curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64" -o /usr/local/bin/docker-compose
chmod +x /usr/local/bin/docker-compose" \
    --query 'Instances[0].InstanceId' \
    --output text)

echo "Waiting for instance $INSTANCE_ID to be running..."
aws ec2 wait instance-running --instance-ids $INSTANCE_ID --region $REGION

PUBLIC_IP=$(aws ec2 describe-instances --instance-ids $INSTANCE_ID --region $REGION --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
echo "Instance is running! Public IP: $PUBLIC_IP"
echo "Please wait ~2 minutes for the instance to finish installing Docker..."
sleep 120

# 6. Deploy Code
echo "Syncing local code to EC2 (this may take a minute)..."
rsync -avz --exclude 'node_modules' --exclude '.git' --exclude '.next' -e "ssh -o StrictHostKeyChecking=no -i ${KEY_NAME}.pem" ./ ec2-user@$PUBLIC_IP:~/needy-app

# 7. Build and Run
echo "Building and starting containers on EC2..."
ssh -o StrictHostKeyChecking=no -i ${KEY_NAME}.pem ec2-user@$PUBLIC_IP "cd ~/needy-app && sudo /usr/local/bin/docker-compose -f docker-compose.prod.yml up --build -d"

echo "==============================================="
echo "Deployment Complete!"
echo "Landing Page: http://$PUBLIC_IP:3000"
echo "Frontend Dashboard: http://$PUBLIC_IP"
echo "Backend API: http://$PUBLIC_IP:8080"
echo "==============================================="
