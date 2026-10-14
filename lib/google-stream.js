// Native Gemini transport at the existing PiAiAdapter stream seam. This uses
// DSH's converted transcript and replay metadata; no optional SDK dependency,
// host patch, Google credential or SDK-specific profile field is required.
import { createHash } from 'node:crypto';
import { modelPreset } from './model-presets.js';

const textOf = value => typeof value === 'string' ? value :
  (value ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
const sameModel = (message, model) => message.provider === model.provider && message.model === model.id && message.api === model.api;

export function googleRequest(model, context, options = {}) {
  const contents = [], systems = [], tools = new Map((context.tools ?? []).map(tool => [tool.name, tool]));
  if (context.systemPrompt) systems.push(context.systemPrompt);
  for (const message of context.messages) {
    if (message.role === 'system') {
      const text = textOf(message.content);if (text) systems.push(text);
      for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
      for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool);
      continue;
    }
    if (message.role === 'toolResult') {
      const text = textOf(message.content);
      const parts = [{ functionResponse: { name: message.toolName, id: message.toolCallId,
        response: message.isError ? { error: text } : { output: text } } }];
      // Gemini 3+ accepts images alongside a function response.
      for (const block of message.content ?? []) if (block.type === 'image') {
        parts[0].functionResponse.parts ??= [];
        parts[0].functionResponse.parts.push({ inlineData: { mimeType: block.mimeType, data: block.data } });
      }
      contents.push({ role: 'user', parts });
      continue;
    }
    const parts = [];
    if (typeof message.content === 'string') parts.push({ text: message.content });
    else for (const block of message.content ?? []) {
      const native = sameModel(message, model);
      if (block.type === 'image') parts.push({ inlineData: { mimeType: block.mimeType, data: block.data } });
      if (block.type === 'text') parts.push({ text: block.text,
        ...(native && block.textSignature ? { thoughtSignature: block.textSignature } : {}) });
      if (block.type === 'thinking' && (!block.redacted || native)) parts.push({ text: block.thinking,
        ...(native ? { thought: true } : {}),
        ...(native && block.thinkingSignature ? { thoughtSignature: block.thinkingSignature } : {}) });
      if (block.type === 'toolCall') parts.push({ functionCall: { name: block.name, args: block.arguments ?? {}, id: block.id },
        ...(native && block.thoughtSignature ? { thoughtSignature: block.thoughtSignature } : {}) });
    }
    if (parts.length) contents.push({ role: message.role === 'assistant' ? 'model' : 'user', parts });
  }
  const preset = modelPreset(model.id), effort = options.reasoning ?? preset.defaultEffort;
  const body = { contents, generationConfig: { maxOutputTokens: options.maxTokens ?? model.maxTokens,
    thinkingConfig: { includeThoughts: effort !== 'off',
      ...(effort === 'off' ? { thinkingBudget: 0 } : { thinkingLevel: effort.toUpperCase() }) } } };
  if (model.id !== 'gemini-4-argon' && options.temperature !== undefined) body.generationConfig.temperature = options.temperature;
  if (systems.length) body.systemInstruction = { parts: [{ text: systems.join('\n\n') }] };
  if (tools.size) body.tools = [{ functionDeclarations: [...tools.values()].map(tool => ({
    name: tool.name, description: tool.description, parametersJsonSchema: tool.parameters })) }];
  return body;
}

// Frames may straddle arbitrary UTF-8 / line boundaries. Cancellation stops
// reading the response as well as the in-flight fetch; no automatic retries.
async function* googleFrames(response, signal) {
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let pending = '';
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      let index;
      while ((index = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, index).trim();pending = pending.slice(index + 1);
        const data = line.startsWith('data:') ? line.slice(5).trim() : '';
        if (data && data !== '[DONE]') yield JSON.parse(data);
      }
      if (done) break;
      if (pending.length > 8 * 1024 * 1024) throw new Error('Gemini stream frame is too large');
    }
    const tail = pending.trim().startsWith('data:') ? pending.trim().slice(5).trim() : '';
    if (tail && tail !== '[DONE]') yield JSON.parse(tail);
  } finally { await reader.cancel().catch(() => {});reader.releaseLock(); }
}

export async function* streamGoogleNative(model, context, options = {}) {
  const output = { role: 'assistant', content: [], api: 'google-generative-ai', provider: model.provider, model: model.id,
    stopReason: 'pending', timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  let active = null, response;
  const index = () => output.content.length - 1;
  const closeBlock = () => {
    if (!active) return undefined;
    const event = { type: active.type === 'thinking' ? 'thinking_end' : 'text_end', contentIndex: index(),
      content: active.type === 'thinking' ? active.thinking : active.text, partial: output };
    active = null;return event;
  };
  try {
    const base = new URL(model.baseUrl);
    if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1') throw new Error('Gemini native bridge requires the local Factory gateway');
    const url = `${model.baseUrl.replace(/\/+$/, '')}/models/${encodeURIComponent(model.id)}:streamGenerateContent?alt=sse`;
    response = await fetch(url, { method: 'POST', headers: { ...model.headers, ...options.headers, 'content-type': 'application/json' },
      body: JSON.stringify(googleRequest(model, context, options)), signal: options.signal });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`${response.status} ${body.slice(0, 8192)}`);
    }
    if (!response.body) throw new Error('Gemini stream ended without a response body');
    yield { type: 'start', partial: output };
    for await (const frame of googleFrames(response, options.signal)) {
      if (frame.error) throw new Error(`${frame.error.code ?? ''} ${frame.error.message ?? 'Gemini upstream error'}`);
      output.responseId ||= frame.responseId;
      const candidate = frame.candidates?.[0];
      for (const part of candidate?.content?.parts ?? []) {
        if (part.text !== undefined || part.thoughtSignature && !part.functionCall) {
          const type = part.thought === true ? 'thinking' : 'text';
          const signature = type === 'thinking' ? 'thinkingSignature' : 'textSignature';
          if (!active || active.type !== type || part.thoughtSignature && active[signature] && active[signature] !== part.thoughtSignature) {
            const end = closeBlock();if (end) yield end;
            active = type === 'thinking' ? { type, thinking: '' } : { type, text: '' };
            output.content.push(active);yield { type: `${type}_start`, contentIndex: index(), partial: output };
          }
          const delta = part.text ?? '';
          active[type === 'thinking' ? 'thinking' : 'text'] += delta;
          if (part.thoughtSignature) active[signature] = part.thoughtSignature;
          if (delta) yield { type: `${type}_delta`, contentIndex: index(), delta, partial: output };
        }
        if (part.functionCall) {
          const end = closeBlock();if (end) yield end;
          const call = part.functionCall;
          const id = call.id ?? `tc-${createHash('sha256').update(JSON.stringify([call.name, call.args, context.messages.length, output.content.length])).digest('hex').slice(0, 40)}`;
          const toolCall = { type: 'toolCall', id, name: call.name, arguments: call.args ?? {},
            ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}) };
          output.content.push(toolCall);
          yield { type: 'toolcall_start', contentIndex: index(), partial: output };
          yield { type: 'toolcall_delta', contentIndex: index(), delta: JSON.stringify(toolCall.arguments), partial: output };
          yield { type: 'toolcall_end', contentIndex: index(), toolCall, partial: output };
        }
      }
      if (frame.usageMetadata) {
        const u = frame.usageMetadata;
        output.usage = { ...output.usage, input: Math.max(0, (u.promptTokenCount ?? 0) - (u.cachedContentTokenCount ?? 0)),
          output: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0), cacheRead: u.cachedContentTokenCount ?? 0,
          totalTokens: u.totalTokenCount ?? 0 };
      }
      if (candidate?.finishReason) {
        output.rawStopReason = candidate.finishReason;
        output.stopReason = candidate.finishReason === 'MAX_TOKENS' ? 'length' : candidate.finishReason === 'STOP' ?
          output.content.some(block => block.type === 'toolCall') ? 'toolUse' : 'stop' : 'error';
      }
      if (frame.promptFeedback?.blockReason) throw new Error(`Gemini blocked request: ${frame.promptFeedback.blockReason}`);
    }
    const end = closeBlock();if (end) yield end;
    if (output.stopReason === 'pending') throw new Error('Gemini stream ended without a finish reason');
    if (output.stopReason === 'error') throw new Error(`Gemini stopped with ${output.rawStopReason}`);
    yield { type: 'done', reason: output.stopReason, message: output };
  } catch (error) {
    const end = closeBlock();if (end) yield end;
    output.stopReason = options.signal?.aborted ? 'aborted' : 'error';output.errorMessage = error.message;
    yield { type: 'error', reason: output.stopReason, error: output };
  } finally { await response?.body?.cancel().catch(() => {}); }
}
