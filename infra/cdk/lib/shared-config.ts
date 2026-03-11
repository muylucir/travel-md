// ── Central configuration constants ─────────────────────────────
// Shared across all CDK stacks — edit here, not in individual stacks.

export const CONFIG = {
  region: "ap-northeast-2",
  vpc: {
    cidr: "10.1.0.0/16",
    maxAzs: 2,
    natGateways: 1,
  },
  neptune: {
    clusterIdentifier: "travel",
    engineVersion: "1.4.5.1",
    minCapacity: 2,
    maxCapacity: 16,
    port: 8182,
  },
  valkey: {
    cacheName: "ota-valkey",
    majorEngineVersion: "8",
    port: 6379,
  },
  dynamodb: {
    tableName: "ota-planned-products",
    partitionKey: "product_code",
  },
  bedrockRegion: "us-east-1",
  web: {
    appPort: 3000,
    instanceType: "t3.medium",
    ebsSizeGb: 20,
  },
} as const;
