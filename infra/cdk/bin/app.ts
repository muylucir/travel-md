#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { NetworkStack } from "../lib/network-stack";
import { DataStack } from "../lib/data-stack";
import { LambdaStack } from "../lib/lambda-stack";
import { OtaGatewayStack } from "../lib/gateway-stack";
import { OtaAgentStack } from "../lib/agent-stack";
import { WebHostingStack } from "../lib/web-hosting-stack";
import { CONFIG } from "../lib/shared-config";

const app = new cdk.App();
const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: CONFIG.region,
};

// ── 1. Network ──────────────────────────────────────────────────
const network = new NetworkStack(app, "OtaNetworkStack", { env });

// ── 2. Data (Neptune + Valkey + DynamoDB) ───────────────────────
const data = new DataStack(app, "OtaDataStack", {
  env,
  vpc: network.vpc,
  neptuneSg: network.neptuneSg,
  valkeySg: network.valkeySg,
});

// ── 3. Lambda functions ─────────────────────────────────────────
const lambda = new LambdaStack(app, "OtaLambdaStack", {
  env,
  vpc: network.vpc,
  neptuneSg: network.neptuneSg,
  neptuneEndpoint: data.neptuneEndpoint,
  valkeyHost: data.valkeyEndpoint,
  valkeyPort: String(CONFIG.valkey.port),
  dynamoTableName: data.dynamoTable.tableName,
  dynamoTableArn: data.dynamoTable.tableArn,
});

// ── 4. AgentCore Gateway ────────────────────────────────────────
const gateway = new OtaGatewayStack(app, "OtaGatewayStack", {
  env,
  travelToolsFnArn: lambda.travelToolsFn.functionArn,
  trendCollectorFnArn: lambda.trendCollectorFn.functionArn,
});

// ── 5. AgentCore Agents ─────────────────────────────────────────
const agent = new OtaAgentStack(app, "OtaAgentStack", {
  env,
  vpc: network.vpc,
  neptuneSg: network.neptuneSg,
  neptuneEndpoint: data.neptuneEndpoint,
  valkeyHost: data.valkeyEndpoint,
  dynamoTableName: data.dynamoTable.tableName,
  gatewayMcpUrl: gateway.gatewayMcpUrl,
  gatewayArn: gateway.gatewayArn,
});

// ── 6. Web Hosting (EC2 + CloudFront) ───────────────────────────
new WebHostingStack(app, "OtaWebStack", {
  env,
  vpc: network.vpc,
  neptuneSg: network.neptuneSg,
  neptuneHost: data.neptuneHost,
  valkeyHost: data.valkeyEndpoint,
  dynamoTableName: data.dynamoTable.tableName,
  dynamoTableArn: data.dynamoTable.tableArn,
  travelAgentArn: agent.travelAgentArn,
  trendCollectorArn: agent.trendCollectorArn,
});
