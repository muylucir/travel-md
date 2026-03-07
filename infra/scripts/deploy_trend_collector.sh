#!/usr/bin/env bash
# deploy_trend_collector.sh -- Package and deploy the trend-collector Lambda.
#
# Usage:
#   ./infra/scripts/deploy_trend_collector.sh [create|update]
#
# Prerequisites:
#   - AWS CLI configured
#   - LAMBDA_ROLE_ARN set

set -euo pipefail

FUNCTION_NAME="ota-trend-collector"
REGION="ap-northeast-2"
RUNTIME="python3.11"
HANDLER="handler.handler"
MEMORY_SIZE=512
TIMEOUT=60
ROLE_ARN="${LAMBDA_ROLE_ARN:?Set LAMBDA_ROLE_ARN environment variable}"

# API keys (optional -- set via env or Lambda console)
YOUTUBE_API_KEY="${YOUTUBE_API_KEY:-}"
NAVER_CLIENT_ID="${NAVER_CLIENT_ID:-}"
NAVER_CLIENT_SECRET="${NAVER_CLIENT_SECRET:-}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LAMBDA_DIR="$PROJECT_ROOT/infra/trend-collector-lambda"
BUILD_DIR="/tmp/lambda-build-trend-$$"
ZIP_FILE="/tmp/${FUNCTION_NAME}.zip"

echo "==> Building Lambda package..."
rm -rf "$BUILD_DIR" "$ZIP_FILE"
mkdir -p "$BUILD_DIR"

# Install dependencies
pip install -r "$LAMBDA_DIR/requirements.txt" -t "$BUILD_DIR" --quiet

# Copy Lambda code
cp "$LAMBDA_DIR/handler.py" "$BUILD_DIR/"
cp -r "$LAMBDA_DIR/tools" "$BUILD_DIR/"

# Create zip
cd "$BUILD_DIR"
zip -r "$ZIP_FILE" . -x "__pycache__/*" "*.pyc" > /dev/null
cd "$PROJECT_ROOT"

ZIP_SIZE=$(du -h "$ZIP_FILE" | cut -f1)
echo "==> Package created: $ZIP_FILE ($ZIP_SIZE)"

ACTION="${1:-create}"

# No VPC needed -- external API calls only
# Build environment JSON to handle empty values safely
ENV_JSON=$(python3 -c "
import json
env = {
    'YOUTUBE_API_KEY': '${YOUTUBE_API_KEY}',
    'NAVER_CLIENT_ID': '${NAVER_CLIENT_ID}',
    'NAVER_CLIENT_SECRET': '${NAVER_CLIENT_SECRET}',
}
# Remove empty values
env = {k: v for k, v in env.items() if v}
if not env:
    env = {'PLACEHOLDER': 'none'}
print(json.dumps({'Variables': env}))
")

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
        --environment "$ENV_JSON" \
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
        --environment "$ENV_JSON" \
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
echo "    --payload '{\"name\":\"youtube_search\",\"region\":\"규슈\"}' \\"
echo "    /tmp/trend-collector-response.json && cat /tmp/trend-collector-response.json"
