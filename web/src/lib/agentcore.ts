/**
 * AgentCore Runtime invoke helper.
 *
 * Uses the `bedrock-agentcore` data-plane InvokeAgentRuntime API
 * with SigV4 signing.  The API body shape matches what the boto3
 * `invoke_agent_runtime` SDK call sends.
 */

import { SignatureV4 } from "@smithy/signature-v4";
import { Sha256 } from "@aws-crypto/sha256-js";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { HttpRequest } from "@smithy/protocol-http";

const REGION = process.env.AWS_REGION || "ap-northeast-2";
const AGENT_ARN =
  process.env.AGENTCORE_AGENT_ARN ||
  "arn:aws:bedrock-agentcore:ap-northeast-2:REDACTED_ACCOUNT_ID:runtime/REDACTED_TRAVEL_AGENT_ID";

/**
 * Invoke AgentCore Runtime and return the raw fetch Response.
 */
export async function invokeAgentCore(
  payload: Record<string, unknown>,
  sessionId?: string
): Promise<Response> {
  const hostname = `bedrock-agentcore.${REGION}.amazonaws.com`;
  // boto3 SDK sends to: /runtimes/{arn}/invocations?qualifier=DEFAULT
  // The ARN in the path is URL-encoded.
  const escapedArn = encodeURIComponent(AGENT_ARN);
  const path = `/runtimes/${escapedArn}/invocations`;

  // The SDK sends a JSON body with these exact fields:
  const body = JSON.stringify({
    agentRuntimeArn: AGENT_ARN,
    qualifier: "DEFAULT",
    runtimeSessionId: sessionId || crypto.randomUUID(),
    // payload must be a JSON **string**, not an object
    payload: JSON.stringify(payload),
    contentType: "application/json",
  });

  const request = new HttpRequest({
    method: "POST",
    protocol: "https:",
    hostname,
    path,
    query: { qualifier: "DEFAULT" },
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream, application/json",
      Host: hostname,
    },
    body,
  });

  const signer = new SignatureV4({
    credentials: defaultProvider(),
    region: REGION,
    service: "bedrock-agentcore",
    sha256: Sha256,
  });

  const signed = await signer.sign(request);

  const url = `https://${hostname}${path}?qualifier=DEFAULT`;
  return fetch(url, {
    method: "POST",
    headers: signed.headers as Record<string, string>,
    body,
  });
}
