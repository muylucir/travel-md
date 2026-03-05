#!/usr/bin/env bash
# deploy_lambda.sh -- Package and deploy the travel-tools Lambda function.
#
# Usage:
#   ./infra/scripts/deploy_lambda.sh [create|update]
#
# Prerequisites:
#   - AWS CLI configured with appropriate permissions
#   - Lambda execution role must exist (see ROLE_ARN below)

set -euo pipefail

FUNCTION_NAME="ota-travel-tools"
REGION="ap-northeast-2"
RUNTIME="python3.11"
HANDLER="handler.handler"
MEMORY_SIZE=512
TIMEOUT=30
ROLE_ARN="${LAMBDA_ROLE_ARN:?Set LAMBDA_ROLE_ARN environment variable}"

# VPC config
SUBNET_IDS="subnet-08509ad1a54a39060,subnet-04d7fd52f42271a13"
SECURITY_GROUP_IDS="sg-07885136908f7ce10"

# Environment variables
GREMLIN_ENDPOINT="${GREMLIN_ENDPOINT:-wss://REDACTED_NEPTUNE_HOST:8182/gremlin}"
DYNAMODB_TABLE_NAME="${DYNAMODB_TABLE_NAME:-ota-planned-products}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LAMBDA_DIR="$PROJECT_ROOT/infra/lambda"
BUILD_DIR="/tmp/lambda-build-$$"
ZIP_FILE="/tmp/${FUNCTION_NAME}.zip"

echo "==> Building Lambda package..."
rm -rf "$BUILD_DIR" "$ZIP_FILE"
mkdir -p "$BUILD_DIR"

# Install dependencies
pip install -r "$LAMBDA_DIR/requirements.txt" -t "$BUILD_DIR" --quiet

# Copy Lambda code
cp "$LAMBDA_DIR/handler.py" "$BUILD_DIR/"
cp "$LAMBDA_DIR/graph_client.py" "$BUILD_DIR/"
cp -r "$LAMBDA_DIR/tools" "$BUILD_DIR/"

# Create zip
cd "$BUILD_DIR"
zip -r "$ZIP_FILE" . -x "__pycache__/*" "*.pyc" > /dev/null
cd "$PROJECT_ROOT"

ZIP_SIZE=$(du -h "$ZIP_FILE" | cut -f1)
echo "==> Package created: $ZIP_FILE ($ZIP_SIZE)"

ACTION="${1:-create}"

# Note: AWS_REGION is a Lambda reserved variable (auto-set to deploy region)
ENV_VARS="Variables={GREMLIN_ENDPOINT=$GREMLIN_ENDPOINT,DYNAMODB_TABLE_NAME=$DYNAMODB_TABLE_NAME}"

if [ "$ACTION" = "create" ]; then
    echo "==> Creating Lambda function: $FUNCTION_NAME"
    aws lambda create-function \
        --function-name "$FUNCTION_NAME" \
        --runtime "$RUNTIME" \
        --handler "$HANDLER" \
        --role "$ROLE_ARN" \
        --zip-file "fileb://$ZIP_FILE" \
        --memory-size "$MEMORY_SIZE" \
        --timeout "$TIMEOUT" \
        --region "$REGION" \
        --vpc-config "SubnetIds=$SUBNET_IDS,SecurityGroupIds=$SECURITY_GROUP_IDS" \
        --environment "$ENV_VARS" \
        --no-cli-pager
elif [ "$ACTION" = "update" ]; then
    echo "==> Updating Lambda function code: $FUNCTION_NAME"
    aws lambda update-function-code \
        --function-name "$FUNCTION_NAME" \
        --zip-file "fileb://$ZIP_FILE" \
        --region "$REGION" \
        --no-cli-pager

    echo "==> Waiting for update to complete..."
    aws lambda wait function-updated \
        --function-name "$FUNCTION_NAME" \
        --region "$REGION"

    echo "==> Updating Lambda configuration: $FUNCTION_NAME"
    aws lambda update-function-configuration \
        --function-name "$FUNCTION_NAME" \
        --memory-size "$MEMORY_SIZE" \
        --timeout "$TIMEOUT" \
        --environment "$ENV_VARS" \
        --vpc-config "SubnetIds=$SUBNET_IDS,SecurityGroupIds=$SECURITY_GROUP_IDS" \
        --region "$REGION" \
        --no-cli-pager
else
    echo "Usage: $0 [create|update]"
    exit 1
fi

# Cleanup
rm -rf "$BUILD_DIR"

echo "==> Done. Lambda function '$FUNCTION_NAME' deployed."
echo ""
echo "Test with:"
echo "  aws lambda invoke --function-name $FUNCTION_NAME --region $REGION \\"
echo "    --payload '{\"name\":\"get_routes_by_region\",\"arguments\":{\"region\":\"규슈\"}}' \\"
echo "    /tmp/lambda-response.json && cat /tmp/lambda-response.json"
