import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  GetCommand,
  PutCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";

const TABLE_NAME = process.env.SCHEMA_TABLE_NAME || "graph-schemas";
const REGION = process.env.AWS_REGION || "ap-northeast-2";

const client = new DynamoDBClient({ region: REGION });
const docClient = DynamoDBDocumentClient.from(client);

export interface SchemaRecord {
  schemaId: string;
  name: string;
  description: string;
  nodeLabel: string;
  idField: string;
  properties: Array<{
    name: string;
    type: string;
    required: boolean;
  }>;
  edges: Array<{
    sourceField: string;
    targetNodeLabel: string;
    targetMatchProperty: string;
    edgeLabel: string;
    direction: string;
    autoCreateTarget: boolean;
  }>;
  createdAt: string;
  updatedAt: string;
}

export async function listSchemas(): Promise<SchemaRecord[]> {
  const result = await docClient.send(
    new ScanCommand({ TableName: TABLE_NAME })
  );
  return (result.Items as SchemaRecord[]) || [];
}

export async function getSchema(
  schemaId: string
): Promise<SchemaRecord | null> {
  const result = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { schemaId },
    })
  );
  return (result.Item as SchemaRecord) || null;
}

export async function putSchema(schema: SchemaRecord): Promise<void> {
  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: schema,
    })
  );
}

export async function deleteSchema(schemaId: string): Promise<void> {
  await docClient.send(
    new DeleteCommand({
      TableName: TABLE_NAME,
      Key: { schemaId },
    })
  );
}
