import gremlin from "gremlin";
// @ts-expect-error -- no type declarations for aws4
import aws4 from "aws4";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";

const { DriverRemoteConnection } = gremlin.driver;

const NEPTUNE_HOST =
  process.env.NEPTUNE_HOST ||
  "REDACTED_NEPTUNE_HOST";
const NEPTUNE_PORT = process.env.NEPTUNE_PORT || "8182";
const NEPTUNE_REGION = process.env.AWS_REGION || "ap-northeast-2";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let connection: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let g: any = null;

/**
 * Returns a singleton Gremlin graph traversal source.
 * Signs the WebSocket handshake with SigV4 using EC2 instance IAM role.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getTraversal(): Promise<any> {
  if (g && connection) {
    return g;
  }

  // 1. Get IAM credentials from instance role
  const creds = await fromNodeProviderChain()();

  // 2. Sign the HTTP request that becomes the WebSocket handshake
  const signed = aws4.sign(
    {
      host: `${NEPTUNE_HOST}:${NEPTUNE_PORT}`,
      path: "/gremlin",
      service: "neptune-db",
      region: NEPTUNE_REGION,
    },
    {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    }
  );

  // 3. Connect with signed headers in the WebSocket handshake
  const url = `wss://${NEPTUNE_HOST}:${NEPTUNE_PORT}/gremlin`;

  connection = new DriverRemoteConnection(url, {
    mimeType: "application/vnd.gremlin-v2.0+json",
    headers: signed.headers,
    connectOnStartup: true,
    pingEnabled: false,
  });

  g = gremlin.process.AnonymousTraversalSource.traversal().withRemote(
    connection
  );

  return g;
}

/**
 * Close the Gremlin connection (for graceful shutdown).
 */
export async function closeConnection(): Promise<void> {
  if (connection) {
    await connection.close();
    connection = null;
    g = null;
  }
}

/**
 * Converts a Gremlin Map result to a plain JavaScript object.
 */
export function mapToObject<T = Record<string, unknown>>(
  result: Map<string, unknown> | Record<string, unknown>
): T {
  if (result instanceof Map) {
    const obj: Record<string, unknown> = {};
    for (const [key, value] of result) {
      if (value instanceof Map) {
        obj[key] = mapToObject(value);
      } else if (Array.isArray(value)) {
        obj[key] = value.map((item) =>
          item instanceof Map ? mapToObject(item) : item
        );
      } else {
        obj[key] = value;
      }
    }
    return obj as T;
  }
  return result as T;
}

/**
 * Helper to safely parse JSON string properties stored in Neptune.
 */
export function parseJsonProperty<T>(value: unknown, fallback: T): T {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  if (Array.isArray(value) || typeof value === "object") {
    return value as T;
  }
  return fallback;
}
