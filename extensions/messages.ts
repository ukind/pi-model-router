import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
} from '@earendil-works/pi-ai';

export const createErrorMessage = (
  model: Model<Api>,
  message: string,
): AssistantMessage => {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'error',
    errorMessage: message,
    timestamp: Date.now(),
  };
};

export const createAbortedMessage = (model: Model<Api>): AssistantMessage => {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'aborted',
    timestamp: Date.now(),
  };
};

export const pushAbortedEnd = (
  stream: AssistantMessageEventStream,
  model: Model<Api>,
): void => {
  // Push BEFORE end(): a done/error event — not a bare end() — is what
  // resolves pi's response.result() (event-stream.js isComplete). Bare
  // end() parks agent-loop.js:238 forever ("Working..." wedge).
  stream.push({
    type: 'error',
    reason: 'aborted',
    error: createAbortedMessage(model),
  });
  stream.end();
};
