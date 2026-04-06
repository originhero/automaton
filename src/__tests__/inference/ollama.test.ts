import { describe, it, expect, vi } from "vitest";
import { OllamaProtocol } from "../../inference/protocols/ollama.js";
import type { FetchFn, Message } from "../../inference/protocols/types.js";

function createMockFetch(responseBody: unknown, status = 200): FetchFn {
  return vi.fn().mockImplementation(async (url: string) => {
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "Error",
      json: () => Promise.resolve(responseBody),
      text: () => Promise.resolve(JSON.stringify(responseBody)),
      headers: new Headers({ "content-type": "application/json" }),
    } as Response;
  });
}

describe("OllamaProtocol", () => {
  const baseUrl = "http://localhost:11434";

  describe("chat()", () => {
    it("delegates chat to OpenAI-compatible endpoint at /v1", async () => {
      const mockResponse = {
        id: "ollama-123",
        model: "llama3.3:70b",
        choices: [
          {
            message: { role: "assistant", content: "Hello from Ollama!" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 5 },
      };

      const fetchFn = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => Promise.resolve(mockResponse),
        headers: new Headers({ "content-type": "application/json" }),
      } as Response);

      const protocol = new OllamaProtocol({ baseUrl, fetchFn });

      const result = await protocol.chat(
        [{ role: "user", content: "Hi" }],
        { model: "llama3.3:70b" },
      );

      const [url] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe("http://localhost:11434/v1/chat/completions");
      expect(result.content).toBe("Hello from Ollama!");
    });
  });

  describe("listModels()", () => {
    it("discovers local models via /api/tags", async () => {
      const tagsResponse = {
        models: [
          { name: "llama3.3:70b", size: 40000000000, details: { family: "llama" } },
          { name: "mistral:7b", size: 4000000000, details: { family: "mistral" } },
          { name: "codellama:13b", size: 7000000000, details: { family: "llama" } },
        ],
      };

      // Return different responses based on URL
      const fetchFn = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes("/api/tags")) {
          return {
            ok: true,
            status: 200,
            json: () => Promise.resolve(tagsResponse),
            headers: new Headers({ "content-type": "application/json" }),
          } as Response;
        }
        // Default for other calls
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve({}),
          headers: new Headers({ "content-type": "application/json" }),
        } as Response;
      });

      const protocol = new OllamaProtocol({ baseUrl, fetchFn });
      const models = await protocol.listModels!();

      const [url] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe("http://localhost:11434/api/tags");
      expect(models).toHaveLength(3);
      expect(models[0].modelId).toBe("llama3.3:70b");
      expect(models[1].modelId).toBe("mistral:7b");
      expect(models[2].modelId).toBe("codellama:13b");
    });

    it("returns empty array when Ollama is not running", async () => {
      const fetchFn = vi.fn().mockRejectedValue(new Error("Connection refused"));
      const protocol = new OllamaProtocol({ baseUrl, fetchFn });

      const models = await protocol.listModels!();
      expect(models).toEqual([]);
    });
  });
});
