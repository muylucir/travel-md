/**
 * schema-converter.ts
 *
 * Converts JSON Schema tool definitions (as stored in schemas/*.json) into
 * the CDK CfnGatewayTarget.ToolDefinitionProperty / SchemaDefinitionProperty
 * shape expected by AWS::BedrockAgentCore::GatewayTarget inline payloads.
 */

import * as fs from "fs";
import * as path from "path";
import type { CfnGatewayTarget } from "aws-cdk-lib/aws-bedrockagentcore";

// ── Raw JSON types (what we read from the schema files) ──────────

interface RawSchemaProperty {
  type: string;
  description?: string;
  properties?: Record<string, RawSchemaProperty>;
  required?: string[];
  items?: RawSchemaProperty;
}

interface RawToolDefinition {
  name: string;
  description: string;
  inputSchema: RawSchemaProperty;
}

// ── Converter ────────────────────────────────────────────────────

/**
 * Recursively converts a raw JSON Schema object into the CDK
 * `SchemaDefinitionProperty` shape.
 */
function convertSchema(
  raw: RawSchemaProperty
): CfnGatewayTarget.SchemaDefinitionProperty {
  const result: CfnGatewayTarget.SchemaDefinitionProperty = {
    type: raw.type,
    ...(raw.description ? { description: raw.description } : {}),
    ...(raw.required && raw.required.length > 0
      ? { required: raw.required }
      : {}),
  };

  if (raw.properties) {
    const converted: Record<
      string,
      CfnGatewayTarget.SchemaDefinitionProperty
    > = {};
    for (const [key, value] of Object.entries(raw.properties)) {
      converted[key] = convertSchema(value);
    }
    (result as any).properties = converted;
  }

  if (raw.items) {
    (result as any).items = convertSchema(raw.items);
  }

  return result;
}

/**
 * Loads a tool schema JSON file and returns an array of
 * `CfnGatewayTarget.ToolDefinitionProperty` objects suitable for
 * `toolSchema.inlinePayload`.
 *
 * @param filePath Absolute or relative path to the JSON schema file.
 *                 Relative paths are resolved from the CDK project root.
 */
export function loadToolSchemas(
  filePath: string
): CfnGatewayTarget.ToolDefinitionProperty[] {
  const resolved = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(__dirname, "../..", filePath);

  const raw: RawToolDefinition[] = JSON.parse(
    fs.readFileSync(resolved, "utf-8")
  );

  return raw.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: convertSchema(tool.inputSchema),
  }));
}
