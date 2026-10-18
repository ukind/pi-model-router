import type { Context, Message } from '@earendil-works/pi-ai';
import { extractTextFromContent } from './routing';

/**
 * Heuristic token estimator (conservative: 3 characters per token).
 * F016: documented approximation — the registry does not expose a
 * tokenizer or chars-per-token, so a conservative chars-per-token ratio
 * is the best available estimate. 3 chars/token is below the typical 4,
 * which makes the estimate pessimistic and truncation eager.
 */
export const estimateTokens = (text: string): number =>
  Math.ceil(text.length / 3);

const extractToolCallIds = (msg: Message): string[] => {
  if (!Array.isArray(msg.content)) return [];
  return msg.content
    .filter((p) => p.type === 'toolCall' && 'id' in p && p.id)
    .map((p) => (p as { id: string }).id);
};

/**
 * Truncate context to fit within a target token limit by removing the
 * oldest evictable messages. Always preserves the first message (the
 * conversation anchor) and the latest user message (found by role, F017).
 * toolCall/toolResult pairs are evicted together so partial tool chains
 * never survive. Best effort: if only protected messages remain and the
 * total still exceeds the limit, the protected set is returned as-is.
 */
export const truncateContext = (context: Context, limit: number): Context => {
  const messages = [...context.messages];
  if (messages.length <= 1) return context;

  const getSystemTokens = () =>
    context.systemPrompt ? estimateTokens(context.systemPrompt) : 0;

  const totalTokens =
    getSystemTokens() +
    messages.reduce(
      (sum, m) => sum + estimateTokens(extractTextFromContent(m.content)),
      0,
    );
  if (totalTokens <= limit) return context;

  // F017: protect the first message and the last USER message by role.
  const firstMessage = messages[0];
  let lastUserMessage: Message | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      lastUserMessage = messages[i];
      break;
    }
  }
  if (!lastUserMessage) return context;

  const isProtected = (msg: Message): boolean =>
    msg === firstMessage || msg === lastUserMessage;

  const computeTokens = () =>
    getSystemTokens() +
    messages.reduce(
      (sum, m) => sum + estimateTokens(extractTextFromContent(m.content)),
      0,
    );

  // Remove oldest evictable messages until it fits or only protected
  // messages remain.
  while (computeTokens() > limit) {
    const evictIndex = messages.findIndex((m) => !isProtected(m));
    if (evictIndex === -1) break;
    const [evicted] = messages.splice(evictIndex, 1);
    const toolCallIds = new Set(extractToolCallIds(evicted));
    if (toolCallIds.size > 0) {
      // Remove linked toolResult messages so pairs stay together.
      for (let j = messages.length - 1; j >= 0; j--) {
        const msg = messages[j];
        if (isProtected(msg)) continue;
        if (
          msg.role === 'toolResult' &&
          'toolCallId' in msg &&
          toolCallIds.has((msg as { toolCallId: string }).toolCallId)
        ) {
          messages.splice(j, 1);
        }
      }
    }
  }

  return { ...context, messages };
};
