import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

export type Db = DynamoDBDocumentClient;

export type DbClientOptions = { region: string; endpoint?: string };

/**
 * Attempts per request on AWS. The table's on-demand throughput is capped as a cost circuit breaker
 * (infra: maxWriteRequestUnits / maxReadRequestUnits), so a legitimate burst (an import writes 10
 * items at a time) can be throttled for a moment: retrying with backoff (standard mode: about 0.5,
 * 1, 2, 4 s) turns that into a slower request instead of a 500. Throttled requests are not billed.
 */
export const DYNAMO_MAX_ATTEMPTS = 5;

/** Low-level client (needed for table management). Local endpoints get dummy credentials. */
export function createDynamoClient({ region, endpoint }: DbClientOptions): DynamoDBClient {
  return new DynamoDBClient(
    endpoint
      ? { region, endpoint, credentials: { accessKeyId: "local", secretAccessKey: "local" } }
      : { region, maxAttempts: DYNAMO_MAX_ATTEMPTS },
  );
}

export function createDocClient(opts: DbClientOptions | DynamoDBClient): Db {
  const client = opts instanceof DynamoDBClient ? opts : createDynamoClient(opts);
  return DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: false },
    unmarshallOptions: { wrapNumbers: false },
  });
}
