import { describe, it, expect, vi } from "vitest";
import { OpenAICompatibleProtocol } from "../../inference/protocols/openai-compatible.js";
import type { Message, ChatOptions, FetchFn, ToolCall } from "../../inference/protocols/types.js";

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

describe("OpenAICompatibleProtocol", () => {
  const baseUrl = "https://api.openai.com/v1";
  const apiKey = "sk-test-key";

  describe("chat()", () => {
    it("sends correct request format to /chat/completions", async () => {
      const mockResponse = {
        id: "chatcmpl-123",
        model: "gpt-4o",
        choices: [
          {
            message: { role: "assistant", content: "Hello!" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      };

      const fetchFn = createMockFetch(mockResponse);
      const protocol = new OpenAICompatibleProtocol({ baseUrl, apiKey, fetchFn });

      const messages: Message[] = [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Hi" },
      ];
      const options: ChatOptions = { model: "gpt-4o", maxTokens: 100, temperature: 0.7 };

      const result = await protocol.chat(messages, options);

      expect(fetchFn).toHaveBeenCalledTimes(1);
      const [url, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe("https://api.openai.com/v1/chat/completions");
      expect(init.method).toBe("POST");

      const headers = init.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer sk-test-key");
      expect(headers["Content-Type"]).toBe("application/json");

      const body = JSON.parse(init.body);
      expect(body.model).toBe("gpt-4o");
      expect(body.max_tokens).toBe(100);
      expect(body.temperature).toBe(0.7);
      expect(body.messages).toHaveLength(2);
      expect(body.stream).toBeUndefined();

      expect(result.content).toBe("Hello!");
      expect(result.model).toBe("gpt-4o");
      expect(result.inputTokens).toBe(10);
      expect(result.outputTokens).toBe(5);
      expect(result.finishReason).toBe("stop");
    });

    it("merges consecutive same-role messages", async () => {
      const mockResponse = {
        id: "chatcmpl-456",
        model: "gpt-4o",
        choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 20, completion_tokens: 1 },
      };

      const fetchFn = createMockFetch(mockResponse);
      const protocol = new OpenAICompatibleProtocol({ baseUrl, apiKey, fetchFn });

      const messages: Message[] = [
        { role: "user", content: "Part 1" },
        { role: "user", content: "Part 2" },
        { role: "user", content: "Part 3" },
      ];

      await protocol.chat(messages, { model: "gpt-4o" });

      const body = JSON.parse((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0].content).toBe("Part 1\nPart 2\nPart 3");
    });

    it("includes tool definitions when provided", async () => {
      const mockResponse = {
        id: "chatcmpl-789",
        model: "gpt-4o",
        choices: [{
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call_1",
              type: "function" as const,
              function: { name: "get_weather", arguments: '{"city":"NYC"}' },
            }],
          },
          finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 15, completion_tokens: 10 },
      };

      const fetchFn = createMockFetch(mockResponse);
      const protocol = new OpenAICompatibleProtocol({ baseUrl, apiKey, fetchFn });

      const tools = [{
        type: "function" as const,
        function: {
          name: "get_weather",
          description: "Get weather for a city",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        },
      }];

      const result = await protocol.chat(
        [{ role: "user", content: "Weather in NYC?" }],
        { model: "gpt-4o", tools },
      );

      const body = JSON.parse((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
      expect(body.tools).toHaveLength(1);
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls![0].function.name).toBe("get_weather");
    });

    it("works with different base URLs (DeepSeek, Groq, etc.)", async () => {
      const deepseekUrl = "https://api.deepseek.com/v1";
      const mockResponse = {
        id: "ds-123",
        model: "deepseek-r1",
        choices: [{ message: { role: "assistant", content: "Reasoning..." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 50 },
      };

      const fetchFn = createMockFetch(mockResponse);
      const protocol = new OpenAICompatibleProtocol({
        baseUrl: deepseekUrl,
        apiKey: "sk-ds-test",
        fetchFn,
      });

      await protocol.chat([{ role: "user", content: "Hello" }], { model: "deepseek-r1" });

      const [url] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe("https://api.deepseek.com/v1/chat/completions");
    });

    it("throws on non-OK response", async () => {
      const fetchFn = createMockFetch(
        { error: { message: "Invalid API key" } },
        401,
      );
      const protocol = new OpenAICompatibleProtocol({ baseUrl, apiKey, fetchFn });

      await expect(
        protocol.chat([{ role: "user", content: "Hi" }], { model: "gpt-4o" }),
      ).rejects.toThrow(/401/);
    });

    it("uses default timeout when no signal is provided", async () => {
      const mockResponse = {
        id: "chatcmpl-timeout",
        model: "gpt-4o",
        choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 1 },
      };

      const fetchFn = createMockFetch(mockResponse);
      const protocol = new OpenAICompatibleProtocol({ baseUrl, apiKey, fetchFn });

      await protocol.chat([{ role: "user", content: "Hi" }], { model: "gpt-4o" });

      const [, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(init.signal).toBeDefined();
    });
  });

  describe("chatStream()", () => {
    it("yields chunks from SSE stream", async () => {
      const sseChunks = [
        'data: {"id":"chatcmpl-1","choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl-1","choices":[{"delta":{"content":" world"},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl-1","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n',
        "data: [DONE]\n\n",
      ];

      const fetchFn = createSSEFetch(sseChunks);
      const protocol = new OpenAICompatibleProtocol({ baseUrl, apiKey, fetchFn });

      const chunks: { delta: string; finishReason?: string }[] = [];
      for await (const chunk of protocol.chatStream!(
        [{ role: "user", content: "Hi" }],
        { model: "gpt-4o" },
      )) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(3);
      expect(chunks[0].delta).toBe("Hello");
      expect(chunks[1].delta).toBe(" world");
      expect(chunks[2].finishReason).toBe("stop");
    });

    it("accumulates tool call arguments across SSE chunks (Bug J fix)", async () => {
      const sseChunks = [
        'data: {"id":"chatcmpl-1","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":""}}]},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl-1","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"ci"}}]},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl-1","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ty\\":\\"N"}}]},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl-1","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"YC\\"}"}}]},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl-1","choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        "data: [DONE]\n\n",
      ];

      const fetchFn = createSSEFetch(sseChunks);
      const protocol = new OpenAICompatibleProtocol({ baseUrl, apiKey, fetchFn });

      const chunks: { delta: string; finishReason?: string; toolCalls?: ToolCall[] }[] = [];
      for await (const chunk of protocol.chatStream!(
        [{ role: "user", content: "Weather in NYC?" }],
        { model: "gpt-4o" },
      )) {
        chunks.push(chunk);
      }

      // Should NOT yield incomplete tool calls in intermediate chunks
      const toolChunks = chunks.filter(c => c.toolCalls && c.toolCalls.length > 0);
      expect(toolChunks).toHaveLength(1);

      // The accumulated tool call should have complete JSON arguments
      const toolCall = toolChunks[0].toolCalls![0];
      expect(toolCall.id).toBe("call_1");
      expect(toolCall.function.name).toBe("get_weather");
      expect(toolCall.function.arguments).toBe('{"city":"NYC"}');
      expect(JSON.parse(toolCall.function.arguments)).toEqual({ city: "NYC" });
    });

    it("accumulates multiple tool calls across SSE chunks", async () => {
      const sseChunks = [
        'data: {"id":"chatcmpl-1","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":""}}]},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl-1","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":\\"NYC\\"}"}}]},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl-1","choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_2","type":"function","function":{"name":"get_time","arguments":""}}]},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl-1","choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"{\\"tz\\":\\"EST\\"}"}}]},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl-1","choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        "data: [DONE]\n\n",
      ];

      const fetchFn = createSSEFetch(sseChunks);
      const protocol = new OpenAICompatibleProtocol({ baseUrl, apiKey, fetchFn });

      const chunks: { delta: string; finishReason?: string; toolCalls?: ToolCall[] }[] = [];
      for await (const chunk of protocol.chatStream!(
        [{ role: "user", content: "Weather and time?" }],
        { model: "gpt-4o" },
      )) {
        chunks.push(chunk);
      }

      const toolChunks = chunks.filter(c => c.toolCalls && c.toolCalls.length > 0);
      expect(toolChunks).toHaveLength(1);
      expect(toolChunks[0].toolCalls).toHaveLength(2);
      expect(toolChunks[0].toolCalls![0].function.name).toBe("get_weather");
      expect(toolChunks[0].toolCalls![1].function.name).toBe("get_time");
      expect(JSON.parse(toolChunks[0].toolCalls![1].function.arguments)).toEqual({ tz: "EST" });
    });

    it("throws when response body is null (Bug K fix)", async () => {
      const fetchFn = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers({ "content-type": "text/event-stream" }),
        body: null,
      } as unknown as Response);

      const protocol = new OpenAICompatibleProtocol({ baseUrl, apiKey, fetchFn });

      const iterator = protocol.chatStream!(
        [{ role: "user", content: "Hi" }],
        { model: "gpt-4o" },
      );

      await expect(async () => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _ of iterator) {
          // should throw
        }
      }).rejects.toThrow(/response body is null/);
    });
  });

  describe("listModels()", () => {
    it("fetches and returns model list", async () => {
      const mockResponse = {
        data: [
          { id: "gpt-4o", owned_by: "openai" },
          { id: "gpt-4o-mini", owned_by: "openai" },
        ],
      };

      const fetchFn = createMockFetch(mockResponse);
      const protocol = new OpenAICompatibleProtocol({ baseUrl, apiKey, fetchFn });

      const models = await protocol.listModels!();

      const [url, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe("https://api.openai.com/v1/models");
      expect(init.method).toBe("GET");
      expect(models).toHaveLength(2);
      expect(models[0].modelId).toBe("gpt-4o");
      expect(models[0].ownedBy).toBe("openai");
    });
  });
});
