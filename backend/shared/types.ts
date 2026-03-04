export interface ThoughtMetadata {
  type: string;
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
