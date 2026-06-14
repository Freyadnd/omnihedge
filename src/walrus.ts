const PUBLISHER = 'https://publisher.walrus-testnet.walrus.space';
const AGGREGATOR = 'https://aggregator.walrus-testnet.walrus.space';
const EPOCHS = 5;

interface WalrusStoreResponse {
  newlyCreated?: {
    blobObject: {
      blobId: string;
      id: string;
      storedEpoch: number;
      size: string;
    };
    resourceOperation: unknown;
    cost: number;
  };
  alreadyCertified?: {
    blobId: string;
    eventOrObject: unknown;
    endEpoch: number;
  };
}

/**
 * Store a JSON-serialisable value as a Walrus blob.
 * Returns the blob ID (used to retrieve later via fetchBlob).
 */
export async function storeBlob(data: unknown): Promise<string> {
  const body = JSON.stringify(data);

  const res = await fetch(`${PUBLISHER}/v1/blobs?epochs=${EPOCHS}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Walrus store failed (${res.status}): ${text.slice(0, 200)}`);
  }

  const json = (await res.json()) as WalrusStoreResponse;

  if (json.newlyCreated) return json.newlyCreated.blobObject.blobId;
  if (json.alreadyCertified) return json.alreadyCertified.blobId;

  throw new Error(`Walrus: unexpected response — ${JSON.stringify(json).slice(0, 200)}`);
}

/**
 * Retrieve a previously stored blob by ID.
 */
export async function fetchBlob<T>(blobId: string): Promise<T> {
  const res = await fetch(`${AGGREGATOR}/v1/blobs/${blobId}`);

  if (!res.ok) {
    throw new Error(`Walrus fetch failed (${res.status}) for blob ${blobId}`);
  }

  return res.json() as Promise<T>;
}

/** Public URL to view / share a blob */
export function blobUrl(blobId: string): string {
  return `${AGGREGATOR}/v1/blobs/${blobId}`;
}
