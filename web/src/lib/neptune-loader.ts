/**
 * Neptune Bulk Loader: S3 upload + Loader API.
 *
 * Requires:
 *   NEPTUNE_HOST, NEPTUNE_PORT (8182)
 *   BULK_LOAD_S3_BUCKET — S3 bucket for staging CSVs
 *   NEPTUNE_LOAD_IAM_ROLE — IAM role ARN for Neptune to read S3
 */

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
// @ts-expect-error -- no type declarations for aws4
import aws4 from "aws4";

const NEPTUNE_HOST = process.env.NEPTUNE_HOST || "";
const NEPTUNE_PORT = process.env.NEPTUNE_PORT || "8182";
const S3_BUCKET = process.env.BULK_LOAD_S3_BUCKET || "";
const NEPTUNE_LOAD_ROLE = process.env.NEPTUNE_LOAD_IAM_ROLE || "";
const REGION = process.env.AWS_REGION || "ap-northeast-2";

async function signedFetch(
  path: string,
  method: string,
  body?: string
): Promise<Response> {
  const creds = await fromNodeProviderChain()();

  const opts: Record<string, unknown> = {
    host: NEPTUNE_HOST,
    port: parseInt(NEPTUNE_PORT),
    path,
    method,
    service: "neptune-db",
    region: REGION,
    headers: body ? { "Content-Type": "application/json" } : {},
  };
  if (body) opts.body = body;

  const signed = aws4.sign(opts, {
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    sessionToken: creds.sessionToken,
  });

  return fetch(`https://${NEPTUNE_HOST}:${NEPTUNE_PORT}${path}`, {
    method,
    headers: signed.headers,
    body,
  });
}

/**
 * Upload CSV files to S3 for Neptune Bulk Loader.
 */
export async function uploadCsvToS3(
  jobId: string,
  nodesCsv: string,
  edgesCsv: string
): Promise<string> {
  if (!S3_BUCKET) {
    throw new Error("BULK_LOAD_S3_BUCKET 환경변수가 설정되지 않았습니다.");
  }

  const s3 = new S3Client({ region: REGION });
  const prefix = `graph-upload/${jobId}`;

  await s3.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: `${prefix}/nodes.csv`,
      Body: nodesCsv,
      ContentType: "text/csv",
    })
  );

  if (edgesCsv.split("\n").length > 1) {
    // Only upload edges if there's data beyond the header
    await s3.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: `${prefix}/edges.csv`,
        Body: edgesCsv,
        ContentType: "text/csv",
      })
    );
  }

  return `s3://${S3_BUCKET}/${prefix}/`;
}

/**
 * Trigger Neptune Bulk Loader.
 */
export async function triggerLoad(s3Source: string): Promise<{
  loadId: string;
  status: string;
}> {
  if (!NEPTUNE_HOST) throw new Error("NEPTUNE_HOST가 설정되지 않았습니다.");
  if (!NEPTUNE_LOAD_ROLE)
    throw new Error("NEPTUNE_LOAD_IAM_ROLE이 설정되지 않았습니다.");

  const body = JSON.stringify({
    source: s3Source,
    format: "csv",
    iamRoleArn: NEPTUNE_LOAD_ROLE,
    region: REGION,
    failOnError: "FALSE",
    parallelism: "HIGH",
    updateSingleCardinalityProperties: "TRUE",
    queueRequest: "TRUE",
  });

  const res = await signedFetch("/loader", "POST", body);
  const data = await res.json();

  if (!res.ok) {
    throw new Error(
      `Neptune Loader 오류 (${res.status}): ${JSON.stringify(data)}`
    );
  }

  return {
    loadId: data.payload?.loadId || "",
    status: data.status || "UNKNOWN",
  };
}

/**
 * Check Neptune Bulk Loader status.
 */
export async function getLoadStatus(loadId: string): Promise<{
  status: string;
  totalRecords: number;
  totalDuplicates: number;
  totalTimeMillis: number;
  errors: string[];
  overallStatus: {
    fullUri: string;
    runNumber: number;
    retryNumber: number;
    status: string;
    totalTimeSpent: number;
    startTime: number;
    totalRecords: number;
    totalDuplicates: number;
    parsingErrors: number;
    datatypeMismatchErrors: number;
    insertErrors: number;
  } | null;
}> {
  const res = await signedFetch(
    `/loader/${loadId}?details=true&errors=true`,
    "GET"
  );
  const data = await res.json();

  const overall = data.payload?.overallStatus || null;
  const errors: string[] = [];

  // Extract errors from feedCount if present
  if (data.payload?.failedFeeds) {
    for (const feed of data.payload.failedFeeds) {
      errors.push(`${feed.fullUri}: ${feed.error || "Unknown error"}`);
    }
  }

  return {
    status: overall?.status || data.payload?.overallStatus?.status || "UNKNOWN",
    totalRecords: overall?.totalRecords || 0,
    totalDuplicates: overall?.totalDuplicates || 0,
    totalTimeMillis: overall?.totalTimeSpent || 0,
    errors,
    overallStatus: overall,
  };
}

/**
 * Check if bulk loader is available (env vars configured).
 */
export function isBulkLoaderAvailable(): boolean {
  return Boolean(NEPTUNE_HOST && S3_BUCKET && NEPTUNE_LOAD_ROLE);
}
