import { describe, it, expect, vi } from "vitest";
import { AnthropicProtocol } from "../../inference/protocols/anthropic.js";
import type { Message, ChatOptions, FetchFn } from "../../inference/protocols/types.js";

function createMockFetch(responseBody: unknown, status = 200): FetchFn {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: () => Promise.resolve(responseBody),
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

    it("converts tool messages to user messages with tool_result content", async () => {
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
      // The tool message should be converted to a user message
      const lastMsg = body.messages[body.messages.length - 1];
      expect(lastMsg.role).toBe("user");
      expect(lastMsg.content).toContain("tool_result");
      expect(lastMsg.content).toContain("call_1");
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
  });
});
