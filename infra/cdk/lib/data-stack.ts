import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as neptune from "aws-cdk-lib/aws-neptune";
import * as elasticache from "aws-cdk-lib/aws-elasticache";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";
import { CONFIG } from "./shared-config";

interface OtaDataStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  neptuneSg: ec2.ISecurityGroup;
  valkeySg: ec2.ISecurityGroup;
}

export class DataStack extends cdk.Stack {
  public readonly neptuneEndpoint: string;
  public readonly neptuneHost: string;
  public readonly valkeyEndpoint: string;
  public readonly dynamoTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: OtaDataStackProps) {
    super(scope, id, props);

    // ════════════════════════════════════════════════════════════
    //  1. Neptune Serverless (L1 — CfnDBCluster)
    // ════════════════════════════════════════════════════════════

    const privateSubnets = props.vpc.selectSubnets({
      subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
    });

    const subnetGroup = new neptune.CfnDBSubnetGroup(
      this,
      "NeptuneSubnetGroup",
      {
        dbSubnetGroupDescription: "Private subnets for Neptune cluster",
        dbSubnetGroupName: "ota-neptune-subnets",
        subnetIds: privateSubnets.subnetIds,
      }
    );

    const cluster = new neptune.CfnDBCluster(this, "NeptuneCluster", {
      dbClusterIdentifier: CONFIG.neptune.clusterIdentifier,
      engineVersion: CONFIG.neptune.engineVersion,
      iamAuthEnabled: true,
      storageEncrypted: true,
      deletionProtection: true,
      serverlessScalingConfiguration: {
        minCapacity: CONFIG.neptune.minCapacity,
        maxCapacity: CONFIG.neptune.maxCapacity,
      },
      vpcSecurityGroupIds: [props.neptuneSg.securityGroupId],
      dbSubnetGroupName: subnetGroup.ref,
      // snapshotIdentifier: 'travel-cdk-migration', // uncomment for initial migration
    });

    // Neptune Serverless still requires at least one CfnDBInstance
    // with db.serverless class — without it the cluster endpoint DNS
    // won't resolve (NXDOMAIN).
    const instance = new neptune.CfnDBInstance(this, "NeptuneInstance", {
      dbClusterIdentifier: cluster.ref,
      dbInstanceClass: "db.serverless",
      dbInstanceIdentifier: `${CONFIG.neptune.clusterIdentifier}-instance-1`,
    });
    instance.addDependency(cluster);

    this.neptuneEndpoint = `wss://${cluster.attrEndpoint}:${CONFIG.neptune.port}/gremlin`;
    this.neptuneHost = cluster.attrEndpoint;

    // ════════════════════════════════════════════════════════════
    //  2. Valkey (ElastiCache Serverless — L1 CfnServerlessCache)
    // ════════════════════════════════════════════════════════════

    const cache = new elasticache.CfnServerlessCache(
      this,
      "ValkeyServerless",
      {
        engine: "valkey",
        serverlessCacheName: CONFIG.valkey.cacheName,
        majorEngineVersion: CONFIG.valkey.majorEngineVersion,
        securityGroupIds: [props.valkeySg.securityGroupId],
        subnetIds: privateSubnets.subnetIds.slice(0, 3),
        snapshotRetentionLimit: 0,
      }
    );

    this.valkeyEndpoint = cache.attrEndpointAddress;

    // ════════════════════════════════════════════════════════════
    //  3. DynamoDB (L2 — Table)
    // ════════════════════════════════════════════════════════════

    this.dynamoTable = new dynamodb.Table(this, "PlannedProductsTable", {
      tableName: CONFIG.dynamodb.tableName,
      partitionKey: {
        name: CONFIG.dynamodb.partitionKey,
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ── Outputs ──────────────────────────────────────────────────
    new cdk.CfnOutput(this, "NeptuneEndpoint", {
      value: this.neptuneEndpoint,
      description: "Neptune Gremlin WebSocket endpoint",
    });

    new cdk.CfnOutput(this, "ValkeyEndpoint", {
      value: this.valkeyEndpoint,
      description: "Valkey (ElastiCache Serverless) endpoint address",
    });

    new cdk.CfnOutput(this, "DynamoTableName", {
      value: this.dynamoTable.tableName,
      description: "DynamoDB table name",
    });
  }
}
