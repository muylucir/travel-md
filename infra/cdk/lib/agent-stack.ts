import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as s3_assets from "aws-cdk-lib/aws-s3-assets";
import * as agentcore from "aws-cdk-lib/aws-bedrockagentcore";
import { Construct } from "constructs";
import * as path from "path";

// ── Props ────────────────────────────────────────────────────────

export interface OtaAgentStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  neptuneSg: ec2.ISecurityGroup;
  neptuneEndpoint: string;
  valkeyHost: string;
  dynamoTableName: string;
  gatewayMcpUrl: string;
  gatewayArn: string;
}

// ── Stack ────────────────────────────────────────────────────────

export class OtaAgentStack extends cdk.Stack {
  public readonly travelAgentArn: string;
  public readonly trendCollectorArn: string;

  constructor(scope: Construct, id: string, props: OtaAgentStackProps) {
    super(scope, id, props);

    // ════════════════════════════════════════════════════════════
    //  1. Runtime IAM Role
    // ════════════════════════════════════════════════════════════

    const runtimeRole = new iam.Role(this, "RuntimeRole", {
      roleName: "ota-agentcore-runtime-role",
      assumedBy: new iam.ServicePrincipal(
        "bedrock-agentcore.amazonaws.com"
      ),
    });

    // CloudWatch Logs
    runtimeRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "CloudWatchLogs",
        actions: [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ],
        resources: [
          `arn:aws:logs:${this.region}:${this.account}:log-group:*`,
        ],
      })
    );

    // X-Ray tracing
    runtimeRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "XRay",
        actions: [
          "xray:PutTraceSegments",
          "xray:PutTelemetryRecords",
        ],
        resources: ["*"],
      })
    );

    // Bedrock model invocation (all models + inference profiles)
    runtimeRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "BedrockInvoke",
        actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
        resources: [
          `arn:aws:bedrock:*:${this.account}:inference-profile/*`,
          "arn:aws:bedrock:*::foundation-model/*",
        ],
      })
    );

    // AgentCore Gateway invoke
    runtimeRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "AgentCoreGateway",
        actions: [
          "bedrock-agentcore:InvokeGateway",
          "bedrock-agentcore:Invoke",
        ],
        resources: [props.gatewayArn, `${props.gatewayArn}/*`],
      })
    );

    // CloudWatch metrics
    runtimeRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "CloudWatchMetrics",
        actions: ["cloudwatch:PutMetricData"],
        resources: ["*"],
      })
    );

    // ECR pull (needed for CodeBuild image)
    runtimeRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "ECRPull",
        actions: [
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
          "ecr:GetAuthorizationToken",
        ],
        resources: ["*"],
      })
    );

    // STS (web identity for cross-account)
    runtimeRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "STS",
        actions: ["sts:GetWebIdentityToken"],
        resources: ["*"],
      })
    );

    // ════════════════════════════════════════════════════════════
    //  2. S3 Assets for agent code
    // ════════════════════════════════════════════════════════════

    const travelAgentAsset = new s3_assets.Asset(this, "TravelAgentCode", {
      path: path.join(__dirname, "../../../agent"),
      exclude: [
        ".venv",
        "__pycache__",
        "*.pyc",
        ".bedrock_agentcore",
        "dist",
        ".git",
      ],
    });

    const trendAgentAsset = new s3_assets.Asset(this, "TrendAgentCode", {
      path: path.join(__dirname, "../../../trend-agent"),
      exclude: [
        ".venv",
        "__pycache__",
        "*.pyc",
        ".bedrock_agentcore",
        "dist",
        ".git",
      ],
    });

    // Grant the runtime role read access to the S3 assets
    travelAgentAsset.grantRead(runtimeRole);
    trendAgentAsset.grantRead(runtimeRole);

    // ════════════════════════════════════════════════════════════
    //  3. CfnRuntime — travel agent (VPC mode)
    // ════════════════════════════════════════════════════════════

    // Select private subnets for VPC placement
    const privateSubnets = props.vpc.selectSubnets({
      subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
    });

    const travelRuntime = new agentcore.CfnRuntime(
      this,
      "TravelAgentRuntime",
      {
        agentRuntimeName: "ota_travel_agent",
        description: "OTA Travel Agent — itinerary planning with Neptune graph + DynamoDB",
        roleArn: runtimeRole.roleArn,
        agentRuntimeArtifact: {
          codeConfiguration: {
            code: {
              s3: {
                bucket: travelAgentAsset.s3BucketName,
                prefix: travelAgentAsset.s3ObjectKey,
              },
            },
            entryPoint: ["src.agentcore_app"],
            runtime: "PYTHON_3_11",
          },
        },
        networkConfiguration: {
          networkMode: "VPC",
          networkModeConfig: {
            securityGroups: [props.neptuneSg.securityGroupId],
            subnets: privateSubnets.subnetIds,
          },
        },
        environmentVariables: {
          GATEWAY_MCP_URL: props.gatewayMcpUrl,
          BEDROCK_REGION: "us-east-1",
          REDIS_HOST: props.valkeyHost,
          GREMLIN_ENDPOINT: props.neptuneEndpoint,
          DYNAMODB_TABLE_NAME: props.dynamoTableName,
          AWS_DEFAULT_REGION: this.region,
        },
      }
    );

    // ════════════════════════════════════════════════════════════
    //  4. CfnRuntime — trend collector (PUBLIC mode)
    // ════════════════════════════════════════════════════════════

    const trendRuntime = new agentcore.CfnRuntime(
      this,
      "TrendCollectorRuntime",
      {
        agentRuntimeName: "ota_trend_collector",
        description: "OTA Trend Collector — YouTube, Naver, Google Trends, News aggregation",
        roleArn: runtimeRole.roleArn,
        agentRuntimeArtifact: {
          codeConfiguration: {
            code: {
              s3: {
                bucket: trendAgentAsset.s3BucketName,
                prefix: trendAgentAsset.s3ObjectKey,
              },
            },
            entryPoint: ["src.agentcore_app"],
            runtime: "PYTHON_3_11",
          },
        },
        networkConfiguration: {
          networkMode: "PUBLIC",
        },
        environmentVariables: {
          GATEWAY_MCP_URL: props.gatewayMcpUrl,
          BEDROCK_REGION: "us-east-1",
          AWS_DEFAULT_REGION: this.region,
        },
      }
    );

    // ── Outputs ──────────────────────────────────────────────────

    this.travelAgentArn = travelRuntime.attrAgentRuntimeArn;
    this.trendCollectorArn = trendRuntime.attrAgentRuntimeArn;

    new cdk.CfnOutput(this, "TravelAgentArn", {
      value: this.travelAgentArn,
    });

    new cdk.CfnOutput(this, "TrendCollectorAgentArn", {
      value: this.trendCollectorArn,
    });
  }
}
