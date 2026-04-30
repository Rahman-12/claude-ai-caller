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
const scheduledCallbacks = new Map();

// ─── UK Time Parser ───────────────────────────────────────────────────────────

function parseCallbackTime(timeStr) {
  const now = new Date();
  const ukOffset = isUKSummerTime(now) ? 60 : 0;
  const ukNow = new Date(now.getTime() + ukOffset * 60000);
  const str = timeStr.toLowerCase().trim();

  const inMatch = str.match(/in (\d+)\s*(minute|hour|min|hr)s?/);
  if (inMatch) {
    const amount = parseInt(inMatch[1]);
    const unit = inMatch[2].startsWith("h") ? 60 : 1;
    return new Date(now.getTime() + amount * unit * 60000);
  }

  if (str.includes("few hours") || str.includes("couple of hours")) {
    return new Date(now.getTime() + 3 * 60 * 60 * 1000);
  }
  if (str.includes("later today") || str.includes("later on")) {
    return new Date(now.getTime() + 4 * 60 * 60 * 1000);
  }
  if (str.includes("this afternoon")) {
    const d = new Date(ukNow);
    d.setHours(14, 0, 0, 0);
    if (d <= ukNow) d.setDate(d.getDate() + 1);
    return new Date(d.getTime() - ukOffset * 60000);
  }
  if (str.includes("this evening") || str.includes("tonight")) {
    const d = new Date(ukNow);
    d.setHours(19, 0, 0, 0);
    if (d <= ukNow) d.setDate(d.getDate() + 1);
    return new Date(d.getTime() - ukOffset * 60000);
  }
  if (str.includes("this morning")) {
    const d = new Date(ukNow);
    d.setHours(9, 0, 0, 0);
    if (d <= ukNow) d.setDate(d.getDate() + 1);
    return new Date(d.getTime() - ukOffset * 60000);
  }
  if (str.includes("next week") || str.includes("sometime next week")) {
    const d = nextWeekday(ukNow, 1, 10, 0);
    return new Date(d.getTime() - ukOffset * 60000);
  }

  const timeMatch = str.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  let hours = timeMatch ? parseInt(timeMatch[1]) : 9;
  let minutes = timeMatch && timeMatch[2] ? parseInt(timeMatch[2]) : 0;
  const ampm = timeMatch ? timeMatch[3] : null;

  if (ampm === "pm" && hours < 12) hours += 12;
  if (ampm === "am" && hours === 12) hours = 0;

  let targetDate = new Date(ukNow);
  targetDate.setHours(hours, minutes, 0, 0);

  if (str.includes("tomorrow")) {
    targetDate.setDate(targetDate.getDate() + 1);
  } else if (str.includes("monday")) {
    targetDate = nextWeekday(ukNow, 1, hours, minutes);
  } else if (str.includes("tuesday")) {
    targetDate = nextWeekday(ukNow, 2, hours, minutes);
  } else if (str.includes("wednesday")) {
    targetDate = nextWeekday(ukNow, 3, hours, minutes);
  } else if (str.includes("thursday")) {
    targetDate = nextWeekday(ukNow, 4, hours, minutes);
  } else if (str.includes("friday")) {
    targetDate = nextWeekday(ukNow, 5, hours, minutes);
  } else if (str.includes("saturday")) {
    targetDate = nextWeekday(ukNow, 6, hours, minutes);
  } else if (str.includes("sunday")) {
    targetDate = nextWeekday(ukNow, 0, hours, minutes);
  } else {
    const dateMatch = str.match(/(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)/);
    if (dateMatch) {
      const day = parseInt(dateMatch[1]);
      targetDate.setDate(day);
      if (targetDate < ukNow) {
        targetDate.setMonth(targetDate.getMonth() + 1);
      }
    } else {
      if (targetDate <= ukNow) {
        targetDate.setDate(targetDate.getDate() + 1);
      }
    }
  }

  return new Date(targetDate.getTime() - ukOffset * 60000);
}

function nextWeekday(from, dayOfWeek, hours, minutes) {
  const date = new Date(from);
  const current = date.getDay();
  let daysUntil = dayOfWeek - current;
  if (daysUntil <= 0) daysUntil += 7;
  date.setDate(date.getDate() + daysUntil);
  date.setHours(hours, minutes, 0, 0);
  return date;
}

function isUKSummerTime(date) {
  const year = date.getFullYear();
  const lastSundayMarch = getLastSunday(year, 2);
  const lastSundayOctober = getLastSunday(year, 9);
  return date >= lastSundayMarch && date < lastSundayOctober;
}

function getLastSunday(year, month) {
  const date = new Date(year, month + 1, 0);
  date.setDate(date.getDate() - date.getDay());
  date.setHours(1, 0, 0, 0);
  return date;
}

// ─── Callback Scheduler ───────────────────────────────────────────────────────

function scheduleCallback(leadName, phone, callbackTimeStr) {
  try {
    const callbackDate = parseCallbackTime(callbackTimeStr);
    const now = new Date();
    const delay = callbackDate.getTime() - now.getTime();

    if (delay <= 0) {
      console.warn(`Callback time already passed for ${leadName} — scheduling in 5 minutes instead`);
      scheduleCallbackInMs(leadName, phone, 5 * 60 * 1000, callbackTimeStr);
      return;
    }

    const ukTime = new Date(callbackDate.getTime() + (isUKSummerTime(callbackDate) ? 60 : 0) * 60000);
    console.log(`Callback scheduled for ${leadName} at ${ukTime.toLocaleString("en-GB")} (in ${Math.round(delay / 60000)} minutes)`);

    scheduleCallbackInMs(leadName, phone, delay, callbackTimeStr);

  } catch (err) {
    console.error("Callback scheduling error:", err.message);
  }
}

function scheduleCallbackInMs(leadName, phone, delayMs, callbackTimeStr) {
  const callbackId = `${leadName}-${Date.now()}`;

  const timeout = setTimeout(async () => {
    console.log(`Triggering scheduled callback for ${leadName}`);
    await triggerCallback(leadName, phone);
    scheduledCallbacks.delete(callbackId);
  }, delayMs);

  scheduledCallbacks.set(callbackId, {
    leadName,
    phone,
    callbackTimeStr,
    timeout,
    scheduledAt: new Date()
  });

  console.log(`Callback registered — ID: ${callbackId}, Total scheduled: ${scheduledCallbacks.size}`);
}

async function triggerCallback(leadName, phone) {
  try {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const fromNumber = process.env.TWILIO_NUMBER;
    const streamUrl = process.env.STREAM_URL;
    const streamDomain = process.env.STREAM_URL_DOMAIN;

    const safeLeadName = leadName
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Start>
          <Transcription
            track="inbound_track"
            statusCallbackUrl="https://${streamDomain}/transcription"
            partialResults="false"
            languageCode="en-US"
          />
        </Start>
        <Connect>
          <Stream url="${streamUrl}">
            <Parameter name="leadName" value="${safeLeadName}" />
            <Parameter name="leadPhone" value="${phone}" />
            <Parameter name="isCallback" value="true" />
          </Stream>
        </Connect>
      </Response>`;

    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`,
      {
        method: "POST",
        headers: {
          "Authorization": `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({
          To: phone,
          From: fromNumber,
          Twiml: twiml
        })
      }
    );

    const data = await response.json();
    console.log(`Callback call triggered — SID: ${data.sid}`);

  } catch (err) {
    console.error("Trigger callback error:", err.message);
  }
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/transcription") {
    let body = "";
    req.on("data", chunk => body += chunk.toString());
    req.on("end", async () => {
      try {
        const params = new URLSearchParams(body);
        const callSid = params.get("CallSid");
        const isFinal = params.get("Final") === "true" || params.get("TranscriptionStatus") === "completed";

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

            if (session.hasSignedOff) {
              console.log("Call already concluded — ignoring transcript");
              res.writeHead(200);
              res.end("OK");
              return;
            }

            if (session.isSpeaking) {
              console.log("Still speaking — ignoring transcript");
              res.writeHead(200);
              res.end("OK");
              return;
            }

            if (!session.hasGreeted) session.hasGreeted = true;

            const { ws, streamSid, conversationHistory, leadName } = session;
            console.log(`Customer said: "${transcript}"`);

            await sendClaudeResponse({
              ws,
              streamSid,
              conversationHistory,
              leadName,
              isCallback: session.isCallback,
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
  let leadPhone = null;
  let callSid = null;
  let streamSid = null;
  let isCallback = false;
  const conversationHistory = [];

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.event) {
      case "start":
        streamSid = msg.start.streamSid;
        callSid = msg.start.callSid;
        leadName = msg.start.customParameters?.leadName || "Customer";
        leadPhone = msg.start.customParameters?.leadPhone || null;
        isCallback = msg.start.customParameters?.isCallback === "true";

        console.log(`Stream started — Call: ${callSid}, Lead: ${leadName}, Callback: ${isCallback}`);

        sessions.set(callSid, {
          ws,
          streamSid,
          conversationHistory,
          leadName,
          leadPhone,
          callSid,
          isCallback,
          isSpeaking: false,
          isQualified: false,
          hasSignedOff: false,
          callbackRequested: false,
          callbackTime: null,
          hasGreeted: false,
          qualifiedData: { jobType: null, location: null, timing: null }
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

  ws.on("close", () => console.log("Stream WS closed"));
  ws.on("error", (err) => console.error("Stream WS error:", err));
}

// ─── Claude + TTS ─────────────────────────────────────────────────────────────

async function sendClaudeResponse({ ws, streamSid, conversationHistory, leadName, userMessage, session, isCallback }) {
  try {
    if (userMessage) {
      conversationHistory.push({ role: "user", content: userMessage });
    }

    const messages = conversationHistory.length > 0
      ? conversationHistory
      : [{ role: "user", content: "Begin the conversation." }];

    const callbackIntro = isCallback
      ? `This is a scheduled callback call — the customer previously asked to be called back at this time. Greet them warmly, remind them you are calling back as requested, and continue from where you left off collecting their electrician enquiry details.`
      : `You are calling ${leadName} because they just filled out a form showing interest in hiring a qualified local electrician.`;

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 200,
      system: `You are a friendly and professional call handler named James, working for ${BUSINESS_NAME}, a company that connects homeowners and businesses with qualified local electricians.
${callbackIntro}

Your goals in this exact order are:
1. Greet them warmly by name, introduce yourself as James from ${BUSINESS_NAME}, confirm you are calling about their electrician enquiry, and ALWAYS ask if now is a good time to chat before proceeding
2. Only if they confirm it is a good time — ask what electrical work they need done
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
- If the customer says it is not a good time, ask when would be better — if they give a vague answer like "in a few hours" or "later today" that is fine, accept it and confirm you will call them back
- If the customer gives a callback time (exact or vague), confirm it warmly and say goodbye
- Once you have collected all 3 pieces of information (job type, location, timing) thank them warmly and say goodbye
- Always be warm, confident and brief

IMPORTANT: Once you have collected job type, location and timing — include this exact tag at the end of your response (invisible to the customer):
[QUALIFIED: jobType=<job> | location=<location> | timing=<timing>]

If the customer requests a callback at a specific or vague time, include this tag instead:
[CALLBACK: time=<exact time and date they gave, or vague phrase like "in a few hours">]`,
      messages
    });

    const replyText = response.content[0].text;

    const qualifiedMatch = replyText.match(/\[QUALIFIED: jobType=(.+?) \| location=(.+?) \| timing=(.+?)\]/);
    if (qualifiedMatch && session) {
      session.qualifiedData = {
        jobType: qualifiedMatch[1],
        location: qualifiedMatch[2],
        timing: qualifiedMatch[3]
      };
      session.isQualified = true;
      session.hasSignedOff = true;
      console.log(`Lead qualified:`, session.qualifiedData);
    }

    const callbackMatch = replyText.match(/\[CALLBACK: time=(.+?)\]/);
    if (callbackMatch && session) {
      session.callbackTime = callbackMatch[1];
      session.callbackRequested = true;
      session.hasSignedOff = true;
      console.log(`Callback requested for: ${session.callbackTime}`);
    }

    const cleanReply = replyText
      .replace(/\[QUALIFIED:.*?\]/, "")
      .replace(/\[CALLBACK:.*?\]/, "")
      .trim();

    console.log(`Claude: "${cleanReply}"`);
    conversationHistory.push({ role: "assistant", content: cleanReply });

    await textToSpeechAndStream(ws, streamSid, cleanReply, session);

  } catch (err) {
    console.error("Claude error:", err.message);
  }
}

// ─── Handle Call Ended ────────────────────────────────────────────────────────

async function handleCallEnded(session) {
  const { leadName, leadPhone, conversationHistory, qualifiedData, isQualified, callbackRequested, callbackTime } = session;

  console.log(`Call ended for ${leadName} — Qualified: ${isQualified}, Callback: ${callbackRequested}`);

  const transcript = conversationHistory
    .map(m => `${m.role === "user" ? leadName : "James"}: ${m.content}`)
    .join("\n");

  if (isQualified) {
    console.log(`Lead qualified — processing HubSpot update`);
    try {
      const contactId = await findHubSpotContact(leadName, leadPhone);
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

  } else if (callbackRequested && callbackTime && leadPhone) {
    console.log(`Callback requested for ${leadName} at ${callbackTime}`);
    try {
      const contactId = await findHubSpotContact(leadName, leadPhone);
      if (contactId) {
        await logHubSpotNote(
          contactId,
          leadName,
          { jobType: "Callback requested", location: "TBC", timing: callbackTime },
          transcript
        );
      } else {
        console.warn(`No HubSpot contact found for ${leadName}`);
      }
      scheduleCallback(leadName, leadPhone, callbackTime);
      await sendCallbackSMSNotification(leadName, callbackTime);
      console.log("Callback scheduled and logged successfully");
    } catch (err) {
      console.error("Callback post-call error:", err.message);
    }

  } else if (callbackRequested && !leadPhone) {
    console.warn(`Callback requested but no phone number available for ${leadName} — cannot auto-schedule`);
    await sendCallbackSMSNotification(leadName, callbackTime || "time not captured");

  } else {
    console.log("Call ended without qualification or callback — no action taken");
  }
}

// ─── HubSpot Functions ────────────────────────────────────────────────────────

async function findHubSpotContact(leadName, leadPhone) {
  try {
    if (leadPhone) {
      const cleanPhone = leadPhone.replace(/\s+/g, '');

      const phoneResponse = await fetch(
        `https://api.hubapi.com/crm/v3/objects/contacts/search`,
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${HUBSPOT_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            filterGroups: [
              {
                filters: [{
                  propertyName: "phone",
                  operator: "CONTAINS_TOKEN",
                  value: cleanPhone
                }]
              },
              {
                filters: [{
                  propertyName: "mobilephone",
                  operator: "CONTAINS_TOKEN",
                  value: cleanPhone
                }]
              }
            ],
            limit: 1
          })
        }
      );

      const phoneData = await phoneResponse.json();
      const contactId = phoneData.results?.[0]?.id;
      if (contactId) {
        console.log(`HubSpot contact found by phone: ${contactId}`);
        return contactId;
      }
    }

    const firstName = leadName.split(" ")[0];
    const lastName = leadName.split(" ")[1] || "";

    const response = await fetch(
      `https://api.hubapi.com/crm/v3/objects/contacts/search`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${HUBSPOT_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          filterGroups: [
            {
              filters: [
                {
                  propertyName: "firstname",
                  operator: "CONTAINS_TOKEN",
                  value: firstName
                },
                {
                  propertyName: "lastname",
                  operator: "CONTAINS_TOKEN",
                  value: lastName
                }
              ]
            },
            {
              filters: [
                {
                  propertyName: "firstname",
                  operator: "CONTAINS_TOKEN",
                  value: firstName
                }
              ]
            }
          ],
          limit: 1
        })
      }
    );

    const data = await response.json();
    const contactId = data.results?.[0]?.id;
    console.log(`HubSpot contact found by name: ${contactId}`);
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
            hs_note_body: `📞 AI Caller - ${qualifiedData.jobType === "Callback requested" ? "Callback Requested" : "Qualified Lead"}\n\nName: ${leadName}\nJob Type: ${qualifiedData.jobType}\nLocation: ${qualifiedData.location}\nTiming: ${qualifiedData.timing}\n\n--- Full Transcript ---\n${transcript}`,
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

// ─── SMS Notifications ────────────────────────────────────────────────────────

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

async function sendCallbackSMSNotification(leadName, callbackTime) {
  try {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const fromNumber = process.env.TWILIO_NUMBER;

    const message = `🔌 ElectraBoostAI - Callback Scheduled!\n\nName: ${leadName}\nCallback at: ${callbackTime}\n\nThe system will automatically call them back at this time.`;

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
    console.log("Callback SMS sent:", data.sid);

  } catch (err) {
    console.error("Callback SMS error:", err.message);
  }
}

// ─── Text to Speech ───────────────────────────────────────────────────────────

async function textToSpeechAndStream(ws, streamSid, text, session) {
  try {
    if (session) session.isSpeaking = true;

    const XI_API_KEY = process.env.ELEVENLABS_API_KEY;
    const VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

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
  } finally {
    // Cooldown after speaking to avoid catching our own echo
    await new Promise(resolve => setTimeout(resolve, 1500));
    if (session) session.isSpeaking = false;
  }
}

// ─── Start Server ─────────────────────────────────────────────────────────────

server.listen(PORT, "0.0.0.0", () => {
  console.log(`${BUSINESS_NAME} AI Caller running on port ${PORT}`);
});

setInterval(() => console.log("Server alive"), 30000);
process.on("uncaughtException", console.error);
process.on("unhandledRejection", console.error);
