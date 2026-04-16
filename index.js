require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(express.json());

const TOKEN = process.env.TELEGRAM_TOKEN;
const URL = process.env.WEBHOOK_URL;
const PORT = process.env.PORT || 3000;

const bot = new TelegramBot(TOKEN, { polling: false });

app.post(`/bot${TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// ══════════════════════════════════════════
// DATOS DE ARMONNIZA
// ══════════════════════════════════════════

const AGENDA_URL = 'www.armonniza.com';

const ESPECIALIDADES = {
  medicina: {
    nombre: '💉 Medicina Estética',
    doctor: 'Dr. Julio Lucia',
    tratamientos: [
      'Botox Facial (Toxina Botulínica) — Desde Bs 350',
      'Rellenos con Ácido Hialurónico — Desde Bs 450',
      'Hilos Tensores PDO — Desde Bs 600',
      'Plasma Rico en Plaquetas (PRP) — Desde Bs 400',
      'Bioestimuladores de Colágeno — Desde Bs 500',
      'Armonización Facial — Consultar precio',
    ]
  },
  cirugia: {
    nombre: '🏥 Cirugía Estética',
    doctor: 'Dr. Claudio Tejada',
    tratamientos: [
      'Botox (aplicación quirúrgica)',
      'Rellenos faciales avanzados',
      'Procedimientos faciales y corporales',
      'Consulta y valoración — Bs 50 (reembolsable)',
    ]
  },
  fisio: {
    nombre: '💆 Fisio-Estética',
    doctor: 'Téc. Valeria Mendoza',
    tratamientos: [
      'Depilación Láser ICE — Por zona',
      'Criolipólisis — Desde Bs 500',
      'Radiofrecuencia — Desde Bs 300',
      'Morpheus8 — Consultar precio',
      'Ultrasonido Focalizado (HIFU) — Desde Bs 600',
      'Modelado Corporal — Pack 5 sesiones',
    ]
  },
  cosmetologia: {
    nombre: '✨ Cosmetología',
    doctor: 'Lic. Princeica Tejada',
    tratamientos: [
      'HydraFacial — Desde Bs 350',
      'Dermapen (Microneedling) — Desde Bs 300',
      'Terapia LED — Desde Bs 150',
      'Peelings Químicos — Desde Bs 250',
      'Limpieza Facial Profunda — Desde Bs 200',
    ]
  }
};

const PROMOCIONES = [
  'Pack Rejuvenecimiento — 20% Off en Botox Full Face + Ácido Hialurónico',
  'Verano Perfecto — Lleva 5 sesiones de Modelado y paga solo 3',
  'Glow Up Inmediato — HydraFacial + LED con 30% de descuento',
];

const HORARIOS = [
  'Lic. Princeica Tejada — Lun a Vie: 09:00 AM – 06:00 PM',
  'Téc. Valeria Mendoza — Mar, Jue, Sáb: 09:00 AM – 05:00 PM',
  'Dr. Julio Lucia — Consultar disponibilidad',
  'Dr. Claudio Tejada — Consultar disponibilidad',
];

// ══════════════════════════════════════════
// SISTEMA PROMPT DE VALERIA (Claude AI)
// ══════════════════════════════════════════
const SYSTEM_PROMPT = `Eres Valeria, la asistente virtual de ARMONNIZA — una clínica médico-estética premium ubicada en La Paz, Bolivia.

Tu personalidad:
- Cálida, cercana y profesional a la vez — como una amiga experta en estética
- Usas emojis con moderación para dar calidez (no en exceso)
- Respondes de forma natural y conversacional, nunca robótica
- Eres empática y entiendes las inseguridades que a veces tienen los clientes sobre tratamientos estéticos
- Hablas en español boliviano/latinoamericano — tuteas a los clientes
- Eres concisa — no escribes párrafos larguísimos

Lo que puedes hacer:
- Informar sobre todos los tratamientos, precios y especialistas de ARMONNIZA
- Ayudar a agendar citas dirigiendo al cliente a www.armonniza.com
- Responder preguntas sobre procedimientos, recuperación, duración
- Dar recomendaciones según las necesidades del cliente
- Informar sobre promociones y precios

Información de ARMONNIZA:
📍 Ubicación: La Paz, Bolivia
🌐 Agenda online: www.armonniza.com
📱 WhatsApp: +591 78118003

ESPECIALIDADES Y TRATAMIENTOS:
💉 Medicina Estética — Dr. Julio Lucia
Botox Facial desde Bs 350, Rellenos Ácido Hialurónico desde Bs 450, Hilos Tensores PDO desde Bs 600, PRP desde Bs 400, Bioestimuladores desde Bs 500, Armonización Facial (consultar precio)

🏥 Cirugía Estética — Dr. Claudio Tejada
Botox quirúrgico, Rellenos faciales avanzados, Procedimientos faciales y corporales, Consulta Bs 50 reembolsable

💆 Fisio-Estética — Téc. Valeria Mendoza
Depilación Láser ICE, Criolipólisis desde Bs 500, Radiofrecuencia desde Bs 300, Morpheus8 (consultar), HIFU desde Bs 600, Modelado Corporal pack 5 sesiones

✨ Cosmetología — Lic. Princeica Tejada
HydraFacial desde Bs 350, Dermapen desde Bs 300, Terapia LED desde Bs 150, Peelings Químicos desde Bs 250, Limpieza Facial desde Bs 200

PROMOCIONES ACTIVAS:
- Pack Rejuvenecimiento — 20% Off en Botox Full Face + Ácido Hialurónico
- Verano Perfecto — Lleva 5 sesiones de Modelado y paga solo 3
- Glow Up Inmediato — HydraFacial + LED con 30% de descuento

HORARIOS:
- Lic. Princeica Tejada — Lun a Vie: 09:00 AM – 06:00 PM
- Téc. Valeria Mendoza — Mar, Jue, Sáb: 09:00 AM – 05:00 PM
- Dr. Julio Lucia y Dr. Claudio Tejada — Consultar disponibilidad

PRECIOS:
- Valoración inicial: Bs 50 (reembolsable si realizas el tratamiento)
- Pagos: tarjetas, QR, transferencias bancarias

Reglas importantes:
- NUNCA prometas resultados específicos o garantizados
- Si preguntan por precios de tratamientos complejos, sugiere valoración presencial
- Si el cliente quiere hablar con una persona real: WhatsApp +591 78118003
- Si preguntan algo que no sabes, sé honesta y ofrece conectarlos con el equipo
- Siempre ofrece agendar cuando sea apropiado: www.armonniza.com
- Máximo 3-4 oraciones por respuesta para no abrumar al cliente`;

// ══════════════════════════════════════════
// HISTORIAL DE CONVERSACIONES
// ══════════════════════════════════════════
const conversationHistory = {};

function getHistory(userId) {
  if (!conversationHistory[userId]) {
    conversationHistory[userId] = [];
  }
  return conversationHistory[userId];
}

function addToHistory(userId, role, content) {
  const history = getHistory(userId);
  history.push({ role, content });
  if (history.length > 20) {
    conversationHistory[userId] = history.slice(-20);
  }
}

// ══════════════════════════════════════════
// FUNCIÓN PRINCIPAL CLAUDE AI
// ══════════════════════════════════════════
async function askValeria(userId, userMessage) {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

  addToHistory(userId, 'user', userMessage);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        system: SYSTEM_PROMPT,
        messages: getHistory(userId)
      })
    });

    const data = await response.json();

    if (data.error) {
      console.error('Claude API error:', data.error);
      return 'Hola! Soy Valeria de ARMONNIZA 💆‍♀️ Tengo un problema técnico en este momento. Por favor escríbenos al WhatsApp +591 78118003 y te atendemos de inmediato 😊';
    }

    const reply = data.content[0].text;
    addToHistory(userId, 'assistant', reply);
    console.log(`🤖 Valeria → ${userId}: ${reply.substring(0, 100)}...`);
    return reply;

  } catch (err) {
    console.error('Error Claude AI:', err);
    return 'Hola! Soy Valeria de ARMONNIZA 💆‍♀️ Tengo un problema técnico. Por favor escríbenos al WhatsApp +591 78118003 😊';
  }
}

// ══════════════════════════════════════════
// TELEGRAM
// ══════════════════════════════════════════
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  if (!text) return;

  console.log(`📱 Telegram de ${chatId}: ${text}`);
  bot.sendChatAction(chatId, 'typing');
  const reply = await askValeria(`tg_${chatId}`, text);
  bot.sendMessage(chatId, reply);
});

bot.on('callback_query', (query) => {
  bot.answerCallbackQuery(query.id);
});

// ══════════════════════════════════════════
// WHATSAPP — ENVÍO
// ══════════════════════════════════════════
async function waSend(to, text) {
  const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
  const PHONE_ID = process.env.WHATSAPP_PHONE_ID;
  try {
    await fetch(`https://graph.facebook.com/v25.0/${PHONE_ID}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } })
    });
  } catch (err) { console.error('Error WA:', err); }
}

// ══════════════════════════════════════════
// MESSENGER — ENVÍO
// ══════════════════════════════════════════
async function fbSend(recipientId, text) {
  const FB_TOKEN = process.env.MESSENGER_TOKEN;
  try {
    await fetch(`https://graph.facebook.com/v25.0/me/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${FB_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: { id: recipientId }, message: { text } })
    });
  } catch (err) { console.error('Error Messenger:', err); }
}

// ══════════════════════════════════════════
// INSTAGRAM — ENVÍO
// ══════════════════════════════════════════
async function igSend(recipientId, text) {
  const IG_TOKEN = process.env.INSTAGRAM_TOKEN;
  const PAGE_ID = '100361346281528';
  try {
    const response = await fetch(`https://graph.facebook.com/v25.0/${PAGE_ID}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${IG_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: { id: recipientId }, message: { text } })
    });
    const data = await response.json();
    if (data.error) console.error('IG API error:', data.error);
  } catch (err) { console.error('Error IG:', err); }
}

// ══════════════════════════════════════════
// WEBHOOK
// ══════════════════════════════════════════
app.get('/webhook', (req, res) => {
  const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'armonniza2024';
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook verificado');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  const body = req.body;

  // WhatsApp
  if (body.object === 'whatsapp_business_account') {
    body.entry?.forEach(entry => {
      entry.changes?.forEach(change => {
        const messages = change.value?.messages;
        if (messages) {
          messages.forEach(async (message) => {
            const from = message.from;
            if (from.includes('78118003')) return;
            const text = message.text?.body || '';
            console.log(`📱 WhatsApp de ${from}: ${text}`);
            const reply = await askValeria(`wa_${from}`, text);
            await waSend(from, reply);
          });
        }
      });
    });
    res.sendStatus(200);
    return;
  }

  // Messenger
  if (body.object === 'page') {
    body.entry?.forEach(entry => {
      entry.messaging?.forEach(async (event) => {
        if (event.message && !event.message.is_echo) {
          const userId = event.sender.id;
          const text = event.message.text || '';
          console.log(`💬 Messenger DM de ${userId}: ${text}`);
          const reply = await askValeria(`fb_${userId}`, text);
          await fbSend(userId, reply);
        }
      });
    });
    res.sendStatus(200);
    return;
  }

  // Instagram
  if (body.object === 'instagram') {
    body.entry?.forEach(entry => {
      entry.messaging?.forEach(async (event) => {
        if (event.message && !event.message.is_echo) {
          const userId = event.sender.id;
          const text = event.message.text || '';
          console.log(`📸 Instagram DM de ${userId}: ${text}`);
          const reply = await askValeria(`ig_${userId}`, text);
          await igSend(userId, reply);
        }
      });
    });
    res.sendStatus(200);
    return;
  }

  res.sendStatus(404);
});

// ══════════════════════════════════════════
// WEBHOOK TELEGRAM
// ══════════════════════════════════════════
app.post(`/bot${TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.get('/', (req, res) => res.send('🤖 Valeria Bot — ARMONNIZA Bolivia — Activo ✅'));

app.get('/privacy', (req, res) => {
  res.send('<h1>Política de Privacidad - ARMONNIZA</h1><p>ARMONNIZA recopila datos de contacto únicamente para gestionar citas y consultas médico-estéticas. No compartimos información con terceros.</p>');
});

app.get('/terms', (req, res) => {
  res.send('<h1>Términos de Servicio - ARMONNIZA</h1><p>Al usar nuestros servicios digitales aceptas que tus datos serán usados exclusivamente para gestión de citas en ARMONNIZA.</p>');
});

app.listen(PORT, () => console.log(`✅ Valeria Bot corriendo en puerto ${PORT}`));
