// Mock Anthropic Messages API for local testing only. Returns a canned reply
// and logs the request (model, system prompt, messages) so the caller can
// verify what the app sent. Never used in production.

const server = Bun.serve({
  port: 3101,
  async fetch(req) {
    const body = (await req.json().catch(() => ({}))) as any;
    console.log(
      JSON.stringify({
        model: body.model,
        systemPreview: String(body.system || "").slice(0, 200),
        messages: body.messages,
        max_tokens: body.max_tokens,
      }),
    );
    return new Response(
      JSON.stringify({
        id: "msg_mock",
        type: "message",
        role: "assistant",
        model: body.model || "mock",
        content: [
          {
            type: "text",
            text: "Mock reply: I heard you. This is the test brain answering.",
          },
        ],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 12 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  },
});
console.log(`Mock Anthropic listening on http://localhost:${server.port}`);
