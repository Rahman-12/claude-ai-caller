import WebSocket, { WebSocketServer } from "ws";
import Anthropic from "@anthropic-ai/sdk";

const PORT = process.env.PORT || 8080;

const wss = new WebSocketServer({ port: PORT });

console.log("Claude AI Caller WebSocket server running on port", PORT);

wss.on("connection", async (twilioWs, req) => {
  console.log("Twilio connected to stream");

  const leadName = req.headers["x-twilio-stream-parameter-leadname"] || "Customer";

  const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY
  });

  const claudeWs = anthropic.messages.stream({
    model: "claude-3-sonnet",
    max_tokens: 4096,
    audio: {
      input: [{ type: "input_audio_buffer" }],
      output: { format: "wav" }
    },
    messages: [
      {
        role: "user",
        content: `You are calling a lead named ${leadName}. Start the conversation politely and naturally.`
      }
    ]
  });

  // Forward audio from Twilio → Claude
  twilioWs.on("message", msg => {
    claudeWs.send(msg);
  });

  // Forward audio from Claude → Twilio
  claudeWs.on("message", msg => {
    twilioWs.send(msg);
  });

  twilioWs.on("close", () => {
    console.log("Twilio disconnected");
    claudeWs.close();
  });

  claudeWs.on("close", () => {
    console.log("Claude stream closed");
  });
});
