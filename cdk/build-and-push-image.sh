#!/bin/bash

# ==============================================
# Build and Push Docker Image to ECR
# ==============================================
# This script builds the Java scorer Docker image and pushes it to ECR
# Run this script before deploying the CDK stack

set -e

# Load environment variables from .env file if it exists
if [ -f .env ]; then
    echo "Loading environment variables from .env file..."
    export $(grep -v '^#' .env | xargs)
fi

# Check required environment variables
if [ -z "$ECR_REPOSITORY_NAME" ]; then
    echo "Error: ECR_REPOSITORY_NAME environment variable is not set"
    echo "Please set it in your .env file or export it"
    exit 1
fi

if [ -z "$AWS_REGION" ]; then
    echo "Error: AWS_REGION environment variable is not set"
    echo "Please set it in your .env file or export it"
    exit 1
fi

if [ -z "$AWS_ACCOUNT_ID" ]; then
    echo "Error: AWS_ACCOUNT_ID environment variable is not set"
    echo "Please set it in your .env file or export it"
    exit 1
fi

# Set default image tag if not provided
DOCKER_IMAGE_TAG=${DOCKER_IMAGE_TAG:-latest}

# Construct ECR repository URI
ECR_REPOSITORY_URI="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPOSITORY_NAME}"

echo "==============================================
Build and Push Configuration:
==============================================
ECR Repository Name: ${ECR_REPOSITORY_NAME}
Docker Image Tag: ${DOCKER_IMAGE_TAG}
AWS Region: ${AWS_REGION}
AWS Account ID: ${AWS_ACCOUNT_ID}
ECR Repository URI: ${ECR_REPOSITORY_URI}
=============================================="

# Step 1: Ensure ECR repository exists
echo ""
echo "Step 1: Checking if ECR repository exists..."
if aws ecr describe-repositories --repository-names "${ECR_REPOSITORY_NAME}" --region "${AWS_REGION}" > /dev/null 2>&1; then
    echo "✓ ECR repository '${ECR_REPOSITORY_NAME}' exists"
else
    echo "✗ ECR repository '${ECR_REPOSITORY_NAME}' does not exist"
    echo "Creating ECR repository..."
    aws ecr create-repository \
        --repository-name "${ECR_REPOSITORY_NAME}" \
        --region "${AWS_REGION}" \
        --image-scanning-configuration scanOnPush=true \
        --encryption-configuration encryptionType=AES256
    echo "✓ ECR repository created successfully"
fi

# Step 2: Authenticate Docker to ECR
echo ""
echo "Step 2: Authenticating Docker to ECR..."
aws ecr get-login-password --region "${AWS_REGION}" | \
    docker login --username AWS --password-stdin "${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
echo "✓ Docker authenticated to ECR"

# Step 3: Build Docker image
echo ""
echo "Step 3: Building Docker image..."
cd ../java-scorer
docker build --platform linux/amd64 -t "${ECR_REPOSITORY_NAME}:${DOCKER_IMAGE_TAG}" .
echo "✓ Docker image built successfully"

# Step 4: Tag Docker image for ECR
echo ""
echo "Step 4: Tagging Docker image for ECR..."
docker tag "${ECR_REPOSITORY_NAME}:${DOCKER_IMAGE_TAG}" "${ECR_REPOSITORY_URI}:${DOCKER_IMAGE_TAG}"
echo "✓ Docker image tagged: ${ECR_REPOSITORY_URI}:${DOCKER_IMAGE_TAG}"

# Step 5: Push Docker image to ECR
echo ""
echo "Step 5: Pushing Docker image to ECR..."
docker push "${ECR_REPOSITORY_URI}:${DOCKER_IMAGE_TAG}"
echo "✓ Docker image pushed successfully"

echo ""
echo "==============================================
✓ Build and Push Complete!
==============================================
Image URI: ${ECR_REPOSITORY_URI}:${DOCKER_IMAGE_TAG}

Next steps:
1. Ensure your .env file has:
   ECR_REPOSITORY_NAME=${ECR_REPOSITORY_NAME}
   DOCKER_IMAGE_TAG=${DOCKER_IMAGE_TAG}

2. Deploy the CDK stack:
   npm run cdk deploy
=============================================="
