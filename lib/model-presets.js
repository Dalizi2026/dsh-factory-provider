// Public model metadata extracted from Droid CLI 0.241.0; no account state.
import { readFileSync } from "node:fs";
import { Transform, Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

const presets = JSON.parse(readFileSync(new URL("./model-presets-data.json", import.meta.url), "utf8"));
export const modelPreset = id => presets[id];

export function modelMultiplier(id, now = Date.now()) {
  const preset = presets[id];
  const discount = preset.promotions.find(p => now >= Date.parse(p.startsAt) && now < Date.parse(p.expiresAt))?.discount ?? 0;
  return Number((preset.tokenMultiplier * (1 - discount)).toFixed(6));
}

/** Missing parameters use the CLI default; explicit user choices always win. */
export function applyModelDefaults(route, parsed) {
  const preset = presets[parsed?.model];
  if (!preset) return;
  if (route === "anthropic") {
    if (parsed.model === "claude-haiku-5-5" && !parsed.thinking) parsed.thinking = { type: "adaptive" };
    if (parsed.model === "claude-haiku-5-5" && parsed.thinking?.type === "adaptive" && !parsed.output_config?.effort) {
      parsed.output_config = { ...parsed.output_config, effort: preset.defaultEffort };
    }
  } else if (route === "openai" || route === "xai") {
    if (!parsed.reasoning?.effort) parsed.reasoning = { ...parsed.reasoning, effort: preset.defaultEffort };
    if (route === "xai") {
      // These are OpenAI-specific options, not part of Droid's xAI request.
      for (const key of ["prompt_cache_retention", "prompt_cache_key", "safety_identifier", "service_tier"]) delete parsed[key];
    }
  } else if (route === "google") {
    // The native Google path is normalized separately without an OpenAI conversion.
    return;
  } else {
    parsed.reasoning_effort ??= preset.defaultEffort;
    if (parsed.model.startsWith("mistral-")) {
      // Droid's US(): Mistral replays reasoning as content parts, not a
      // reasoning_content field. Preserve tool calls and existing text/images.
      parsed.messages = parsed.messages?.map(message => {
        if (message.role !== "assistant") return message;
        const { reasoning_content, reasoning, ...rest } = message;
        const text = reasoning_content || reasoning;
        if (typeof text !== "string" || !text) return message;
        const content = typeof rest.content === "string"
          ? rest.content ? [{ type: "text", text: rest.content }] : [] : rest.content ?? [];
        return { ...rest, content: [{ type: "thinking", thinking: [{ type: "text", text }] }, ...content] };
      });
    }
  }
}

function mistralChunk(chunk) {
  for (const choice of chunk?.choices ?? []) {
    const message = choice.delta ?? choice.message;
    if (!Array.isArray(message?.content)) continue;
    let text = "", reasoning = "";
    for (const part of message.content) {
      if (part.type === "text") text += part.text ?? "";
      if (part.type === "thinking") for (const thought of part.thinking ?? []) reasoning += thought.text ?? "";
    }
    message.content = text;
    if (reasoning) message.reasoning_content = (message.reasoning_content ?? "") + reasoning;
  }
  return chunk;
}

/** Adapt only Mistral content parts to DSH's Chat Completions parser. Other
 * upstreams and errors remain byte-for-byte unchanged. Cancellation follows
 * the response stream, and the existing gateway still owns timeouts/usage. */
export async function adaptMistralResponse(response, model) {
  if (!model?.startsWith("mistral-") || !response.ok || !response.body) return response;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  if (!(headers.get("content-type") ?? "").includes("text/event-stream")) {
    const body = await response.text();
    let value;
    try { value = JSON.stringify(mistralChunk(JSON.parse(body))); } catch { value = body; }
    return new Response(value, { status: response.status, headers });
  }
  const decoder = new StringDecoder("utf8");
  let buffered = "";
  const frame = value => value.replace(/^data: ?(.*)$/gm, (line, raw) => {
    if (raw === "[DONE]") return line;
    try { return `data: ${JSON.stringify(mistralChunk(JSON.parse(raw)))}`; } catch { return line; }
  });
  const stream = new Transform({
    transform(chunk, _encoding, callback) {
      buffered += decoder.write(chunk);
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffered))) {
        this.push(frame(buffered.slice(0, match.index)) + match[0]);
        buffered = buffered.slice(match.index + match[0].length);
      }
      callback();
    },
    flush(callback) { buffered += decoder.end(); if (buffered) this.push(frame(buffered)); callback(); },
  });
  const source = Readable.fromWeb(response.body);
  source.on("error", error => stream.destroy(error));
  stream.on("close", () => source.destroy());
  source.pipe(stream);
  return new Response(Readable.toWeb(stream), { status: response.status, headers });
}
