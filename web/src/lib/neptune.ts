/**
 * Neptune OpenCypher client for Next.js API routes.
 *
 * Uses @aws-sdk/client-neptunedata over HTTPS.
 * Stateless — no persistent WebSocket connections, no SigV4 rotation needed.
 */

import {
  NeptunedataClient,
  ExecuteOpenCypherQueryCommand,
} from "@aws-sdk/client-neptunedata";

const NEPTUNE_HOST =
  process.env.NEPTUNE_HOST || "REDACTED_NEPTUNE_HOST";
const NEPTUNE_PORT = process.env.NEPTUNE_PORT || "8182";
const NEPTUNE_REGION = process.env.AWS_REGION || "ap-northeast-2";

const client = new NeptunedataClient({
  endpoint: `https://${NEPTUNE_HOST}:${NEPTUNE_PORT}`,
  region: NEPTUNE_REGION,
});

/**
 * Execute an OpenCypher query and return the results array.
 */
export async function executeQuery<T = Record<string, unknown>>(
  query: string,
  parameters?: Record<string, unknown>
): Promise<T[]> {
  const command = new ExecuteOpenCypherQueryCommand({
    openCypherQuery: query,
    parameters: parameters ? JSON.stringify(parameters) : undefined,
  });
  const response = await client.send(command);
  return ((response.results as T[]) ?? []);
}

/**
 * Extract node properties from an OpenCypher result row.
 *
 * Neptune returns nodes as:
 *   {"key": {"~id": "...", "~label": "...", "~properties": {...}}}
 * This normalizes into a flat object with 'id' and 'label' fields.
 */
export function extractNode(
  row: Record<string, unknown>,
  key: string
): Record<string, unknown> {
  const node = row[key];
  if (node && typeof node === "object" && !Array.isArray(node)) {
    const n = node as Record<string, unknown>;
    if ("~properties" in n) {
      const props = { ...(n["~properties"] as Record<string, unknown>) };
      props.id = n["~id"] ?? "";
      props.label = n["~label"] ?? "";
      return props;
    }
    return { ...n };
  }
  return { value: node };
}

/**
 * Convert an extracted node into the graph visualization format.
 */
export function toGraphNode(props: Record<string, unknown>) {
  const id = String(props.id ?? "");
  const nodeLabel = String(props.name ?? props.code ?? id);
  const type = String(props.label ?? "unknown");

  const properties: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if (k !== "id" && k !== "label") {
      properties[k] = v;
    }
  }

  return { id, label: nodeLabel, type, properties };
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
