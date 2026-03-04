import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  cosineSimilarity,
  embeddingToBuffer,
  bufferToEmbedding,
  searchByEmbedding,
  clearEmbeddingCache,
} from '../../backend/shared/vector';
import type { ThoughtRecord } from '../../backend/shared/types';

// --- Cosine similarity ---

describe('cosineSimilarity', () => {
  it('returns 1.0 for identical vectors', () => {
    const a = new Float32Array([1, 2, 3]);
    const sim = cosineSimilarity(a, a);
    expect(sim).toBeCloseTo(1.0, 5);
  });

  it('returns 0.0 for orthogonal vectors', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    const sim = cosineSimilarity(a, b);
    expect(sim).toBeCloseTo(0.0, 5);
  });

  it('returns -1.0 for opposite vectors', () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([-1, -2, -3]);
    const sim = cosineSimilarity(a, b);
    expect(sim).toBeCloseTo(-1.0, 5);
  });

  it('returns correct value for known vectors', () => {
    // cos(45 degrees) ~= 0.7071
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([1, 1]);
    const sim = cosineSimilarity(a, b);
    expect(sim).toBeCloseTo(1 / Math.sqrt(2), 4);
  });

  it('returns 0 for zero-length vector', () => {
    const a = new Float32Array([0, 0, 0]);
    const b = new Float32Array([1, 2, 3]);
    const sim = cosineSimilarity(a, b);
    expect(sim).toBe(0);
  });

  it('throws on length mismatch', () => {
    const a = new Float32Array([1, 2]);
    const b = new Float32Array([1, 2, 3]);
    expect(() => cosineSimilarity(a, b)).toThrow('Vector length mismatch');
  });

  it('handles large dimension vectors', () => {
    const dim = 1536;
    const a = new Float32Array(dim).fill(1);
    const b = new Float32Array(dim).fill(1);
    const sim = cosineSimilarity(a, b);
    expect(sim).toBeCloseTo(1.0, 4);
  });
});

// --- Buffer serialization ---

describe('embeddingToBuffer / bufferToEmbedding round-trip', () => {
  it('preserves values through serialization', () => {
    const original = new Float32Array([0.1, -0.5, 3.14, 0, -1e-6]);
    const buffer = embeddingToBuffer(original);
    const restored = bufferToEmbedding(new Uint8Array(buffer));

    expect(restored.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(restored[i]).toBeCloseTo(original[i], 5);
    }
  });

  it('produces a buffer of correct byte length', () => {
    const embedding = new Float32Array(1536);
    const buffer = embeddingToBuffer(embedding);
    // Float32 = 4 bytes per element
    expect(buffer.byteLength).toBe(1536 * 4);
  });
});

// --- Search with caching ---

describe('searchByEmbedding', () => {
  beforeEach(() => {
    clearEmbeddingCache();
  });

  function makeThought(id: string, embedding: Float32Array): ThoughtRecord {
    return {
      id,
      content: `Thought ${id}`,
      embedding,
      metadata: {
        type: 'note',
        topics: [],
        people: [],
        action_items: [],
        dates: [],
        source: 'slack' as const,
      },
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
    };
  }

  it('returns results sorted by similarity descending', async () => {
    const thoughts = [
      makeThought('a', new Float32Array([1, 0, 0])),
      makeThought('b', new Float32Array([0.9, 0.1, 0])),
      makeThought('c', new Float32Array([0, 1, 0])),
    ];
    const loadThoughts = vi.fn().mockResolvedValue(thoughts);
    const query = new Float32Array([1, 0, 0]);

    const results = await searchByEmbedding(query, 3, loadThoughts);

    expect(results.length).toBe(3);
    expect(results[0].thought.id).toBe('a'); // exact match
    expect(results[0].similarity).toBeCloseTo(1.0, 4);
    expect(results[1].thought.id).toBe('b'); // close match
    expect(results[2].thought.id).toBe('c'); // orthogonal
  });

  it('respects the limit parameter', async () => {
    const thoughts = [
      makeThought('1', new Float32Array([1, 0])),
      makeThought('2', new Float32Array([0.5, 0.5])),
      makeThought('3', new Float32Array([0, 1])),
    ];
    const loadThoughts = vi.fn().mockResolvedValue(thoughts);
    const query = new Float32Array([1, 0]);

    const results = await searchByEmbedding(query, 1, loadThoughts);
    expect(results.length).toBe(1);
    expect(results[0].thought.id).toBe('1');
  });

  it('uses cache on second call (loadThoughts called only once)', async () => {
    const thoughts = [makeThought('a', new Float32Array([1, 0]))];
    const loadThoughts = vi.fn().mockResolvedValue(thoughts);
    const query = new Float32Array([1, 0]);

    await searchByEmbedding(query, 10, loadThoughts);
    await searchByEmbedding(query, 10, loadThoughts);

    expect(loadThoughts).toHaveBeenCalledTimes(1);
  });

  it('refreshes cache after clearEmbeddingCache()', async () => {
    const thoughts = [makeThought('a', new Float32Array([1, 0]))];
    const loadThoughts = vi.fn().mockResolvedValue(thoughts);
    const query = new Float32Array([1, 0]);

    await searchByEmbedding(query, 10, loadThoughts);
    clearEmbeddingCache();
    await searchByEmbedding(query, 10, loadThoughts);

    expect(loadThoughts).toHaveBeenCalledTimes(2);
  });

  it('refreshes cache after TTL expires', async () => {
    const thoughts = [makeThought('a', new Float32Array([1, 0]))];
    const loadThoughts = vi.fn().mockResolvedValue(thoughts);
    const query = new Float32Array([1, 0]);

    // First call populates cache
    await searchByEmbedding(query, 10, loadThoughts);

    // Advance time past the 60s TTL
    vi.useFakeTimers();
    vi.advanceTimersByTime(61_000);

    await searchByEmbedding(query, 10, loadThoughts);
    expect(loadThoughts).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it('returns empty array for empty thought store', async () => {
    const loadThoughts = vi.fn().mockResolvedValue([]);
    const query = new Float32Array([1, 0]);

    const results = await searchByEmbedding(query, 10, loadThoughts);
    expect(results).toEqual([]);
  });
});
