import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

export type Db = DynamoDBDocumentClient;

export type DbClientOptions = { region: string; endpoint?: string };

/** Low-level client (needed for table management). Local endpoints get dummy credentials. */
export function createDynamoClient({ region, endpoint }: DbClientOptions): DynamoDBClient {
  return new DynamoDBClient(
    endpoint
      ? { region, endpoint, credentials: { accessKeyId: "local", secretAccessKey: "local" } }
      : { region },
  );
}

export function createDocClient(opts: DbClientOptions | DynamoDBClient): Db {
  const client = opts instanceof DynamoDBClient ? opts : createDynamoClient(opts);
  return DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: false },
    unmarshallOptions: { wrapNumbers: false },
  });
}
