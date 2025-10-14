import 'dotenv/config';
import axios from "axios";
import { kv } from "@vercel/kv";

function escapeXml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function generateAiReply({ userText, from, history = [] }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.warn("OPENAI_API_KEY no configurada; usando fallback");
    return "¡Gracias por escribirnos! ¿En qué puedo ayudarte hoy?";
  }

  try {
    const system = {
      role: "system",
      content:
        "Eres un agente de atención al cliente por WhatsApp para una empresa. Responde en español, con tono cercano, breve y profesional. Consigue la información esencial (nombre, necesidad, presupuesto, ubicación, horario). Si el usuario pregunta por productos/servicios o precios, pide contexto. No uses listas largas ni markdown; mantén respuestas concisas. Si no hay suficiente contexto, haz 1-2 preguntas claras.",
    };

    const messages = [system, ...history, { role: "user", content: `Mensaje del cliente (${from}): ${userText}` }];

    const payload = {
      model: "gpt-4o-mini",
      messages,
      temperature: 0.6,
      max_tokens: 220,
    };

    const { data } = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      payload,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        timeout: 15000,
      }
    );

    const reply = data?.choices?.[0]?.message?.content?.trim();
    return reply || "¡Gracias por escribirnos! ¿En qué puedo ayudarte hoy?";
  } catch (err) {
    console.error("[ai] error:", err?.response?.data || err.message);
    return "Gracias por tu mensaje. En breve un asesor humano te responde.";
  }
}

// OpenAI Assistants: gestiona un thread por número y ejecuta un run
async function ensureAssistantThread({ from }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const kvKey = `wa:${from}:thread`;
  try {
    const existing = await kv.get(kvKey);
    if (existing && typeof existing === 'string') return existing;
  } catch {}
  try {
    const { data } = await axios.post(
      'https://api.openai.com/v1/threads',
      {},
      { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 10000 }
    );
    const threadId = data?.id;
    if (threadId) {
      await kv.set(kvKey, threadId, { ex: 60 * 60 * 24 * 30 });
      return threadId;
    }
  } catch (e) {
    console.error('[assistants] create thread error', e?.response?.data || e.message);
  }
  return null;
}

async function generateAssistantReply({ from, userText }) {
  const apiKey = process.env.OPENAI_API_KEY;
  const assistantId = process.env.OPENAI_ASSISTANT_ID;
  if (!apiKey || !assistantId) return null;

  try {
    const threadId = await ensureAssistantThread({ from });
    if (!threadId) return null;

    // Add user message to thread
    await axios.post(
      `https://api.openai.com/v1/threads/${threadId}/messages`,
      { role: 'user', content: userText },
      { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 10000 }
    );

    // Create a run
    const runResp = await axios.post(
      `https://api.openai.com/v1/threads/${threadId}/runs`,
      { assistant_id: assistantId },
      { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 10000 }
    );
    const runId = runResp?.data?.id;
    if (!runId) return null;

    // Poll run status up to ~12s
    const started = Date.now();
    const deadline = started + 12000;
    let status = runResp?.data?.status;
    while (Date.now() < deadline && status && status !== 'completed' && status !== 'failed' && status !== 'cancelled' && status !== 'expired') {
      await new Promise(r => setTimeout(r, 1000));
      try {
        const { data: run } = await axios.get(
          `https://api.openai.com/v1/threads/${threadId}/runs/${runId}`,
          { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 8000 }
        );
        status = run?.status;
      } catch (e) {
        console.warn('[assistants] poll error', e?.response?.data || e.message);
        break;
      }
    }

    if (status !== 'completed') return null;

    // Fetch latest assistant message
    const { data: msgs } = await axios.get(
      `https://api.openai.com/v1/threads/${threadId}/messages?limit=1&order=desc`,
      { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 8000 }
    );
    const latest = msgs?.data?.[0];
    const parts = latest?.content || [];
    const textPart = parts.find(p => p?.type === 'text');
    const value = textPart?.text?.value?.trim();
    return value || null;
  } catch (e) {
    console.error('[assistants] error', e?.response?.data || e.message);
    return null;
  }
}

async function sendWhatsAppViaTwilio({ to, body }) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_WHATSAPP_FROM;
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;

  if (!accountSid || !authToken || (!fromNumber && !messagingServiceSid)) {
    return false;
  }

  const toWa = to && to.startsWith("whatsapp:") ? to : `whatsapp:${to}`;
  const fromWa = fromNumber
    ? fromNumber.startsWith("whatsapp:")
      ? fromNumber
      : `whatsapp:${fromNumber}`
    : undefined;

  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
    const form = new URLSearchParams();
    form.append("To", toWa);
    form.append("Body", body);
    if (messagingServiceSid) form.append("MessagingServiceSid", messagingServiceSid);
    else if (fromWa) form.append("From", fromWa);

    const resp = await axios.post(url, form.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      auth: { username: accountSid, password: authToken },
      timeout: 15000,
      validateStatus: () => true,
    });

    if (resp.status >= 200 && resp.status < 300) return true;
    console.error("[twilio] REST status:", resp.status, resp.data);
    return false;
  } catch (err) {
    console.error("[twilio] REST error:", err?.response?.data || err.message);
    return false;
  }
}

async function readRawBody(req) {
  return await new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function parseFormUrlEncoded(str) {
  const params = new URLSearchParams(str);
  const obj = {};
  for (const [k, v] of params.entries()) obj[k] = v;
  return obj;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }

  const raw = await readRawBody(req);
  const body = parseFormUrlEncoded(raw);

  const from = (body.From || "").replace(/^whatsapp:/i, "").trim();
  const text = (body.Body || "").trim();

  console.log("[twilio] from:", body.From, "parsed:", from);
  console.log("[twilio] text length:", text.length);

  // Cargar historial (memoria) desde Vercel KV
  const kvKey = from ? `wa:${from}` : null;
  let history = [];
  if (kvKey) {
    try {
      const stored = await kv.get(kvKey);
      if (Array.isArray(stored)) {
        history = stored.filter(m => m && typeof m.role === 'string' && typeof m.content === 'string');
      }
    } catch (e) {
      console.warn("[kv] get error:", e?.message || e);
    }
  }

  const attributes = {
    SOURCE: "WhatsApp",
    FIRST_MSG: text,
    WHATSAPP_OPTIN: true,
  };

  const payload = {
    sms: from,
    attributes,
    updateEnabled: true,
  };

  const listId = process.env.BREVO_LIST_ID;
  if (listId) {
    const n = Number(listId);
    if (Number.isFinite(n)) payload.listIds = [n];
    else console.warn("[config] BREVO_LIST_ID no es numérico:", listId);
  }

  try {
    console.log("[brevo] sending payload has sms?", Boolean(payload.sms), payload.sms);
    const response = await axios.post(
      "https://api.brevo.com/v3/contacts",
      payload,
      { headers: { "api-key": process.env.BREVO_API_KEY, "Content-Type": "application/json" }, timeout: 10000, validateStatus: () => true }
    );
    console.log("[brevo] status:", response.status);
    if (response.status >= 200 && response.status < 300) console.log("[brevo] ok");
    else console.error("[brevo] error", response.data);
  } catch (e) {
    console.error("[brevo] error de red", e?.response?.data || e.message);
  }

  const MAX_MSGS = 20; // últimos 10 turnos (user+assistant)
  const limitedHistory = history.slice(-MAX_MSGS);
  // Si hay OPENAI_ASSISTANT_ID, usar Assistants; si no, chat completions
  let aiReply = null;
  if (process.env.OPENAI_ASSISTANT_ID) {
    aiReply = await generateAssistantReply({ from, userText: text });
  }
  if (!aiReply) {
    aiReply = await generateAiReply({ userText: text, from, history: limitedHistory });
  }

  // Guardar nuevo historial (recortando y con TTL)
  if (kvKey) {
    try {
      const updated = [...limitedHistory, { role: 'user', content: text }, { role: 'assistant', content: aiReply }].slice(-MAX_MSGS);
      await kv.set(kvKey, updated, { ex: 60 * 60 * 24 * 30 }); // 30 días
    } catch (e) {
      console.warn("[kv] set error:", e?.message || e);
    }
  }
  const sentViaRest = await sendWhatsAppViaTwilio({ to: from, body: aiReply });
  if (sentViaRest) { res.status(200).send("OK"); return; }
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Message>${escapeXml(aiReply)}</Message></Response>`;
  res.setHeader("Content-Type", "text/xml");
  res.status(200).send(twiml);
}
