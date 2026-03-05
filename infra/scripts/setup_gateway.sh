#!/usr/bin/env bash
# setup_gateway.sh -- Create AWS_IAM AgentCore Gateway and Lambda target.
#
# Usage:
#   ./infra/scripts/setup_gateway.sh
#
# Prerequisites:
#   - AWS CLI with bedrock-agentcore-control support
#   - Lambda function deployed (deploy_lambda.sh)
#   - GATEWAY_ROLE_ARN set (role for Gateway to invoke Lambda)

set -euo pipefail

GATEWAY_NAME="ota-travel-gateway"
TARGET_NAME="travel-tools"
REGION="ap-northeast-2"
LAMBDA_FUNCTION_NAME="ota-travel-tools"
GATEWAY_ROLE_ARN="${GATEWAY_ROLE_ARN:?Set GATEWAY_ROLE_ARN environment variable}"

echo "==> Step 1: Creating AWS_IAM MCP Gateway via raw API..."

# Use SigV4-signed HTTP request because AWS CLI may not support AWS_IAM authorizer type
GATEWAY_OUTPUT=$(python3 -c "
import json, urllib.request
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from botocore.session import Session

session = Session()
creds = session.get_credentials().get_frozen_credentials()
url = 'https://bedrock-agentcore-control.${REGION}.amazonaws.com/gateways'
body = json.dumps({
    'name': '${GATEWAY_NAME}',
    'roleArn': '${GATEWAY_ROLE_ARN}',
    'protocolType': 'MCP',
    'authorizerType': 'AWS_IAM',
})
req = AWSRequest(method='POST', url=url, headers={'Content-Type': 'application/json'}, data=body)
SigV4Auth(creds, 'bedrock-agentcore', '${REGION}').add_auth(req)
http_req = urllib.request.Request(url, data=body.encode(), headers=dict(req.headers), method='POST')
with urllib.request.urlopen(http_req) as resp:
    print(resp.read().decode())
")

GATEWAY_ID=$(echo "$GATEWAY_OUTPUT" | python3 -c "import json,sys; print(json.load(sys.stdin)['gatewayId'])")
GATEWAY_URL=$(echo "$GATEWAY_OUTPUT" | python3 -c "import json,sys; print(json.load(sys.stdin)['gatewayUrl'])")
GATEWAY_ARN=$(echo "$GATEWAY_OUTPUT" | python3 -c "import json,sys; print(json.load(sys.stdin)['gatewayArn'])")

echo "Gateway ID:  $GATEWAY_ID"
echo "Gateway URL: $GATEWAY_URL"
echo "Gateway ARN: $GATEWAY_ARN"

# Wait for READY
echo "==> Waiting for Gateway to be READY..."
for i in $(seq 1 30); do
    STATUS=$(aws bedrock-agentcore-control get-gateway \
        --gateway-id "$GATEWAY_ID" --region "$REGION" \
        --query "status" --output text 2>&1)
    if [ "$STATUS" = "READY" ]; then
        echo "Gateway is READY!"
        break
    fi
    sleep 5
done

# Get Lambda ARN
LAMBDA_ARN=$(aws lambda get-function \
    --function-name "$LAMBDA_FUNCTION_NAME" --region "$REGION" \
    --query 'Configuration.FunctionArn' --output text)
echo "Lambda ARN: $LAMBDA_ARN"

echo ""
echo "==> Step 2: Creating Lambda target with 12 tool schemas..."

# Create target config JSON
cat > /tmp/gateway-target-config.json << TARGETEOF
{
  "gatewayIdentifier": "${GATEWAY_ID}",
  "name": "${TARGET_NAME}",
  "description": "Neptune graph + DynamoDB CRUD tools for OTA travel planning",
  "targetConfiguration": {
    "mcp": {
      "lambda": {
        "lambdaArn": "${LAMBDA_ARN}",
        "toolSchema": {
          "inlinePayload": $(cat << 'TOOLS'
[
  {"name":"get_package","description":"Retrieve complete package information including related cities, attractions, hotels, routes, themes, and activities.","inputSchema":{"type":"object","properties":{"package_code":{"type":"string","description":"The unique package code."}},"required":["package_code"]}},
  {"name":"search_packages","description":"Search for existing travel packages matching conditions.","inputSchema":{"type":"object","properties":{"destination":{"type":"string","description":"Region or city name."},"theme":{"type":"string"},"season":{"type":"string"},"nights":{"type":"integer"},"max_budget":{"type":"integer"},"shopping_max":{"type":"integer"}},"required":["destination"]}},
  {"name":"get_routes_by_region","description":"Retrieve available flight routes for a region.","inputSchema":{"type":"object","properties":{"region":{"type":"string","description":"Region name."}},"required":["region"]}},
  {"name":"get_attractions_by_city","description":"Retrieve attractions in a city, optionally filtered by category.","inputSchema":{"type":"object","properties":{"city":{"type":"string","description":"City name."},"category":{"type":"string"}},"required":["city"]}},
  {"name":"get_hotels_by_city","description":"Retrieve hotels in a city, optionally filtered by grade and onsen.","inputSchema":{"type":"object","properties":{"city":{"type":"string","description":"City name."},"grade":{"type":"string"},"has_onsen":{"type":"boolean"}},"required":["city"]}},
  {"name":"get_trends","description":"Retrieve active trends and TrendSpot locations for a region with time-decay scoring.","inputSchema":{"type":"object","properties":{"region":{"type":"string","description":"Region name."},"min_score":{"type":"integer"}},"required":["region"]}},
  {"name":"get_similar_packages","description":"Find similar packages via SIMILAR_TO edges.","inputSchema":{"type":"object","properties":{"package_code":{"type":"string","description":"Package code."}},"required":["package_code"]}},
  {"name":"get_nearby_cities","description":"Find cities near a specified city within max distance.","inputSchema":{"type":"object","properties":{"city":{"type":"string","description":"City name."},"max_km":{"type":"integer"}},"required":["city"]}},
  {"name":"save_product","description":"Save a planned product to DynamoDB.","inputSchema":{"type":"object","properties":{"product_json":{"type":"string","description":"JSON string of the product data."}},"required":["product_json"]}},
  {"name":"get_product","description":"Get a planned product from DynamoDB.","inputSchema":{"type":"object","properties":{"product_code":{"type":"string"}},"required":["product_code"]}},
  {"name":"list_products","description":"List planned products from DynamoDB.","inputSchema":{"type":"object","properties":{"limit":{"type":"integer"},"region":{"type":"string"}},"required":[]}},
  {"name":"delete_product","description":"Delete a planned product from DynamoDB.","inputSchema":{"type":"object","properties":{"product_code":{"type":"string"}},"required":["product_code"]}}
]
TOOLS
)
        }
      }
    }
  },
  "credentialProviderConfigurations": [{"credentialProviderType": "GATEWAY_IAM_ROLE"}]
}
TARGETEOF

aws bedrock-agentcore-control create-gateway-target \
    --region "$REGION" \
    --cli-input-json file:///tmp/gateway-target-config.json \
    --output json --no-cli-pager

echo ""
echo "============================================"
echo "Gateway setup complete!"
echo ""
echo "Gateway MCP URL: ${GATEWAY_URL}"
echo ""
echo "Set this in your agent environment:"
echo "  export GATEWAY_MCP_URL=${GATEWAY_URL}"
echo "============================================"
