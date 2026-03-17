import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import { Construct } from "constructs";
import { CONFIG } from "./shared-config";

// ── Props ────────────────────────────────────────────────────────
export interface OtaWebStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  neptuneSg: ec2.ISecurityGroup;
  neptuneHost: string;
  valkeyHost: string;
  dynamoTableName: string;
  dynamoTableArn: string;
  travelAgentArn: string;
  trendCollectorArn: string;
}

// ── Local constants ──────────────────────────────────────────────
const APP_PORT = CONFIG.web.appPort;
const INSTANCE_TYPE = CONFIG.web.instanceType;
const EBS_SIZE_GB = CONFIG.web.ebsSizeGb;

export class WebHostingStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: OtaWebStackProps) {
    super(scope, id, props);

    // ── 1. S3 Deploy Bucket ────────────────────────────────────
    const deployBucket = new s3.Bucket(this, "DeployBucket", {
      bucketName: `ota-travel-web-deploy-${this.account}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{ expiration: cdk.Duration.days(30) }],
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
    });

    // ── 2. IAM Role ────────────────────────────────────────────
    const role = new iam.Role(this, "WebEc2Role", {
      roleName: "ota-web-ec2-role",
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        // SSM Session Manager (management without SSH)
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "AmazonSSMManagedInstanceCore"
        ),
      ],
    });

    // DynamoDB — ota-planned-products
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "DynamoDB",
        actions: [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:Query",
          "dynamodb:Scan",
        ],
        resources: [
          props.dynamoTableArn,
          `${props.dynamoTableArn}/*`,
        ],
      })
    );

    // Bedrock AgentCore Runtime — invoke planning + trend agents
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "BedrockAgentCore",
        actions: ["bedrock-agentcore:InvokeAgent"],
        resources: [props.travelAgentArn, props.trendCollectorArn],
      })
    );

    // Neptune — IAM auth for Gremlin WebSocket
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "Neptune",
        actions: ["neptune-db:*"],
        resources: [
          `arn:aws:neptune-db:${this.region}:${this.account}:*/*`,
        ],
      })
    );

    // S3 deploy bucket — pull deployment artifacts
    deployBucket.grantRead(role);

    // ── 3. EC2 Instance ────────────────────────────────────────
    const instance = new ec2.Instance(this, "WebInstance", {
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      instanceType: new ec2.InstanceType(INSTANCE_TYPE),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      role,
      blockDevices: [
        {
          deviceName: "/dev/xvda",
          volume: ec2.BlockDeviceVolume.ebs(EBS_SIZE_GB, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
          }),
        },
      ],
      instanceName: "ota-travel-web",
    });

    // Attach Neptune SG — gives access to Neptune (8182) + Valkey (6379)
    instance.addSecurityGroup(props.neptuneSg);

    // Allow CloudFront VPC Origin → EC2 on port 3000
    // VPC Origins require the CloudFront managed prefix list, not VPC CIDR.
    const cfPrefixList = ec2.PrefixList.fromLookup(this, "CloudFrontPL", {
      prefixListName: "com.amazonaws.global.cloudfront.origin-facing",
    });
    instance.connections.allowFrom(
      ec2.Peer.prefixList(cfPrefixList.prefixListId),
      ec2.Port.tcp(APP_PORT),
      "CloudFront VPC Origin to Next.js"
    );

    // ── 4. UserData — bootstrap Node.js + systemd service ──────
    instance.addUserData(
      "#!/bin/bash",
      "set -ex",
      "",
      "# Install Node.js 22 (LTS)",
      "curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -",
      "dnf install -y nodejs",
      "",
      "# App directory",
      "mkdir -p /opt/travel-md-web",
      "chown ec2-user:ec2-user /opt/travel-md-web",
      "",
      "# Environment file",
      "cat > /opt/travel-md-web/.env.production <<'ENVEOF'",
      "NODE_ENV=production",
      `PORT=${APP_PORT}`,
      "HOSTNAME=0.0.0.0",
      `AWS_REGION=${this.region}`,
      `DYNAMODB_TABLE_NAME=${props.dynamoTableName}`,
      `NEPTUNE_HOST=${props.neptuneHost}`,
      "NEPTUNE_PORT=8182",
      `REDIS_HOST=${props.valkeyHost}`,
      "REDIS_PORT=6379",
      `AGENTCORE_AGENT_ARN=${props.travelAgentArn}`,
      `TREND_COLLECTOR_AGENT_ARN=${props.trendCollectorArn}`,
      "ENVEOF",
      "chown ec2-user:ec2-user /opt/travel-md-web/.env.production",
      "",
      "# Systemd service for Next.js standalone",
      "cat > /etc/systemd/system/nextjs.service <<'SVCEOF'",
      "[Unit]",
      "Description=Next.js OTA Travel Web",
      "After=network.target",
      "",
      "[Service]",
      "Type=simple",
      "User=ec2-user",
      "WorkingDirectory=/opt/travel-md-web",
      "EnvironmentFile=/opt/travel-md-web/.env.production",
      "ExecStart=/usr/bin/node server.js",
      "Restart=on-failure",
      "RestartSec=5",
      "",
      "[Install]",
      "WantedBy=multi-user.target",
      "SVCEOF",
      "",
      "systemctl daemon-reload",
      "systemctl enable nextjs",
      "",
      "# Pull latest build from S3 and start service",
      `DEPLOY_BUCKET="${deployBucket.bucketName}"`,
      "APP_DIR=/opt/travel-md-web",
      "",
      "if aws s3 ls \"s3://${DEPLOY_BUCKET}/latest.tar.gz\" 2>/dev/null; then",
      "  aws s3 cp \"s3://${DEPLOY_BUCKET}/latest.tar.gz\" /tmp/app.tar.gz",
      "  rm -rf ${APP_DIR}/server.js ${APP_DIR}/node_modules ${APP_DIR}/.next ${APP_DIR}/public",
      "  tar -xzf /tmp/app.tar.gz -C ${APP_DIR}",
      "  chown -R ec2-user:ec2-user ${APP_DIR}",
      "  rm -f /tmp/app.tar.gz",
      "  systemctl start nextjs",
      "fi"
    );

    // ── 5. CloudFront Distribution ─────────────────────────────
    // VPC Origin lets CloudFront reach private-subnet instances directly.
    // It automatically creates a managed security group for CF → EC2 access.
    const origin = origins.VpcOrigin.withEc2Instance(instance, {
      httpPort: APP_PORT,
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
    });

    const distribution = new cloudfront.Distribution(this, "WebCdn", {
      comment: "OTA Travel Web — CloudFront → EC2",
      defaultBehavior: {
        origin,
        viewerProtocolPolicy:
          cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy:
          cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      },
      // Static assets — immutable, long cache
      additionalBehaviors: {
        "_next/static/*": {
          origin,
          viewerProtocolPolicy:
            cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        },
      },
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
    });

    // ── 6. Outputs ─────────────────────────────────────────────
    new cdk.CfnOutput(this, "CloudFrontDomain", {
      value: distribution.distributionDomainName,
      description: "CloudFront URL (https://<domain>)",
    });

    new cdk.CfnOutput(this, "CloudFrontDistributionId", {
      value: distribution.distributionId,
    });

    new cdk.CfnOutput(this, "Ec2InstanceId", {
      value: instance.instanceId,
    });

    new cdk.CfnOutput(this, "DeployBucketName", {
      value: deployBucket.bucketName,
      description: "S3 bucket for deploy artifacts",
    });
  }
}
