import { WebSocketServer } from "ws";
import { createServer } from "http";
import Anthropic from "@anthropic-ai/sdk";

const PORT = process.env.PORT || 8080;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Store active call sessions keyed by callSid
const sessions = new Map();

// Create a plain HTTP server so we can route WebSocket paths
const server = createServer((req, res) => {
  res.writeHead(200);
  res.end("Claude AI Caller running");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  const url = req.url;

  if (url === "/stream" || url === "/") {
    handleTwilioStream(ws);
  } else if (url === "/transcription") {
    handleTranscription(ws);
  } else {
    ws.close();
  }
});

// ─── Handle Twilio Media Stream ───────────────────────────────────────────────

function handleTwilioStream(ws) {
  console.log("Twilio media stream connected");

  let leadName = "Customer";
  let callSid = null;
  let streamSid = null;
  const conversationHistory = [];

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.event) {
      case "start":
        streamSid = msg.start.streamSid;
        callSid = msg.start.callSid;
        leadName = msg.start.customParameters?.leadName || "Customer";
        console.log(`Stream started — Call: ${callSid}, Lead: ${leadName}`);

        // Store session so transcription handler can find it
        sessions.set(callSid, { ws, streamSid, conversationHistory, leadName });

        // Send opening greeting
        await sendClaudeResponse({
          ws,
          streamSid,
          conversationHistory,
          leadName,
          userMessage: null // triggers greeting
        });
        break;

      case "stop":
        console.log(`Stream stopped — Call: ${callSid}`);
        sessions.delete(callSid);
        break;

      case "media":
        // Raw audio — handled via transcription websocket instead
        break;
    }
  });

  ws.on("close", () => {
    console.log("Stream WS closed");
    if (callSid) sessions.delete(callSid);
  });

  ws.on("error", (err) => console.error("Stream WS error:", err));
}

// ─── Handle Twilio Transcription ─────────────────────────────────────────────

function handleTranscription(ws) {
  console.log("Transcription WS connected");

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // Only process final transcripts
    if (msg.TranscriptionEvent !== "transcription-content") return;
    if (msg.Final !== "true") return;

    const transcript = msg.TranscriptionData?.transcript;
    const callSid = msg.CallSid;

    if (!transcript || !callSid) return;

    console.log(`[${callSid}] Customer said: "${transcript}"`);

    const session = sessions.get(callSid);
    if (!session) {
      console.warn(`No session found for CallSid: ${callSid}`);
      return;
    }

    const { ws: streamWs, streamSid, conversationHistory, leadName } = session;

    await sendClaudeResponse({
      ws: streamWs,
      streamSid,
      conversationHistory,
      leadName,
      userMessage: transcript
    });
  });

  ws.on("close", () => console.log("Transcription WS closed"));
  ws.on("error", (err) => console.error("Transcription WS error:", err));
}

// ─── Claude + TTS ─────────────────────────────────────────────────────────────

async function sendClaudeResponse({ ws, streamSid, conversationHistory, leadName, userMessage }) {
  try {
    if (userMessage) {
      conversationHistory.push({ role: "user", content: userMessage });
    }

    const messages = conversationHistory.length > 0
      ? conversationHistory
      : [{ role: "user", content: "Begin the conversation." }];

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 200,
      system: `You are a friendly and helpful inbound customer support agent. 
The customer's name is ${leadName}. 
Keep all responses concise and natural for voice — maximum 2-3 sentences. 
Never use bullet points, markdown, or lists. Speak conversationally.`,
      messages
    });

    const replyText = response.content[0].text;
    console.log(`Claude: "${replyText}"`);

    conversationHistory.push({ role: "assistant", content: replyText });

    await textToSpeechAndStream(ws, streamSid, replyText);

  } catch (err) {
    console.error("Claude error:", err.message);
  }
}

async function textToSpeechAndStream(ws, streamSid, text) {
  try {
    const XI_API_KEY = process.env.ELEVENLABS_API_KEY;
    const VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream?output_format=ulaw_8000`,
      {
        method: "POST",
        headers: {
          "xi-api-key": XI_API_KEY,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          text,
          model_id: "eleven_turbo_v2",
          voice_settings: { stability: 0.5, similarity_boost: 0.75 }
        })
      }
    );

    if (!response.ok) {
      console.error("ElevenLabs error:", await response.text());
      return;
    }

    const audioBuffer = await response.arrayBuffer();
    const base64Audio = Buffer.from(audioBuffer).toString("base64");

    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({
        event: "media",
        streamSid,
        media: { payload: base64Audio }
      }));
    }

  } catch (err) {
    console.error("TTS error:", err.message);
  }
}

// ─── Start Server ─────────────────────────────────────────────────────────────

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});

setInterval(() => console.log("Server alive"), 30000);
process.on("uncaughtException", console.error);
process.on("unhandledRejection", console.error);
