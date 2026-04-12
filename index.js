import { WebSocketServer } from "ws";
import Anthropic from "@anthropic-ai/sdk";

const PORT = process.env.PORT || 8080;

const wss = new WebSocketServer({
  port: PORT,
  host: "0.0.0.0"
});

console.log("Claude AI Caller WebSocket server running on port", PORT);

wss.on("connection", async (twilioWs, req) => {
  console.log("Twilio connected to stream");

  const leadName =
    req.headers["x-twilio-stream-parameter-leadname"] || "Customer";

  const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY
  });

  // Start Claude streaming session
  const claudeStream = await anthropic.messages.stream({
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

  // Claude sends structured events
  claudeStream.on("content_block_delta", (delta) => {
    if (delta.delta?.audio) {
      // Forward Claude audio → Twilio
      twilioWs.send(delta.delta.audio);
    }
  });

  claudeStream.on("text", (text) => {
    console.log("Claude text:", text);
  });

  claudeStream.on("error", (err) => {
    console.error("Claude stream error:", err);
  });

  claudeStream.on("end", () => {
    console.log("Claude stream ended");
  });

  // Twilio audio → Claude
  twilioWs.on("message", (msg) => {
    try {
      claudeStream.sendAudio(msg);
    } catch (err) {
      console.error("Error sending audio to Claude:", err);
    }
  });

  twilioWs.on("close", () => {
    console.log("Twilio disconnected");
    claudeStream.close();
  });
});

// Keep container alive
setInterval(() => {
  console.log("Server alive");
}, 30000);

// Error logging
wss.on("error", (err) => {
  console.error("WebSocket Server Error:", err);
});

process.on("uncaughtException", console.error);
process.on("unhandledRejection", console.error);