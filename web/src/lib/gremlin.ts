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
let connectedAt = 0;

// SigV4 signatures expire after 5 minutes; reconnect before that
const MAX_CONNECTION_AGE_MS = 4 * 60 * 1000; // 4 min (with 1 min margin)

/**
 * Reset connection so next getTraversal() creates a fresh one.
 */
export function resetConnection(): void {
  try {
    connection?.close();
  } catch {
    // ignore close errors
  }
  connection = null;
  g = null;
  connectedAt = 0;
}

/**
 * Check if the connection is stale (SigV4 signature expired).
 */
function isConnectionStale(): boolean {
  if (!connectedAt) return true;
  return Date.now() - connectedAt > MAX_CONNECTION_AGE_MS;
}

/**
 * Returns a Gremlin graph traversal source.
 * Automatically reconnects when SigV4 signature expires.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getTraversal(): Promise<any> {
  if (g && connection && !isConnectionStale()) {
    return g;
  }

  // Close stale connection
  if (connection) {
    resetConnection();
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

  connectedAt = Date.now();

  return g;
}

/**
 * Execute a Gremlin operation with automatic retry on auth errors.
 * Resets connection on 403/signature expired and retries once.
 */
export async function withRetry<T>(
  operation: (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    g: any
  ) => Promise<T>
): Promise<T> {
  try {
    const traversal = await getTraversal();
    return await operation(traversal);
  } catch (err: unknown) {
    const errMsg = String(
      (err as { statusMessage?: string }).statusMessage ||
        (err as Error).message ||
        ""
    );
    const statusCode = (err as { statusCode?: number }).statusCode;

    // Retry on SigV4 expiry or auth failure
    if (
      statusCode === 403 ||
      errMsg.includes("Signature expired") ||
      errMsg.includes("AccessDenied") ||
      errMsg.includes("security token")
    ) {
      console.warn("[Gremlin] Auth error detected, reconnecting:", errMsg.slice(0, 120));
      resetConnection();
      const traversal = await getTraversal();
      return await operation(traversal);
    }

    throw err;
  }
}

/**
 * Close the Gremlin connection (for graceful shutdown).
 */
export async function closeConnection(): Promise<void> {
  resetConnection();
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
