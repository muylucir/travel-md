import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  ScanCommandInput,
  GetCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";

const TABLE_NAME = process.env.DYNAMODB_TABLE_NAME || "ota-planned-products";
const REGION = process.env.AWS_REGION || "ap-northeast-2";

const client = new DynamoDBClient({ region: REGION });
const docClient = DynamoDBDocumentClient.from(client);

export async function listProducts(limit = 20, region?: string) {
  const params: ScanCommandInput = {
    TableName: TABLE_NAME,
    Limit: limit,
  };

  if (region) {
    params.FilterExpression = "#r = :region";
    params.ExpressionAttributeNames = { "#r": "region" };
    params.ExpressionAttributeValues = { ":region": region };
  }

  const result = await docClient.send(new ScanCommand(params));
  return result.Items || [];
}

export async function getProduct(productCode: string) {
  const result = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { product_code: productCode },
    })
  );
  return result.Item || null;
}

export async function deleteProductById(productCode: string) {
  await docClient.send(
    new DeleteCommand({
      TableName: TABLE_NAME,
      Key: { product_code: productCode },
    })
  );
}
