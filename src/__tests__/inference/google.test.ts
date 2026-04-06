import { describe, it, expect, vi } from "vitest";
import { GoogleProtocol } from "../../inference/protocols/google.js";
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
    headers: new Headers({ "content-type": "application/json" }),
    json: () => Promise.resolve(JSON.parse(chunks.join(""))),
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
      expect(url).toBe(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=AIza-test-key",
      );
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

    it("passes API key as query parameter, not header", async () => {
      const mockResponse = {
        candidates: [{ content: { parts: [{ text: "OK" }], role: "model" }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 },
      };

      const fetchFn = createMockFetch(mockResponse);
      const protocol = new GoogleProtocol({ baseUrl, apiKey, fetchFn });

      await protocol.chat([{ role: "user", content: "Hi" }], { model: "gemini-2.5-flash" });

      const [url, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toContain("?key=AIza-test-key");
      // No Authorization header
      const headers = init.headers as Record<string, string>;
      expect(headers["Authorization"]).toBeUndefined();
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
  });

  describe("chatStream()", () => {
    it("yields chunks from Google streaming endpoint", async () => {
      // Google streaming returns a JSON array
      const streamResponse = [
        {
          candidates: [{ content: { parts: [{ text: "Hello" }], role: "model" } }],
        },
        {
          candidates: [{ content: { parts: [{ text: " world" }], role: "model" }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
        },
      ];

      const fetchFn = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers({ "content-type": "application/json" }),
        json: () => Promise.resolve(streamResponse),
      } as unknown as Response);

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
      expect(chunks.length).toBeGreaterThanOrEqual(2);
      expect(chunks[0].delta).toBe("Hello");
    });
  });
});
