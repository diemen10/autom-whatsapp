import 'dotenv/config';
import axios from "axios";

// Utilidad simple para escapar el XML de TwiML
function escapeXml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Genera una respuesta con IA usando OpenAI (vía HTTP con axios)
async function generateAiReply({ userText, from }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.warn("OPENAI_API_KEY no configurada; devolviendo respuesta por defecto");
    return "¡Gracias por escribirnos! ¿En qué puedo ayudarte hoy?";
  }

  try {
    const payload = {
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "Eres un agente de atención al cliente por WhatsApp para una empresa. Responde en español, con tono cercano, breve y profesional. Consigue la información esencial (nombre, necesidad, presupuesto, ubicación, horario). Si el usuario pregunta por productos/servicios o precios, pide contexto para poder recomendar. No uses listas largas ni formato markdown; mantén respuestas concisas. Si no hay suficiente contexto, haz 1-2 preguntas claras.",
        },
        {
          role: "user",
          content: `Mensaje del cliente (${from}): ${userText}`,
        },
      ],
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
    console.error("Error al generar respuesta con OpenAI:", err?.response?.data || err.message);
    return "Gracias por tu mensaje. En breve un asesor humano te responde.";
  }
}

// Envía un WhatsApp vía API REST de Twilio (opcional)
async function sendWhatsAppViaTwilio({ to, body }) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_WHATSAPP_FROM; // ej. whatsapp:+14155238886 o +1415...
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID; // opcional

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
    if (messagingServiceSid) {
      form.append("MessagingServiceSid", messagingServiceSid);
    } else if (fromWa) {
      form.append("From", fromWa);
    }

    const resp = await axios.post(url, form.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      auth: { username: accountSid, password: authToken },
      timeout: 15000,
      validateStatus: () => true,
    });

    if (resp.status >= 200 && resp.status < 300) return true;
    console.error("Twilio REST devolvió estado:", resp.status, resp.data);
    return false;
  } catch (err) {
    console.error("Error enviando por Twilio REST:", err?.response?.data || err.message);
    return false;
  }
}

/** Lee el raw body del request (necesario porque Twilio manda x-www-form-urlencoded) */
async function readRawBody(req) {
  return await new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/** Convierte x-www-form-urlencoded → objeto JS */
function parseFormUrlEncoded(str) {
  const params = new URLSearchParams(str);
  const obj = {};
  for (const [k, v] of params.entries()) obj[k] = v;
  return obj;
}

export default async function handler(req, res) {
  // Solo aceptar POST (Twilio enviará POST)
  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }

  // 1️⃣ Leer el cuerpo del mensaje
  const raw = await readRawBody(req);
  const body = parseFormUrlEncoded(raw);

  // 2️⃣ Extraer info relevante
  const from = (body.From || "").replace("whatsapp:", ""); // +34123456789
  const text = (body.Body || "").trim();

  console.log("📩 Nuevo mensaje entrante desde WhatsApp:", from, "→", text);

  // 3️⃣ Crear payload para Brevo
  const payload = {
    sms: from,
    attributes: {
      SOURCE: "WhatsApp",
      FIRST_MSG: text,
      WHATSAPP_OPTIN: true,
    },
    updateEnabled: true,
  };

  const listId = process.env.BREVO_LIST_ID;
  if (listId) payload.listIds = [Number(listId)];

  // 4️⃣ Enviar a Brevo
  try {
    await axios.post("https://api.brevo.com/v3/contacts", payload, {
      headers: {
        "api-key": process.env.BREVO_API_KEY,
        "Content-Type": "application/json",
      },
      timeout: 10000,
    });
    console.log("✅ Contacto creado/actualizado en Brevo:", from);
  } catch (e) {
    console.error("❌ Error enviando a Brevo:", e?.response?.data || e.message);
  }

  // 5️⃣ Responder a Twilio
  const aiReply = await generateAiReply({ userText: text, from });
  const sentViaRest = await sendWhatsAppViaTwilio({ to: from, body: aiReply });
  if (sentViaRest) { res.status(200).send("OK"); return; }
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Message>${escapeXml(aiReply)}</Message></Response>`;
  res.setHeader("Content-Type", "text/xml");
  res.status(200).send(twiml);
}
