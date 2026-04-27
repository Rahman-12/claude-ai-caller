import { WebSocketServer } from "ws";
import { createServer } from "http";
import Anthropic from "@anthropic-ai/sdk";

const PORT = process.env.PORT || 8080;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const BUSINESS_NAME = process.env.BUSINESS_NAME || "ElectraBoostAI";
const HUBSPOT_API_KEY = process.env.HUBSPOT_API_KEY;
const NOTIFY_PHONE = "+447840910698";
const HUBSPOT_PIPELINE_ID = "default";
const HUBSPOT_CONTACTED_STAGE = "qualifiedtobuy";

const sessions = new Map();

// HTTP server handles both transcription POST callbacks and WebSocket upgrades
const server = createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/transcription") {
    let body = "";
    req.on("data", chunk => body += chunk.toString());
    req.on("end", async () => {
      try {
        const params = new URLSearchParams(body);
        const callSid = params.get("CallSid");
        const isFinal = params.get("Final") === "true" || params.get("TranscriptionStatus") === "completed";

        // Parse transcript — Twilio sometimes returns it as a JSON string
        let rawTranscript = params.get("TranscriptionText") || params.get("TranscriptionData");
        let transcript = rawTranscript;
        try {
          const parsed = JSON.parse(rawTranscript);
          if (parsed.transcript) transcript = parsed.transcript;
        } catch {
          // Not JSON, use as-is
        }

        console.log(`Transcription POST received — CallSid: ${callSid}, Final: ${isFinal}, Text: ${transcript}`);

        if (transcript && callSid && isFinal) {
          const session = sessions.get(callSid);
          if (session) {
            const { ws, streamSid, conversationHistory, leadName } = session;
            console.log(`Customer said: "${transcript}"`);
            await sendClaudeResponse({
              ws,
              streamSid,
              conversationHistory,
              leadName,
              userMessage: transcript,
              session
            });
          } else {
            console.warn(`No session found for CallSid: ${callSid}`);
          }
        }

        res.writeHead(200);
        res.end("OK");
      } catch (err) {
        console.error("Transcription POST error:", err);
        res.writeHead(500);
        res.end("Error");
      }
    });
    return;
  }

  // Default response
  res.writeHead(200);
  res.end(`${BUSINESS_NAME} AI Caller running`);
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  const url = req.url;
  if (url === "/stream" || url === "/") {
    handleTwilioStream(ws);
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
      system: `You are a friendly and professional call handler named James, working for ${BUSINESS_NAME}, a company that connects homeowners and businesses with qualified local electricians.
You are calling ${leadName} because they just filled out a form showing interest in hiring a qualified local electrician.

Your goals in this exact order are:
1. Greet them warmly by name, introduce yourself as James from ${BUSINESS_NAME}, and confirm you are calling about their electrician enquiry
2. Ask what electrical work they need done
3. Ask for their postcode or general area so you can match them with a local electrician
4. Ask when they need the work done — urgently, within the week, or just planning ahead
5. Thank them, let them know a qualified local electrician from ${BUSINESS_NAME} will be in touch with them shortly, then say goodbye

Rules you must follow:
- Keep every response to 1-3 sentences maximum — this is a phone call not a chat
- Sound natural and human — never robotic or scripted
- Never mention you are an AI unless directly asked — if asked, say you are a call handler named James for ${BUSINESS_NAME}
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

  const transcript = conversationHistory
    .map(m => `${m.role === "user" ? leadName : "James"}: ${m.content}`)
    .join("\n");

  if (!isQualified) {
    console.log("Lead not qualified — skipping HubSpot update and notifications");
    return;
  }

  try {
    const contactId = await findHubSpotContact(leadName);

    if (contactId) {
      await logHubSpotNote(contactId, leadName, qualifiedData, transcript);
      await updateDealStage(contactId, leadName);
    } else {
      console.warn(`No HubSpot contact found for ${leadName}`);
    }

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

    await fetch(
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

    // Split into sentences so each plays quickly without waiting for full response
    const sentences = text
      .split(/(?<=[.!?])\s+/)
      .map(s => s.trim())
      .filter(s => s.length > 0);

    for (const sentence of sentences) {
      const response = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream?output_format=ulaw_8000&optimize_streaming_latency=3`,
        {
          method: "POST",
          headers: {
            "xi-api-key": XI_API_KEY,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            text: sentence,
            model_id: "eleven_turbo_v2",
            voice_settings: { stability: 0.5, similarity_boost: 0.75 }
          })
        }
      );

      if (!response.ok) {
        console.error("ElevenLabs error:", await response.text());
        continue;
      }

      const audioBuffer = await response.arrayBuffer();
      const base64Audio = Buffer.from(audioBuffer).toString("base64");

      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: base64Audio }
        }));
      } else {
        console.warn("WebSocket closed before audio could be sent");
        break;
      }
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
