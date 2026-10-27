// Factory can stream Gemini function arguments before a large call is fully
// generated. DSH's Google adapter expects one complete args object per call.
// Assemble only that part of the protocol; retain text, usage and signatures.
// https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/tools/function-calling

const MAX_FRAME_CHARS = 8 * 1024 * 1024;
const MAX_CALL_CHARS = 32 * 1024 * 1024;
const own = (obj, key) => Object.hasOwn(obj, key);
const invalid = () => new Error('Factory Gemini: invalid or incomplete streamed function arguments');

export function enableGeminiArgumentStreaming(payload) {
  if (payload.model !== 'gemini-4-argon' ||
      !payload.tools?.some(tool => tool.functionDeclarations?.length)) return;
  const config = payload.toolConfig ??= {};
  const calls = config.functionCallingConfig ??= {};
  if (calls.mode !== 'NONE' && calls.streamFunctionCallArguments === undefined) {
    calls.streamFunctionCallArguments = true;
  }
}

// A single concrete JSONPath, never an expression or a wildcard. Quoted keys
// and own-property writes preserve arbitrary JSON keys without eval/prototypes.
function argumentPath(input) {
  if (typeof input !== 'string' || input[0] !== '$') throw invalid();
  let pos = 1, arrayEnd = false;
  const path = [];
  while (pos < input.length) {
    if (path.length >= 64) throw invalid();
    if (input[pos] === '.') {
      const start = ++pos;
      while (pos < input.length && !'.[]'.includes(input[pos])) pos++;
      const key = input.slice(start, pos);
      if (!key || key === '*') throw invalid();
      path.push(key);
    } else if (input[pos] === '[') {
      pos++;
      if (input[pos] === ']') {
        pos++;
        if (pos !== input.length) throw invalid();
        arrayEnd = true;
      } else if (input[pos] === '"' || input[pos] === "'") {
        const quote = input[pos++];
        let key = '', closed = false;
        while (pos < input.length) {
          const c = input[pos++];
          if (c === quote) { closed = true; break; }
          if (c !== '\\') { key += c; continue; }
          const escape = input[pos++];
          if (escape === 'u') {
            const hex = input.slice(pos, pos + 4);
            if (!/^[a-f0-9]{4}$/i.test(hex)) throw invalid();
            key += String.fromCharCode(parseInt(hex, 16)); pos += 4;
          } else {
            const escapes = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', '/': '/', '\\': '\\', '"': '"', "'": "'" };
            if (!own(escapes, escape)) throw invalid();
            key += escapes[escape];
          }
        }
        if (!closed || input[pos++] !== ']') throw invalid();
        path.push(key);
      } else {
        const match = /^(0|[1-9]\d*)\]/.exec(input.slice(pos));
        if (!match || Number(match[1]) > 100000) throw invalid();
        path.push(Number(match[1])); pos += match[0].length;
      }
    } else throw invalid();
  }
  return { path, arrayEnd };
}

function setOwn(obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

function applyArgument(state, fragment) {
  const { path, arrayEnd } = argumentPath(fragment.jsonPath);
  const valueKeys = ['stringValue', 'numberValue', 'boolValue', 'nullValue'].filter(k => own(fragment, k));
  if (valueKeys.length > 1 || (arrayEnd && valueKeys.length)) throw invalid();
  if (!path.length) {
    if (valueKeys.length || arrayEnd) throw invalid();
    return; // End of the root object.
  }
  let target = state.args;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i], isArray = typeof path[i + 1] === 'number';
    if ((typeof key === 'number') !== Array.isArray(target)) throw invalid();
    if (!own(target, key)) setOwn(target, key, isArray ? [] : Object.create(null));
    target = target[key];
    if (!target || typeof target !== 'object' || Array.isArray(target) !== isArray) throw invalid();
  }
  const key = path.at(-1), pathKey = JSON.stringify(path);
  if ((typeof key === 'number') !== Array.isArray(target)) throw invalid();
  const previous = own(target, key) ? target[key] : undefined;
  if (!valueKeys.length) {
    if (arrayEnd) {
      if (previous === undefined) setOwn(target, key, []);
      else if (!Array.isArray(previous)) throw invalid();
    } else if (previous === undefined) {
      setOwn(target, key, Object.create(null));
    }
    if (fragment.willContinue !== true) state.strings.delete(pathKey);
    return;
  }
  const type = valueKeys[0];
  let value = type === 'nullValue' ? null : fragment[type];
  if ((type === 'stringValue' && typeof value !== 'string') ||
      (type === 'numberValue' && (typeof value !== 'number' || !Number.isFinite(value))) ||
      (type === 'boolValue' && typeof value !== 'boolean')) throw invalid();
  state.size += typeof value === 'string' ? value.length : 16;
  if (state.size > MAX_CALL_CHARS) throw invalid();
  if (state.strings.has(pathKey)) {
    if (type !== 'stringValue' || typeof previous !== 'string') throw invalid();
    value = previous + value;
  }
  setOwn(target, key, value);
  if (fragment.willContinue === true) {
    if (type !== 'stringValue') throw invalid();
    state.strings.add(pathKey);
  } else state.strings.delete(pathKey);
}

function createAssembler() {
  const pending = new Map();
  function accept(frame) {
    if (!Array.isArray(frame?.candidates)) return frame;
    for (const [index, candidate] of frame.candidates.entries()) {
      const key = candidate.index ?? index;
      const parts = candidate.content?.parts;
      if (!Array.isArray(parts)) {
        if (candidate.finishReason && pending.has(key)) throw invalid();
        continue;
      }
      const output = [];
      for (const part of parts) {
        const call = part.functionCall;
        if (!call) { output.push(part); continue; }
        let state = pending.get(key);
        const fragmented = state || own(call, 'partialArgs') || own(call, 'willContinue');
        if (!fragmented) {
          if (!call.name) throw invalid();
          output.push(part); continue;
        }
        if (own(call, 'args')) throw invalid();
        if (!state) {
          state = { args: Object.create(null), part: {}, name: call.name, id: call.id, strings: new Set(), size: 0 };
          pending.set(key, state);
        } else {
          if ((call.name && state.name && call.name !== state.name) || (call.id && state.id && call.id !== state.id)) throw invalid();
          state.name ??= call.name; state.id ??= call.id;
        }
        for (const [name, value] of Object.entries(part)) if (name !== 'functionCall') setOwn(state.part, name, value);
        if (call.partialArgs !== undefined && !Array.isArray(call.partialArgs)) throw invalid();
        for (const fragment of call.partialArgs ?? []) applyArgument(state, fragment);
        if (call.willContinue !== true) {
          if (!state.name || state.strings.size) throw invalid();
          output.push({ ...state.part, functionCall: { name: state.name,
            ...(state.id === undefined ? {} : { id: state.id }), args: state.args } });
          pending.delete(key);
        }
      }
      if (candidate.finishReason && pending.has(key)) throw invalid();
      // Empty text is a real SDK event with no visible content. It preserves
      // stream activity during a long call; SSE comments alone do not reset
      // pi-ai's event watchdog. Never expose an unfinished functionCall.
      candidate.content.parts = output.length ? output : [{ text: '' }];
    }
    return frame;
  }
  return { accept, finish() { if (pending.size) throw invalid(); } };
}

export function adaptGeminiArgumentStream(response) {
  if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream')) return response;
  const assembler = createAssembler(), decoder = new TextDecoder(), encoder = new TextEncoder();
  let buffer = '';
  function emit(raw, controller) {
    const data = raw.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data || data.trim() === '[DONE]') {
      if (data) assembler.finish();
      controller.enqueue(encoder.encode(raw + '\n\n')); return;
    }
    let frame;
    try { frame = JSON.parse(data); } catch { throw invalid(); }
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(assembler.accept(frame))}\n\n`));
  }
  function drain(controller) {
    let match;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      if (match.index > MAX_FRAME_CHARS) throw invalid();
      const raw = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      emit(raw, controller);
    }
    if (buffer.length > MAX_FRAME_CHARS) throw invalid();
  }
  const body = response.body.pipeThrough(new TransformStream({
    transform(chunk, controller) { buffer += decoder.decode(chunk, { stream: true }); drain(controller); },
    flush(controller) {
      buffer += decoder.decode(); drain(controller);
      if (buffer.trim()) emit(buffer, controller);
      assembler.finish();
    },
  }));
  const headers = new Headers(response.headers);
  // fetch has already decompressed the source, and this changes its byte size.
  headers.delete('content-length'); headers.delete('content-encoding');
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}
