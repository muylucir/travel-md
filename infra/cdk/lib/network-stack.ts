import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { Construct } from "constructs";
import { CONFIG } from "./shared-config";

export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly neptuneSg: ec2.SecurityGroup;
  public readonly valkeySg: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── 1. VPC ─────────────────────────────────────────────────────
    this.vpc = new ec2.Vpc(this, "Vpc", {
      vpcName: "ota-travel-vpc",
      ipAddresses: ec2.IpAddresses.cidr(CONFIG.vpc.cidr),
      maxAzs: CONFIG.vpc.maxAzs,
      natGateways: CONFIG.vpc.natGateways,
      subnetConfiguration: [
        {
          name: "public",
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: "private",
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
      ],
    });

    // ── 2. Neptune Security Group ──────────────────────────────────
    this.neptuneSg = new ec2.SecurityGroup(this, "NeptuneSg", {
      vpc: this.vpc,
      securityGroupName: "ota-neptune-sg",
      description:
        "Neptune, Lambda, AgentCore — self-referencing on port 8182",
      allowAllOutbound: true,
    });

    this.neptuneSg.addIngressRule(
      this.neptuneSg,
      ec2.Port.tcp(CONFIG.neptune.port),
      "Neptune self-referencing"
    );

    // ── 3. Valkey Security Group ───────────────────────────────────
    this.valkeySg = new ec2.SecurityGroup(this, "ValkeySg", {
      vpc: this.vpc,
      securityGroupName: "ota-valkey-sg",
      description: "Valkey — allow port 6379 from Neptune SG members",
      allowAllOutbound: true,
    });

    this.valkeySg.addIngressRule(
      this.neptuneSg,
      ec2.Port.tcp(CONFIG.valkey.port),
      "Valkey from Neptune SG"
    );
  }
}
