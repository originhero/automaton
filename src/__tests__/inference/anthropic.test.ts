import { describe, it, expect, vi } from "vitest";
import { AnthropicProtocol } from "../../inference/protocols/anthropic.js";
import type { Message, ChatOptions, FetchFn } from "../../inference/protocols/types.js";

function createMockFetch(responseBody: unknown, status = 200): FetchFn {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: () => Promise.resolve(responseBody),
    text: () => Promise.resolve(JSON.stringify(responseBody)),
    headers: new Headers({ "content-type": "application/json" }),
  } as Response);
}

function createSSEFetch(chunks: string[]): FetchFn {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers({ "content-type": "text/event-stream" }),
    body: {
      getReader() {
        let index = 0;
        const encoder = new TextEncoder();
        return {
          read() {
            if (index < chunks.length) {
              return Promise.resolve({
                done: false,
                value: encoder.encode(chunks[index++]),
              });
            }
            return Promise.resolve({ done: true, value: undefined });
          },
          cancel() {
            return Promise.resolve();
          },
          releaseLock() {},
        };
      },
    },
  } as unknown as Response);
}

describe("AnthropicProtocol", () => {
  const baseUrl = "https://api.anthropic.com";
  const apiKey = "sk-ant-test-key";

  describe("chat()", () => {
    it("sends correct request format to /v1/messages", async () => {
      const mockResponse = {
        id: "msg_123",
        model: "claude-sonnet-4-20250514",
        content: [{ type: "text", text: "Hello from Claude!" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 12, output_tokens: 8 },
      };

      const fetchFn = createMockFetch(mockResponse);
      const protocol = new AnthropicProtocol({ baseUrl, apiKey, fetchFn });

      const result = await protocol.chat(
        [{ role: "user", content: "Hi Claude" }],
        { model: "claude-sonnet-4-20250514", maxTokens: 1024 },
      );

      expect(fetchFn).toHaveBeenCalledTimes(1);
      const [url, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe("https://api.anthropic.com/v1/messages");
      expect(init.method).toBe("POST");

      const headers = init.headers as Record<string, string>;
      expect(headers["x-api-key"]).toBe("sk-ant-test-key");
      expect(headers["anthropic-version"]).toBe("2023-06-01");
      expect(headers["Content-Type"]).toBe("application/json");

      expect(result.content).toBe("Hello from Claude!");
      expect(result.inputTokens).toBe(12);
      expect(result.outputTokens).toBe(8);
      expect(result.finishReason).toBe("end_turn");
    });

    it("extracts system messages into the system parameter", async () => {
      const mockResponse = {
        id: "msg_456",
        model: "claude-sonnet-4-20250514",
        content: [{ type: "text", text: "I am helpful." }],
        stop_reason: "end_turn",
        usage: { input_tokens: 20, output_tokens: 5 },
      };

      const fetchFn = createMockFetch(mockResponse);
      const protocol = new AnthropicProtocol({ baseUrl, apiKey, fetchFn });

      await protocol.chat(
        [
          { role: "system", content: "You are helpful." },
          { role: "system", content: "Be concise." },
          { role: "user", content: "Hello" },
        ],
        { model: "claude-sonnet-4-20250514", maxTokens: 1024 },
      );

      const body = JSON.parse((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
      expect(body.system).toBe("You are helpful.\nBe concise.");
      // System messages must not appear in the messages array
      expect(body.messages.every((m: { role: string }) => m.role !== "system")).toBe(true);
    });

    it("converts tool messages to user messages with proper tool_result content blocks", async () => {
      const mockResponse = {
        id: "msg_789",
        model: "claude-sonnet-4-20250514",
        content: [{ type: "text", text: "The weather is sunny." }],
        stop_reason: "end_turn",
        usage: { input_tokens: 30, output_tokens: 10 },
      };

      const fetchFn = createMockFetch(mockResponse);
      const protocol = new AnthropicProtocol({ baseUrl, apiKey, fetchFn });

      await protocol.chat(
        [
          { role: "user", content: "Weather?" },
          {
            role: "assistant",
            content: "",
            tool_calls: [{
              id: "call_1",
              type: "function" as const,
              function: { name: "get_weather", arguments: '{"city":"NYC"}' },
            }],
          },
          { role: "tool", content: '{"temp": 72}', tool_call_id: "call_1" },
        ],
        { model: "claude-sonnet-4-20250514", maxTokens: 1024 },
      );

      const body = JSON.parse((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
      // The tool message should be converted to a user message with content array
      const lastMsg = body.messages[body.messages.length - 1];
      expect(lastMsg.role).toBe("user");
      // Bug A fix: content must be an array of tool_result blocks
      expect(Array.isArray(lastMsg.content)).toBe(true);
      expect(lastMsg.content[0].type).toBe("tool_result");
      expect(lastMsg.content[0].tool_use_id).toBe("call_1");
      expect(lastMsg.content[0].content).toBe('{"temp": 72}');
    });

    it("preserves tool_use blocks in assistant messages with tool_calls", async () => {
      const mockResponse = {
        id: "msg_tool",
        model: "claude-sonnet-4-20250514",
        content: [{ type: "text", text: "Result." }],
        stop_reason: "end_turn",
        usage: { input_tokens: 40, output_tokens: 5 },
      };

      const fetchFn = createMockFetch(mockResponse);
      const protocol = new AnthropicProtocol({ baseUrl, apiKey, fetchFn });

      await protocol.chat(
        [
          { role: "user", content: "Weather?" },
          {
            role: "assistant",
            content: "Let me check.",
            tool_calls: [{
              id: "call_1",
              type: "function" as const,
              function: { name: "get_weather", arguments: '{"city":"NYC"}' },
            }],
          },
          { role: "tool", content: '{"temp": 72}', tool_call_id: "call_1" },
        ],
        { model: "claude-sonnet-4-20250514", maxTokens: 1024 },
      );

      const body = JSON.parse((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
      // Assistant message with tool_calls should have content as array with tool_use blocks
      const assistantMsg = body.messages[1];
      expect(assistantMsg.role).toBe("assistant");
      expect(Array.isArray(assistantMsg.content)).toBe(true);
      expect(assistantMsg.content[0].type).toBe("text");
      expect(assistantMsg.content[0].text).toBe("Let me check.");
      expect(assistantMsg.content[1].type).toBe("tool_use");
      expect(assistantMsg.content[1].id).toBe("call_1");
      expect(assistantMsg.content[1].name).toBe("get_weather");
      expect(assistantMsg.content[1].input).toEqual({ city: "NYC" });
    });

    it("merges consecutive same-role messages", async () => {
      const mockResponse = {
        id: "msg_merge",
        model: "claude-sonnet-4-20250514",
        content: [{ type: "text", text: "OK" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 15, output_tokens: 1 },
      };

      const fetchFn = createMockFetch(mockResponse);
      const protocol = new AnthropicProtocol({ baseUrl, apiKey, fetchFn });

      await protocol.chat(
        [
          { role: "user", content: "Part 1" },
          { role: "user", content: "Part 2" },
        ],
        { model: "claude-sonnet-4-20250514", maxTokens: 1024 },
      );

      const body = JSON.parse((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
      // Two consecutive user messages should merge into one
      const userMsgs = body.messages.filter((m: { role: string }) => m.role === "user");
      expect(userMsgs).toHaveLength(1);
      expect(userMsgs[0].content).toContain("Part 1");
      expect(userMsgs[0].content).toContain("Part 2");
    });

    it("uses default timeout when no signal is provided", async () => {
      const mockResponse = {
        id: "msg_timeout",
        model: "claude-sonnet-4-20250514",
        content: [{ type: "text", text: "OK" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 5, output_tokens: 1 },
      };

      const fetchFn = createMockFetch(mockResponse);
      const protocol = new AnthropicProtocol({ baseUrl, apiKey, fetchFn });

      await protocol.chat(
        [{ role: "user", content: "Hi" }],
        { model: "claude-sonnet-4-20250514" },
      );

      const [, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
      // Signal should be present even when not provided by caller
      expect(init.signal).toBeDefined();
    });
  });

  describe("chatStream()", () => {
    it("yields chunks from Anthropic SSE events", async () => {
      const sseChunks = [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4-20250514","usage":{"input_tokens":10}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":" there"}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ];

      const fetchFn = createSSEFetch(sseChunks);
      const protocol = new AnthropicProtocol({ baseUrl, apiKey, fetchFn });

      const chunks: { delta: string; finishReason?: string }[] = [];
      for await (const chunk of protocol.chatStream!(
        [{ role: "user", content: "Hi" }],
        { model: "claude-sonnet-4-20250514", maxTokens: 1024 },
      )) {
        chunks.push(chunk);
      }

      expect(chunks.length).toBeGreaterThanOrEqual(2);
      const textChunks = chunks.filter(c => c.delta.length > 0);
      expect(textChunks[0].delta).toBe("Hello");
      expect(textChunks[1].delta).toBe(" there");
    });

    it("handles tool_use streaming events (Bug B fix)", async () => {
      const sseChunks = [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4-20250514","usage":{"input_tokens":10}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"get_weather"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":":\\"NYC\\"}"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ];

      const fetchFn = createSSEFetch(sseChunks);
      const protocol = new AnthropicProtocol({ baseUrl, apiKey, fetchFn });

      const chunks: { delta: string; finishReason?: string; toolCalls?: unknown[] }[] = [];
      for await (const chunk of protocol.chatStream!(
        [{ role: "user", content: "Weather?" }],
        { model: "claude-sonnet-4-20250514", maxTokens: 1024 },
      )) {
        chunks.push(chunk);
      }

      // Should have a chunk with tool calls
      const toolChunks = chunks.filter(c => c.toolCalls && c.toolCalls.length > 0);
      expect(toolChunks).toHaveLength(1);
      const toolCall = toolChunks[0].toolCalls![0] as { id: string; function: { name: string; arguments: string } };
      expect(toolCall.id).toBe("toolu_1");
      expect(toolCall.function.name).toBe("get_weather");
      expect(JSON.parse(toolCall.function.arguments)).toEqual({ city: "NYC" });
    });

    it("uses actual stop_reason instead of hardcoded end_turn (Bug C fix)", async () => {
      const sseChunks = [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4-20250514","usage":{"input_tokens":10}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ];

      const fetchFn = createSSEFetch(sseChunks);
      const protocol = new AnthropicProtocol({ baseUrl, apiKey, fetchFn });

      const chunks: { delta: string; finishReason?: string }[] = [];
      for await (const chunk of protocol.chatStream!(
        [{ role: "user", content: "Write a long story" }],
        { model: "claude-sonnet-4-20250514", maxTokens: 10 },
      )) {
        chunks.push(chunk);
      }

      const stopChunk = chunks.find(c => c.finishReason !== undefined);
      expect(stopChunk?.finishReason).toBe("max_tokens");
    });

    it("throws when response body is null (Bug D fix)", async () => {
      const fetchFn = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers({ "content-type": "text/event-stream" }),
        body: null,
      } as unknown as Response);

      const protocol = new AnthropicProtocol({ baseUrl, apiKey, fetchFn });

      const iterator = protocol.chatStream!(
        [{ role: "user", content: "Hi" }],
        { model: "claude-sonnet-4-20250514", maxTokens: 1024 },
      );

      await expect(async () => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _ of iterator) {
          // should throw before yielding
        }
      }).rejects.toThrow(/response body is null/);
    });
  });
});
