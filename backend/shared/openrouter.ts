import { getSecret } from './auth';
import type { Logger } from './logger';
import { VALID_THOUGHT_TYPES, type ThoughtType } from './types';

/**
 * OpenRouter API client for text embeddings and LLM metadata extraction.
 * SEC-03: Errors logged without exposing response bodies (may contain PII).
 * SEC-12: API key loaded from SSM at runtime.
 */

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1';

async function openRouterRequest(
  path: string,
  body: unknown,
  logger: Logger,
): Promise<unknown> {
  const apiKey = await getSecret('/second-brain/openrouter-api-key');

  const response = await fetch(`${OPENROUTER_API_URL}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    logger.error('OpenRouter API error', { status: response.status, path });
    throw new Error(`OpenRouter API error: ${response.status}`);
  }

  return response.json();
}

/** Generate a 1536-dimension embedding vector for the given text. */
export async function embedText(
  text: string,
  logger: Logger,
): Promise<Float32Array> {
  const result = (await openRouterRequest(
    '/embeddings',
    { model: 'openai/text-embedding-3-small', input: text },
    logger,
  )) as { data: Array<{ embedding: number[] }> };

  if (!result.data?.[0]?.embedding) {
    throw new Error('No embedding returned from OpenRouter');
  }

  return new Float32Array(result.data[0].embedding);
}

/** Extract structured metadata from thought text via LLM. */
export async function extractMetadata(
  text: string,
  logger: Logger,
): Promise<{
  type: ThoughtType;
  topics: string[];
  people: string[];
  action_items: string[];
  dates: string[];
}> {
  const result = (await openRouterRequest(
    '/chat/completions',
    {
      model: 'openai/gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `Extract metadata from the following thought/note. Respond with ONLY valid JSON matching this schema:
{
  "type": "one of: idea, task, observation, question, reference, meeting, decision, person, needs_review",
  "topics": ["array of key topics/themes"],
  "people": ["array of people mentioned"],
  "action_items": ["array of action items if any"],
  "dates": ["array of dates mentioned in ISO 8601 format"]
}

Type guidelines:
- "task": actionable items with clear deliverables or deadlines
- "idea": creative thoughts, proposals, or brainstorming
- "observation": factual notes, records, or general information
- "question": open questions to revisit or research
- "reference": links, articles, resources, or external references
- "meeting": meeting notes, summaries, or outcomes
- "decision": records of decisions made
- "person": notes primarily about a specific person (feedback, preferences, background, relationships)
- "needs_review": message is too ambiguous, too short, or lacks enough context to confidently classify (bare URLs, single words, fragments, unclear intent)

If a field has no matches, use an empty array. Pick the single most appropriate type.`,
        },
        { role: 'user', content: text },
      ],
      temperature: 0,
      max_tokens: 500,
    },
    logger,
  )) as { choices: Array<{ message: { content: string } }> };

  const content = result.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('No metadata response from OpenRouter');
  }

  // SEC-13: Validate deserialized data — strip markdown fences if present
  const jsonStr = content.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  const parsed = JSON.parse(jsonStr) as Record<string, unknown>;

  // Defensive type coercion — LLM output is untrusted
  const rawType = typeof parsed.type === 'string' ? parsed.type : 'observation';
  return {
    type: VALID_THOUGHT_TYPES.includes(rawType as ThoughtType)
      ? (rawType as ThoughtType)
      : 'observation',
    topics: filterStrings(parsed.topics),
    people: filterStrings(parsed.people),
    action_items: filterStrings(parsed.action_items),
    dates: filterStrings(parsed.dates),
  };
}

function filterStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}
