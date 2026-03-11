import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import * as path from "path";
import { execSync } from "child_process";

// ── Props ────────────────────────────────────────────────────────
export interface OtaLambdaStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  neptuneSg: ec2.ISecurityGroup;
  neptuneEndpoint: string; // wss://...
  valkeyHost: string;
  valkeyPort: string;
  dynamoTableName: string;
  dynamoTableArn: string;
}

/**
 * Bundles a Python Lambda locally (pip install + copy source).
 * Falls back to Docker if local pip is unavailable.
 */
function pythonBundling(
  srcDir: string,
  sourceFiles: string[]
): cdk.BundlingOptions {
  const absDir = path.resolve(__dirname, srcDir);

  return {
    image: lambda.Runtime.PYTHON_3_11.bundlingImage,
    local: {
      tryBundle(outputDir: string): boolean {
        try {
          execSync(
            `pip install -r ${absDir}/requirements.txt -t ${outputDir} --quiet`,
            { stdio: "inherit" }
          );
          for (const f of sourceFiles) {
            const src = path.join(absDir, f);
            execSync(`cp -r ${src} ${outputDir}/`, { stdio: "inherit" });
          }
          return true;
        } catch {
          return false; // fall back to Docker
        }
      },
    },
    command: [
      "bash",
      "-c",
      "pip install -r requirements.txt -t /asset-output && cp -r . /asset-output/",
    ],
  };
}

export class LambdaStack extends cdk.Stack {
  public readonly travelToolsFn: lambda.Function;
  public readonly trendCollectorFn: lambda.Function;

  constructor(scope: Construct, id: string, props: OtaLambdaStackProps) {
    super(scope, id, props);

    // ════════════════════════════════════════════════════════════
    //  1. ota-travel-tools  (VPC, Neptune + Valkey + DynamoDB)
    // ════════════════════════════════════════════════════════════

    const travelToolsRole = new iam.Role(this, "TravelToolsRole", {
      roleName: "ota-travel-tools-role",
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AWSLambdaVPCAccessExecutionRole"
        ),
      ],
    });

    travelToolsRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "Neptune",
        actions: ["neptune-db:*"],
        resources: [
          `arn:aws:neptune-db:${this.region}:${this.account}:*/*`,
        ],
      })
    );

    travelToolsRole.addToPolicy(
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

    this.travelToolsFn = new lambda.Function(this, "TravelTools", {
      functionName: "ota-travel-tools",
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: "handler.handler",
      code: lambda.Code.fromAsset(
        path.join(__dirname, "../../lambda"),
        {
          bundling: pythonBundling("../../lambda", [
            "handler.py",
            "graph_client.py",
            "tools",
          ]),
        }
      ),
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      role: travelToolsRole,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.neptuneSg],
      environment: {
        GREMLIN_ENDPOINT: props.neptuneEndpoint,
        DYNAMODB_TABLE_NAME: props.dynamoTableName,
        REDIS_HOST: props.valkeyHost,
        REDIS_PORT: props.valkeyPort,
      },
    });

    // ════════════════════════════════════════════════════════════
    //  2. ota-trend-collector  (no VPC, external API calls)
    // ════════════════════════════════════════════════════════════

    const trendCollectorRole = new iam.Role(this, "TrendCollectorRole", {
      roleName: "ota-trend-collector-role",
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AWSLambdaBasicExecutionRole"
        ),
      ],
    });

    // Trend collector env: pass API keys from shell env at deploy time.
    //   YOUTUBE_API_KEY=xxx NAVER_CLIENT_ID=xxx cdk deploy OtaTravelLambdaStack
    // Or set later via:
    //   aws lambda update-function-configuration --function-name ota-trend-collector \
    //     --environment "Variables={YOUTUBE_API_KEY=...,NAVER_CLIENT_ID=...,NAVER_CLIENT_SECRET=...}"
    const trendEnv: Record<string, string> = {};
    if (process.env.YOUTUBE_API_KEY)
      trendEnv.YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
    if (process.env.NAVER_CLIENT_ID)
      trendEnv.NAVER_CLIENT_ID = process.env.NAVER_CLIENT_ID;
    if (process.env.NAVER_CLIENT_SECRET)
      trendEnv.NAVER_CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET;

    this.trendCollectorFn = new lambda.Function(this, "TrendCollector", {
      functionName: "ota-trend-collector",
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: "handler.handler",
      code: lambda.Code.fromAsset(
        path.join(__dirname, "../../trend-collector-lambda"),
        {
          bundling: pythonBundling("../../trend-collector-lambda", [
            "handler.py",
            "tools",
          ]),
        }
      ),
      memorySize: 512,
      timeout: cdk.Duration.seconds(60),
      role: trendCollectorRole,
      ...(Object.keys(trendEnv).length > 0 ? { environment: trendEnv } : {}),
    });

    // ── Outputs ────────────────────────────────────────────────
    new cdk.CfnOutput(this, "TravelToolsArn", {
      value: this.travelToolsFn.functionArn,
    });

    new cdk.CfnOutput(this, "TrendCollectorArn", {
      value: this.trendCollectorFn.functionArn,
    });
  }
}
