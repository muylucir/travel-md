#!/usr/bin/env bash
# deploy-web.sh — Build Next.js standalone and deploy to EC2 via S3 + SSM.
#
# Usage:
#   ./infra/scripts/deploy-web.sh
#
# Prerequisites:
#   - CDK stack "OtaTravelWebStack" deployed
#   - AWS CLI configured with SSM + S3 permissions

set -euo pipefail

REGION="ap-northeast-2"
STACK_NAME="OtaTravelWebStack"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WEB_DIR="$(cd "$SCRIPT_DIR/../../web" && pwd)"

echo "==> Reading stack outputs..."
read_output() {
  aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" \
    --output text
}

INSTANCE_ID=$(read_output Ec2InstanceId)
DEPLOY_BUCKET=$(read_output DeployBucketName)

echo "    Instance:  $INSTANCE_ID"
echo "    S3 Bucket: $DEPLOY_BUCKET"

# ── 1. Build ────────────────────────────────────────────────────
echo "==> Building Next.js (standalone)..."
cd "$WEB_DIR"
npm run build

# ── 2. Package ──────────────────────────────────────────────────
echo "==> Packaging deployment artifact..."
DEPLOY_DIR="/tmp/travel-md-web-deploy-$$"
TARBALL="/tmp/travel-md-web.tar.gz"
rm -rf "$DEPLOY_DIR" "$TARBALL"
mkdir -p "$DEPLOY_DIR"

# Standalone server + node_modules
cp -r .next/standalone/* "$DEPLOY_DIR/"

# Static assets (not included in standalone output)
[ -d public ] && cp -r public "$DEPLOY_DIR/"
mkdir -p "$DEPLOY_DIR/.next"
cp -r .next/static "$DEPLOY_DIR/.next/"

tar czf "$TARBALL" -C "$DEPLOY_DIR" .
TARBALL_SIZE=$(du -h "$TARBALL" | cut -f1)
echo "    Artifact: $TARBALL ($TARBALL_SIZE)"

# ── 3. Upload to S3 ────────────────────────────────────────────
echo "==> Uploading to s3://$DEPLOY_BUCKET/latest.tar.gz ..."
aws s3 cp "$TARBALL" "s3://$DEPLOY_BUCKET/latest.tar.gz" --region "$REGION"

# ── 4. Deploy on EC2 via SSM ───────────────────────────────────
echo "==> Deploying on EC2 ($INSTANCE_ID) via SSM..."
COMMAND_ID=$(aws ssm send-command \
  --instance-ids "$INSTANCE_ID" \
  --document-name "AWS-RunShellScript" \
  --parameters "commands=[
    \"set -ex\",
    \"aws s3 cp s3://$DEPLOY_BUCKET/latest.tar.gz /tmp/travel-md-web.tar.gz --region $REGION\",
    \"cd /opt/travel-md-web && rm -rf .next node_modules server.js package.json public\",
    \"tar xzf /tmp/travel-md-web.tar.gz -C /opt/travel-md-web\",
    \"rm /tmp/travel-md-web.tar.gz\",
    \"sudo systemctl restart nextjs\",
    \"sleep 2 && sudo systemctl is-active nextjs\"
  ]" \
  --region "$REGION" \
  --timeout-seconds 120 \
  --output text \
  --query "Command.CommandId")

echo "    SSM Command: $COMMAND_ID"
echo "==> Waiting for command to complete..."

aws ssm wait command-executed \
  --command-id "$COMMAND_ID" \
  --instance-id "$INSTANCE_ID" \
  --region "$REGION" 2>/dev/null || true

STATUS=$(aws ssm get-command-invocation \
  --command-id "$COMMAND_ID" \
  --instance-id "$INSTANCE_ID" \
  --region "$REGION" \
  --query "Status" --output text)

if [ "$STATUS" = "Success" ]; then
  echo "==> Deploy successful!"
else
  echo "==> Deploy status: $STATUS"
  echo "    Check logs: aws ssm get-command-invocation --command-id $COMMAND_ID --instance-id $INSTANCE_ID --region $REGION"
  exit 1
fi

# ── Cleanup ─────────────────────────────────────────────────────
rm -rf "$DEPLOY_DIR" "$TARBALL"

CF_DOMAIN=$(read_output CloudFrontDomain)
echo ""
echo "==> Live at: https://$CF_DOMAIN"
