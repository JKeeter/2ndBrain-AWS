export type ThoughtType =
  | 'idea'
  | 'task'
  | 'observation'
  | 'question'
  | 'reference'
  | 'meeting'
  | 'decision'
  | 'person'
  | 'needs_review';

export const VALID_THOUGHT_TYPES: readonly ThoughtType[] = [
  'idea', 'task', 'observation', 'question', 'reference',
  'meeting', 'decision', 'person', 'needs_review',
] as const;

export interface ThoughtMetadata {
  type: ThoughtType;
  topics: string[];
  people: string[];
  action_items: string[];
  dates: string[];
  source: 'slack' | 'mcp';
}

export interface ThoughtRecord {
  id: string;
  content: string;
  embedding: Float32Array;
  metadata: ThoughtMetadata;
  created_at: string;
  updated_at: string;
  slack_channel?: string;
  slack_ts?: string;
}
