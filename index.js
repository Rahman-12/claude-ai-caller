import { WebSocketServer } from "ws";
import { createServer } from "http";
import Anthropic from "@anthropic-ai/sdk";

const PORT = process.env.PORT || 8080;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const BUSINESS_NAME = process.env.BUSINESS_NAME || "ElectraBoostAI";

// Store active call sessions keyed by callSid
const sessions = new Map();

// Create a plain HTTP server so we can route WebSocket paths
const server = createServer((req, res) => {
  res.writeHead(200);
  res.end(`${BUSINESS_NAME} AI Caller running`);
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
          userMessage: null
        });
        break;

      case "stop":
        console.log(`Stream stopped — Call: ${callSid}`);
        sessions.delete(callSid);
        break;

      case "media":
        // Raw audio — handled via transcription websocket
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

    // Log all transcription events for debugging
    console.log("Transcription event received:", JSON.stringify(msg));

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
      system: `You are a friendly and professional call handler working for ${BUSINESS_NAME}, a company that connects homeowners and businesses with qualified local electricians.
You are calling ${leadName} because they just filled out a form showing interest in hiring a qualified local electrician.

Your goals in this exact order are:
1. Greet them warmly by name and confirm you are calling from ${BUSINESS_NAME} about their enquiry for an electrician
2. Ask what electrical work they need done
3. Ask for their postcode or general area so you can match them with a local electrician
4. Ask when they need the work done — urgently, within the week, or just planning ahead
5. Thank them, let them know a qualified local electrician from ${BUSINESS_NAME} will be in touch with them shortly, then say goodbye

Rules you must follow:
- Keep every response to 1-3 sentences maximum — this is a phone call not a chat
- Sound natural and human — never robotic or scripted
- Never mention you are an AI unless directly asked — if asked, say you are a call handler for ${BUSINESS_NAME}
- Never make up prices, timelines, or electrician names
- If they seem uninterested or say wrong number, politely apologise on behalf of ${BUSINESS_NAME} and end the call
- If they ask a technical electrical question, tell them the electrician will be best placed to advise when they call back
- Once you have collected all 3 pieces of information (job type, location, timing) thank them warmly and say goodbye
- Always be warm, confident and brief`,
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

// ─── Text to Speech ───────────────────────────────────────────────────────────

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
  console.log(`${BUSINESS_NAME} AI Caller running on port ${PORT}`);
});

setInterval(() => console.log("Server alive"), 30000);
process.on("uncaughtException", console.error);
process.on("unhandledRejection", console.error);
