import type { ThoughtRecord } from './types';

/**
 * Cosine similarity, Float32Array ↔ Buffer conversion, and in-memory
 * embedding cache for warm Lambda containers (60s TTL).
 */

// --- Embedding serialization (Float32Array ↔ DynamoDB Binary) ---

export function embeddingToBuffer(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

export function bufferToEmbedding(data: Uint8Array): Float32Array {
  return new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4);
}

// --- Cosine similarity ---

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`Vector length mismatch: ${a.length} vs ${b.length}`);
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}

// --- In-memory embedding cache ---

let embeddingCache: { items: ThoughtRecord[]; loadedAt: number } | null = null;
const CACHE_TTL_MS = 60_000; // 60 seconds

export interface SearchResult {
  thought: ThoughtRecord;
  similarity: number;
}

/**
 * Brute-force cosine similarity search against all stored embeddings.
 * Uses a module-level cache with 60s TTL for warm Lambda containers.
 *
 * @param queryEmbedding - The query vector to compare against.
 * @param limit - Maximum number of results to return.
 * @param loadThoughts - Callback to load all thoughts from DynamoDB (dependency injection to avoid circular imports).
 */
export async function searchByEmbedding(
  queryEmbedding: Float32Array,
  limit: number,
  loadThoughts: () => Promise<ThoughtRecord[]>,
): Promise<SearchResult[]> {
  const now = Date.now();
  if (!embeddingCache || now - embeddingCache.loadedAt > CACHE_TTL_MS) {
    embeddingCache = { items: await loadThoughts(), loadedAt: now };
  }

  const scored = embeddingCache.items.map((thought) => ({
    thought,
    similarity: cosineSimilarity(queryEmbedding, thought.embedding),
  }));

  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, limit);
}

/** Clear the embedding cache (after writes or for testing). */
export function clearEmbeddingCache(): void {
  embeddingCache = null;
}
