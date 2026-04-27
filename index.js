import { WebSocketServer } from "ws";
import { createServer } from "http";
import Anthropic from "@anthropic-ai/sdk";

const PORT = process.env.PORT || 8080;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const BUSINESS_NAME = process.env.BUSINESS_NAME || "ElectraBoostAI";
const HUBSPOT_API_KEY = process.env.HUBSPOT_API_KEY;
const NOTIFY_EMAIL = "electraboostai@gmail.com";
const NOTIFY_PHONE = "+447840910698";
const HUBSPOT_PIPELINE_ID = "default";
const HUBSPOT_CONTACTED_STAGE = "qualifiedtobuy";

// Store active call sessions keyed by callSid
const sessions = new Map();

// Create HTTP server to route WebSocket paths
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

        sessions.set(callSid, {
          ws,
          streamSid,
          conversationHistory,
          leadName,
          callSid,
          qualifiedData: { jobType: null, location: null, timing: null }
        });

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
        const session = sessions.get(callSid);
        if (session) {
          await handleCallEnded(session);
          sessions.delete(callSid);
        }
        break;

      case "media":
        break;
    }
  });

  ws.on("close", () => {
    console.log("Stream WS closed");
  });

  ws.on("error", (err) => console.error("Stream WS error:", err));
}

// ─── Handle Twilio Transcription ─────────────────────────────────────────────

function handleTranscription(ws) {
  console.log("Transcription WS connected");

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    console.log("Transcription event received:", JSON.stringify(msg));

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
      userMessage: transcript,
      session
    });
  });

  ws.on("close", () => console.log("Transcription WS closed"));
  ws.on("error", (err) => console.error("Transcription WS error:", err));
}

// ─── Claude + TTS ─────────────────────────────────────────────────────────────

async function sendClaudeResponse({ ws, streamSid, conversationHistory, leadName, userMessage, session }) {
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
- Always be warm, confident and brief

IMPORTANT: Once you have collected job type, location and timing — include this exact tag at the end of your response (invisible to the customer):
[QUALIFIED: jobType=<job> | location=<location> | timing=<timing>]`,
      messages
    });

    const replyText = response.content[0].text;

    // Check if Claude has collected all 3 pieces of info
    const qualifiedMatch = replyText.match(/\[QUALIFIED: jobType=(.+?) \| location=(.+?) \| timing=(.+?)\]/);
    if (qualifiedMatch && session) {
      session.qualifiedData = {
        jobType: qualifiedMatch[1],
        location: qualifiedMatch[2],
        timing: qualifiedMatch[3]
      };
      session.isQualified = true;
      console.log(`Lead qualified:`, session.qualifiedData);
    }

    // Strip the tag before sending to TTS
    const cleanReply = replyText.replace(/\[QUALIFIED:.*?\]/, "").trim();
    console.log(`Claude: "${cleanReply}"`);

    conversationHistory.push({ role: "assistant", content: cleanReply });

    await textToSpeechAndStream(ws, streamSid, cleanReply);

  } catch (err) {
    console.error("Claude error:", err.message);
  }
}

// ─── Handle Call Ended ────────────────────────────────────────────────────────

async function handleCallEnded(session) {
  const { leadName, callSid, conversationHistory, qualifiedData, isQualified } = session;

  console.log(`Call ended for ${leadName} — Qualified: ${isQualified}`);

  // Build transcript
  const transcript = conversationHistory
    .map(m => `${m.role === "user" ? leadName : "AI"}: ${m.content}`)
    .join("\n");

  if (!isQualified) {
    console.log("Lead not qualified — skipping HubSpot update and notifications");
    return;
  }

  try {
    // 1. Find the contact in HubSpot by name
    const contactId = await findHubSpotContact(leadName);

    if (contactId) {
      // 2. Log note on contact
      await logHubSpotNote(contactId, leadName, qualifiedData, transcript);

      // 3. Move deal to Contacted stage
      await updateDealStage(contactId, leadName);
    } else {
      console.warn(`No HubSpot contact found for ${leadName}`);
    }

    // 4. Send SMS notification to you
    await sendSMSNotification(leadName, qualifiedData);

    console.log("All post-call actions completed successfully");

  } catch (err) {
    console.error("Post-call error:", err.message);
  }
}

// ─── HubSpot Functions ────────────────────────────────────────────────────────

async function findHubSpotContact(leadName) {
  try {
    const firstName = leadName.split(" ")[0];

    const response = await fetch(
      `https://api.hubapi.com/crm/v3/objects/contacts/search`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${HUBSPOT_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          filterGroups: [{
            filters: [{
              propertyName: "firstname",
              operator: "EQ",
              value: firstName
            }]
          }],
          limit: 1
        })
      }
    );

    const data = await response.json();
    const contactId = data.results?.[0]?.id;
    console.log(`HubSpot contact found: ${contactId}`);
    return contactId;

  } catch (err) {
    console.error("HubSpot contact search error:", err.message);
    return null;
  }
}

async function logHubSpotNote(contactId, leadName, qualifiedData, transcript) {
  try {
    // Create the note as an engagement
    const noteResponse = await fetch(
      `https://api.hubapi.com/crm/v3/objects/notes`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${HUBSPOT_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          properties: {
            hs_note_body: `📞 AI Caller - Qualified Lead\n\nName: ${leadName}\nJob Type: ${qualifiedData.jobType}\nLocation: ${qualifiedData.location}\nTiming: ${qualifiedData.timing}\n\n--- Full Transcript ---\n${transcript}`,
            hs_timestamp: Date.now()
          },
          associations: [{
            to: { id: contactId },
            types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }]
          }]
        })
      }
    );

    const noteData = await noteResponse.json();
    console.log("HubSpot note logged:", noteData.id);

  } catch (err) {
    console.error("HubSpot note error:", err.message);
  }
}

async function updateDealStage(contactId, leadName) {
  try {
    // First find associated deal
    const dealsResponse = await fetch(
      `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}/associations/deals`,
      {
        headers: { "Authorization": `Bearer ${HUBSPOT_API_KEY}` }
      }
    );

    const dealsData = await dealsResponse.json();
    const dealId = dealsData.results?.[0]?.id;

    if (!dealId) {
      console.warn(`No deal found for contact ${contactId} — creating one`);
      await createDeal(contactId, leadName);
      return;
    }

    // Update existing deal stage
    const updateResponse = await fetch(
      `https://api.hubapi.com/crm/v3/objects/deals/${dealId}`,
      {
        method: "PATCH",
        headers: {
          "Authorization": `Bearer ${HUBSPOT_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          properties: {
            dealstage: HUBSPOT_CONTACTED_STAGE,
            pipeline: HUBSPOT_PIPELINE_ID
          }
        })
      }
    );

    console.log("Deal stage updated to Contacted");

  } catch (err) {
    console.error("HubSpot deal update error:", err.message);
  }
}

async function createDeal(contactId, leadName) {
  try {
    const response = await fetch(
      `https://api.hubapi.com/crm/v3/objects/deals`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${HUBSPOT_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          properties: {
            dealname: `${leadName} - Electrician Enquiry`,
            dealstage: HUBSPOT_CONTACTED_STAGE,
            pipeline: HUBSPOT_PIPELINE_ID
          },
          associations: [{
            to: { id: contactId },
            types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 3 }]
          }]
        })
      }
    );

    const data = await response.json();
    console.log("New deal created:", data.id);

  } catch (err) {
    console.error("HubSpot deal creation error:", err.message);
  }
}

// ─── SMS Notification ─────────────────────────────────────────────────────────

async function sendSMSNotification(leadName, qualifiedData) {
  try {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const fromNumber = process.env.TWILIO_NUMBER;

    const message = `🔌 ElectraBoostAI - New Qualified Lead!\n\nName: ${leadName}\nJob: ${qualifiedData.jobType}\nLocation: ${qualifiedData.location}\nTiming: ${qualifiedData.timing}\n\nLog into HubSpot to follow up.`;

    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      {
        method: "POST",
        headers: {
          "Authorization": `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({
          To: NOTIFY_PHONE,
          From: fromNumber,
          Body: message
        })
      }
    );

    const data = await response.json();
    console.log("SMS notification sent:", data.sid);

  } catch (err) {
    console.error("SMS notification error:", err.message);
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
