import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as agentcore from "aws-cdk-lib/aws-bedrockagentcore";
import { Construct } from "constructs";
import * as path from "path";
import { loadToolSchemas } from "./utils/schema-converter";

// ── Props ────────────────────────────────────────────────────────

export interface OtaGatewayStackProps extends cdk.StackProps {
  travelToolsFnArn: string;
  trendCollectorFnArn: string;
}

// ── Stack ────────────────────────────────────────────────────────

export class OtaGatewayStack extends cdk.Stack {
  public readonly gatewayMcpUrl: string;
  public readonly gatewayArn: string;

  constructor(scope: Construct, id: string, props: OtaGatewayStackProps) {
    super(scope, id, props);

    // ════════════════════════════════════════════════════════════
    //  1. Gateway IAM Role
    // ════════════════════════════════════════════════════════════

    const gatewayRole = new iam.Role(this, "GatewayRole", {
      roleName: "ota-travel-gateway-role",
      assumedBy: new iam.ServicePrincipal(
        "bedrock-agentcore.amazonaws.com"
      ),
    });

    gatewayRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "InvokeLambdaTargets",
        actions: ["lambda:InvokeFunction"],
        resources: [
          props.travelToolsFnArn,
          props.trendCollectorFnArn,
        ],
      })
    );

    // ════════════════════════════════════════════════════════════
    //  2. CfnGateway
    // ════════════════════════════════════════════════════════════

    const gateway = new agentcore.CfnGateway(this, "Gateway", {
      name: "ota-travel-gateway",
      protocolType: "MCP",
      authorizerType: "AWS_IAM",
      roleArn: gatewayRole.roleArn,
    });

    // ════════════════════════════════════════════════════════════
    //  3. CfnGatewayTarget — travel-tools (17 tools)
    // ════════════════════════════════════════════════════════════

    const travelToolSchemas = loadToolSchemas(
      path.join(__dirname, "../schemas/travel-tools.json")
    );

    new agentcore.CfnGatewayTarget(this, "TravelToolsTarget", {
      gatewayIdentifier: gateway.attrGatewayIdentifier,
      name: "travel-tools",
      description:
        "Neptune graph + DynamoDB CRUD tools for OTA travel planning",
      targetConfiguration: {
        mcp: {
          lambda: {
            lambdaArn: props.travelToolsFnArn,
            toolSchema: {
              inlinePayload: travelToolSchemas,
            },
          },
        },
      },
      credentialProviderConfigurations: [
        { credentialProviderType: "GATEWAY_IAM_ROLE" },
      ],
    });

    // ════════════════════════════════════════════════════════════
    //  4. CfnGatewayTarget — trend-collector (4 tools)
    // ════════════════════════════════════════════════════════════

    const trendToolSchemas = loadToolSchemas(
      path.join(__dirname, "../schemas/trend-collector.json")
    );

    new agentcore.CfnGatewayTarget(this, "TrendCollectorTarget", {
      gatewayIdentifier: gateway.attrGatewayIdentifier,
      name: "trend-collector",
      description:
        "Trend collection tools (YouTube, Naver, Google Trends, News)",
      targetConfiguration: {
        mcp: {
          lambda: {
            lambdaArn: props.trendCollectorFnArn,
            toolSchema: {
              inlinePayload: trendToolSchemas,
            },
          },
        },
      },
      credentialProviderConfigurations: [
        { credentialProviderType: "GATEWAY_IAM_ROLE" },
      ],
    });

    // ── Outputs ──────────────────────────────────────────────────

    this.gatewayMcpUrl = `${gateway.attrGatewayUrl}/mcp`;
    this.gatewayArn = gateway.attrGatewayArn;

    new cdk.CfnOutput(this, "GatewayMcpUrl", {
      value: this.gatewayMcpUrl,
      description: "MCP endpoint URL for the AgentCore Gateway",
    });

    new cdk.CfnOutput(this, "GatewayArn", {
      value: this.gatewayArn,
    });
  }
}
