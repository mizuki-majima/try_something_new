/**
 * The single DynamoDB table, described as data. infra/ mirrors these names exactly;
 * createTableIfMissing is for local runs (dynalite) and tests only.
 */
import {
  CreateTableCommand,
  DescribeTableCommand,
  ResourceNotFoundException,
  type DynamoDBClient,
} from "@aws-sdk/client-dynamodb";

export const TABLE = {
  partitionKey: "pk",
  sortKey: "sk",
  ttlAttribute: "ttl",
  indexes: [
    { name: "gsi1", partitionKey: "gsi1pk", sortKey: "gsi1sk" },
    { name: "gsi2", partitionKey: "gsi2pk", sortKey: "gsi2sk" },
    { name: "gsi3", partitionKey: "gsi3pk", sortKey: "gsi3sk" },
  ],
} as const;

export const GSI1 = "gsi1";
export const GSI2 = "gsi2";
export const GSI3 = "gsi3";

export async function createTableIfMissing(client: DynamoDBClient, name: string): Promise<void> {
  try {
    await client.send(new DescribeTableCommand({ TableName: name }));
    return;
  } catch (err) {
    if (!(err instanceof ResourceNotFoundException) && (err as Error).name !== "ResourceNotFoundException") throw err;
  }
  const attrs = new Set<string>([TABLE.partitionKey, TABLE.sortKey]);
  for (const ix of TABLE.indexes) {
    attrs.add(ix.partitionKey);
    attrs.add(ix.sortKey);
  }
  await client.send(
    new CreateTableCommand({
      TableName: name,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [...attrs].map((a) => ({ AttributeName: a, AttributeType: "S" })),
      KeySchema: [
        { AttributeName: TABLE.partitionKey, KeyType: "HASH" },
        { AttributeName: TABLE.sortKey, KeyType: "RANGE" },
      ],
      GlobalSecondaryIndexes: TABLE.indexes.map((ix) => ({
        IndexName: ix.name,
        KeySchema: [
          { AttributeName: ix.partitionKey, KeyType: "HASH" },
          { AttributeName: ix.sortKey, KeyType: "RANGE" },
        ],
        Projection: { ProjectionType: "ALL" },
      })),
    }),
  );
  // dynalite keeps a table in CREATING for createTableMs; wait until it is usable.
  for (let i = 0; i < 50; i++) {
    const res = await client.send(new DescribeTableCommand({ TableName: name }));
    if (res.Table?.TableStatus === "ACTIVE") return;
    await new Promise((r) => setTimeout(r, 50));
  }
}
