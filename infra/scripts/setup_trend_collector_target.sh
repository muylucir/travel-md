#!/usr/bin/env bash
# setup_trend_collector_target.sh -- Add trend-collector target to existing Gateway.
#
# Usage:
#   GATEWAY_ID=xxx ./infra/scripts/setup_trend_collector_target.sh
#
# Prerequisites:
#   - Gateway already created (setup_gateway.sh)
#   - ota-trend-collector Lambda deployed (deploy_trend_collector.sh)

set -euo pipefail

GATEWAY_ID="${GATEWAY_ID:?Set GATEWAY_ID environment variable}"
TARGET_NAME="trend-collector"
REGION="ap-northeast-2"
LAMBDA_FUNCTION_NAME="ota-trend-collector"

# Get Lambda ARN
LAMBDA_ARN=$(aws lambda get-function \
    --function-name "$LAMBDA_FUNCTION_NAME" --region "$REGION" \
    --query 'Configuration.FunctionArn' --output text)
echo "Lambda ARN: $LAMBDA_ARN"

echo "==> Creating trend-collector target with 4 tool schemas..."

cat > /tmp/trend-collector-target-config.json << TARGETEOF
{
  "gatewayIdentifier": "${GATEWAY_ID}",
  "name": "${TARGET_NAME}",
  "description": "Trend collection tools (YouTube, Naver, Google Trends, News)",
  "targetConfiguration": {
    "mcp": {
      "lambda": {
        "lambdaArn": "${LAMBDA_ARN}",
        "toolSchema": {
          "inlinePayload": [
  {"name":"youtube_search","description":"Search YouTube for travel videos in a region. Returns video titles, channels, view counts.","inputSchema":{"type":"object","properties":{"region":{"type":"string","description":"Region name."},"query":{"type":"string","description":"Search query override."},"max_results":{"type":"integer","description":"Max results (1-50)."}},"required":["region"]}},
  {"name":"naver_search","description":"Search Naver Blog and Cafe for travel content. Returns blog posts and cafe articles.","inputSchema":{"type":"object","properties":{"region":{"type":"string","description":"Region name."},"query":{"type":"string","description":"Search query override."},"max_results":{"type":"integer","description":"Max results per source."}},"required":["region"]}},
  {"name":"google_trends","description":"Fetch Google Trends data for travel keywords. Returns interest over time and related queries.","inputSchema":{"type":"object","properties":{"region":{"type":"string","description":"Region name."},"keywords":{"type":"array","items":{"type":"string"},"description":"Keywords to check (max 5)."}},"required":["region"]}},
  {"name":"news_crawl","description":"Crawl news articles about a travel region from Naver News and Google News RSS.","inputSchema":{"type":"object","properties":{"region":{"type":"string","description":"Region name."},"query":{"type":"string","description":"Search query override."},"max_results":{"type":"integer","description":"Max results per source."}},"required":["region"]}}
]
        }
      }
    }
  },
  "credentialProviderConfigurations": [{"credentialProviderType": "GATEWAY_IAM_ROLE"}]
}
TARGETEOF

aws bedrock-agentcore-control create-gateway-target \
    --region "$REGION" \
    --cli-input-json file:///tmp/trend-collector-target-config.json \
    --output json --no-cli-pager

echo ""
echo "==> Trend collector target created successfully!"
echo "Target name: ${TARGET_NAME}"
