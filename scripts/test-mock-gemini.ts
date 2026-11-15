// Mock Gemini generateContent API for local testing only. Returns a canned
// reply and logs the request (model from the URL, systemInstruction,
// contents) so the caller can verify what the app sent. Never used in
// production.

const mockServer = Bun.serve({
  port: 3102,
  async fetch(req) {
    const body = (await req.json().catch(() => ({}))) as any;
    const url = new URL(req.url);
    console.log(
      JSON.stringify({
        model: url.pathname,
        systemPreview: String(body.systemInstruction?.parts?.[0]?.text || "").slice(0, 200),
        contents: body.contents,
        generationConfig: body.generationConfig,
      }),
    );
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                {
                  text: "Mock reply: I heard you. This is the test Gemini brain answering.",
                },
              ],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 12 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  },
});
console.log(`Mock Gemini listening on http://localhost:${mockServer.port}`);
