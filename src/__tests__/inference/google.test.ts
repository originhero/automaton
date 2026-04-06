import { describe, it, expect, vi } from "vitest";
import { GoogleProtocol } from "../../inference/protocols/google.js";
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

describe("GoogleProtocol", () => {
  const baseUrl = "https://generativelanguage.googleapis.com/v1beta";
  const apiKey = "AIza-test-key";

  describe("chat()", () => {
    it("sends correct request format to generateContent endpoint", async () => {
      const mockResponse = {
        candidates: [{
          content: {
            parts: [{ text: "Hello from Gemini!" }],
            role: "model",
          },
          finishReason: "STOP",
        }],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 6,
        },
      };

      const fetchFn = createMockFetch(mockResponse);
      const protocol = new GoogleProtocol({ baseUrl, apiKey, fetchFn });

      const result = await protocol.chat(
        [{ role: "user", content: "Hi Gemini" }],
        { model: "gemini-2.5-pro", maxTokens: 2048 },
      );

      expect(fetchFn).toHaveBeenCalledTimes(1);
      const [url, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
      // Bug G fix: no API key in URL query parameter
      expect(url).toBe(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent",
      );
      expect(url).not.toContain("key=");
      expect(init.method).toBe("POST");

      const body = JSON.parse(init.body);
      expect(body.contents).toBeDefined();
      expect(body.contents[0].role).toBe("user");
      expect(body.contents[0].parts[0].text).toBe("Hi Gemini");

      expect(result.content).toBe("Hello from Gemini!");
      expect(result.inputTokens).toBe(10);
      expect(result.outputTokens).toBe(6);
      expect(result.finishReason).toBe("STOP");
    });

    it("sends API key via x-goog-api-key header (Bug G fix)", async () => {
      const mockResponse = {
        candidates: [{ content: { parts: [{ text: "OK" }], role: "model" }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 },
      };

      const fetchFn = createMockFetch(mockResponse);
      const protocol = new GoogleProtocol({ baseUrl, apiKey, fetchFn });

      await protocol.chat([{ role: "user", content: "Hi" }], { model: "gemini-2.5-flash" });

      const [url, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
      // API key should NOT be in URL
      expect(url).not.toContain("key=");
      // API key should be in header
      const headers = init.headers as Record<string, string>;
      expect(headers["x-goog-api-key"]).toBe("AIza-test-key");
    });

    it("transforms messages to Google contents format", async () => {
      const mockResponse = {
        candidates: [{ content: { parts: [{ text: "Response" }], role: "model" }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 2 },
      };

      const fetchFn = createMockFetch(mockResponse);
      const protocol = new GoogleProtocol({ baseUrl, apiKey, fetchFn });

      await protocol.chat(
        [
          { role: "system", content: "You are helpful." },
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Hi there" },
          { role: "user", content: "How are you?" },
        ],
        { model: "gemini-2.5-pro" },
      );

      const body = JSON.parse((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
      // System message goes into systemInstruction
      expect(body.systemInstruction).toBeDefined();
      expect(body.systemInstruction.parts[0].text).toBe("You are helpful.");
      // Non-system messages go into contents
      expect(body.contents).toHaveLength(3);
      expect(body.contents[0].role).toBe("user");
      // Google uses "model" instead of "assistant"
      expect(body.contents[1].role).toBe("model");
      expect(body.contents[2].role).toBe("user");
    });

    it("merges consecutive same-role messages", async () => {
      const mockResponse = {
        candidates: [{ content: { parts: [{ text: "OK" }], role: "model" }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 15, candidatesTokenCount: 1 },
      };

      const fetchFn = createMockFetch(mockResponse);
      const protocol = new GoogleProtocol({ baseUrl, apiKey, fetchFn });

      await protocol.chat(
        [
          { role: "user", content: "Part 1" },
          { role: "user", content: "Part 2" },
        ],
        { model: "gemini-2.5-pro" },
      );

      const body = JSON.parse((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
      expect(body.contents).toHaveLength(1);
      expect(body.contents[0].parts[0].text).toContain("Part 1");
      expect(body.contents[0].parts[0].text).toContain("Part 2");
    });

    it("parses functionCall parts from responses (Bug E fix)", async () => {
      const mockResponse = {
        candidates: [{
          content: {
            parts: [{
              functionCall: {
                name: "get_weather",
                args: { city: "NYC" },
              },
            }],
            role: "model",
          },
          finishReason: "STOP",
        }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      };

      const fetchFn = createMockFetch(mockResponse);
      const protocol = new GoogleProtocol({ baseUrl, apiKey, fetchFn });

      const result = await protocol.chat(
        [{ role: "user", content: "Weather in NYC?" }],
        {
          model: "gemini-2.5-pro",
          tools: [{
            type: "function" as const,
            function: {
              name: "get_weather",
              description: "Get weather",
              parameters: { type: "object", properties: { city: { type: "string" } } },
            },
          }],
        },
      );

      expect(result.toolCalls).toBeDefined();
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls![0].function.name).toBe("get_weather");
      expect(JSON.parse(result.toolCalls![0].function.arguments)).toEqual({ city: "NYC" });
      expect(result.toolCalls![0].id).toBe("call_get_weather");
    });

    it("maps tool role messages to functionResponse format (Bug E fix)", async () => {
      const mockResponse = {
        candidates: [{ content: { parts: [{ text: "It is sunny." }], role: "model" }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5 },
      };

      const fetchFn = createMockFetch(mockResponse);
      const protocol = new GoogleProtocol({ baseUrl, apiKey, fetchFn });

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
          { role: "tool", content: '{"temp": 72}', tool_call_id: "call_1", name: "get_weather" },
        ],
        { model: "gemini-2.5-pro" },
      );

      const body = JSON.parse((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
      // The tool response should be a functionResponse part
      const toolMsg = body.contents[body.contents.length - 1];
      expect(toolMsg.role).toBe("function");
      expect(toolMsg.parts[0].functionResponse).toBeDefined();
      expect(toolMsg.parts[0].functionResponse.name).toBe("get_weather");
      expect(toolMsg.parts[0].functionResponse.response).toEqual({ temp: 72 });
    });

    it("uses default timeout when no signal is provided", async () => {
      const mockResponse = {
        candidates: [{ content: { parts: [{ text: "OK" }], role: "model" }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 },
      };

      const fetchFn = createMockFetch(mockResponse);
      const protocol = new GoogleProtocol({ baseUrl, apiKey, fetchFn });

      await protocol.chat([{ role: "user", content: "Hi" }], { model: "gemini-2.5-flash" });

      const [, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(init.signal).toBeDefined();
    });
  });

  describe("chatStream()", () => {
    it("yields chunks from Google SSE streaming endpoint (Bug F fix)", async () => {
      const sseChunks = [
        'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}],"role":"model"}}]}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"text":" world"}],"role":"model"},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2}}\n\n',
      ];

      const fetchFn = createSSEFetch(sseChunks);
      const protocol = new GoogleProtocol({ baseUrl, apiKey, fetchFn });

      const chunks: { delta: string; finishReason?: string }[] = [];
      for await (const chunk of protocol.chatStream!(
        [{ role: "user", content: "Hi" }],
        { model: "gemini-2.5-pro" },
      )) {
        chunks.push(chunk);
      }

      const [url] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toContain("streamGenerateContent");
      expect(url).toContain("alt=sse");
      expect(url).not.toContain("key=");
      expect(chunks.length).toBeGreaterThanOrEqual(2);
      expect(chunks[0].delta).toBe("Hello");
      expect(chunks[1].delta).toBe(" world");
    });

    it("includes tools in streaming request body (Bug H fix)", async () => {
      const sseChunks = [
        'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"get_weather","args":{"city":"NYC"}}}],"role":"model"},"finishReason":"STOP"}]}\n\n',
      ];

      const fetchFn = createSSEFetch(sseChunks);
      const protocol = new GoogleProtocol({ baseUrl, apiKey, fetchFn });

      const tools = [{
        type: "function" as const,
        function: {
          name: "get_weather",
          description: "Get weather",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        },
      }];

      const chunks: { delta: string; toolCalls?: unknown[] }[] = [];
      for await (const chunk of protocol.chatStream!(
        [{ role: "user", content: "Weather?" }],
        { model: "gemini-2.5-pro", tools },
      )) {
        chunks.push(chunk);
      }

      const body = JSON.parse((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
      expect(body.tools).toBeDefined();
      expect(body.tools[0].functionDeclarations).toHaveLength(1);

      // Should also parse functionCall from streaming
      const toolChunks = chunks.filter(c => c.toolCalls && c.toolCalls.length > 0);
      expect(toolChunks).toHaveLength(1);
    });

    it("throws when response body is null", async () => {
      const fetchFn = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers({ "content-type": "text/event-stream" }),
        body: null,
      } as unknown as Response);

      const protocol = new GoogleProtocol({ baseUrl, apiKey, fetchFn });

      const iterator = protocol.chatStream!(
        [{ role: "user", content: "Hi" }],
        { model: "gemini-2.5-pro" },
      );

      await expect(async () => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _ of iterator) {
          // should throw
        }
      }).rejects.toThrow(/response body is null/);
    });
  });
});
