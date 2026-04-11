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
  '🌟 *Pack Rejuvenecimiento* — 20% Off en Botox Full Face + Ácido Hialurónico',
  '☀️ *Verano Perfecto* — Lleva 5 sesiones de Modelado y paga solo 3',
  '✨ *Glow Up Inmediato* — HydraFacial + LED con 30% de descuento',
];

const HORARIOS = [
  '📅 Lic. Princeica Tejada — Lun a Vie: 09:00 AM – 06:00 PM',
  '📅 Téc. Valeria Mendoza — Mar, Jue, Sáb: 09:00 AM – 05:00 PM',
  '📅 Dr. Julio Lucia — Consultar disponibilidad',
  '📅 Dr. Claudio Tejada — Consultar disponibilidad',
];

// ══════════════════════════════════════════
// ESTADOS DE CONVERSACIÓN
// ══════════════════════════════════════════
const userStates = {};

function setState(chatId, state) { userStates[chatId] = state; }
function getState(chatId) { return userStates[chatId] || 'inicio'; }

// ══════════════════════════════════════════
// MENÚ PRINCIPAL
// ══════════════════════════════════════════
function menuPrincipal(chatId) {
  const opts = {
    reply_markup: {
      keyboard: [
        ['🌟 Ver Especialidades', '💆 Tratamientos'],
        ['📅 Agendar una Cita', '🕐 Horarios'],
        ['🎁 Promociones', '📞 Hablar con Humano']
      ],
      resize_keyboard: true,
      one_time_keyboard: false
    }
  };
  bot.sendMessage(chatId,
    `✨ *Bienvenida/o a ARMONNIZA Bolivia* ✨\n\n_Tu belleza, nuestra ciencia._\n\nSoy *ARIA*, tu asistente virtual. ¿En qué puedo ayudarte hoy?\n\nElige una opción del menú 👇`,
    { parse_mode: 'Markdown', ...opts }
  );
  setState(chatId, 'menu');
}

// ══════════════════════════════════════════
// MANEJADOR DE MENSAJES TELEGRAM
// ══════════════════════════════════════════
bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  const lower = text.toLowerCase();

  if (text === '/start' || lower.includes('hola') || lower.includes('inicio')) {
    return menuPrincipal(chatId);
  }

  if (text === '🌟 Ver Especialidades') {
    const opts = {
      reply_markup: {
        keyboard: [
          ['💉 Medicina Estética', '🏥 Cirugía Estética'],
          ['💆 Fisio-Estética', '✨ Cosmetología'],
          ['⬅️ Volver al menú']
        ],
        resize_keyboard: true
      }
    };
    bot.sendMessage(chatId, '🏥 *Nuestras Especialidades*\n\nSelecciona una para ver más información:', { parse_mode: 'Markdown', ...opts });
    return;
  }

  const espMap = {
    '💉 medicina estética': 'medicina',
    '🏥 cirugía estética': 'cirugia',
    '💆 fisio-estética': 'fisio',
    '✨ cosmetología': 'cosmetologia',
  };
  const espKey = espMap[lower];
  if (espKey) {
    const esp = ESPECIALIDADES[espKey];
    const lista = esp.tratamientos.map(t => `  • ${t}`).join('\n');
    bot.sendMessage(chatId,
      `${esp.nombre}\n👨‍⚕️ *${esp.doctor}*\n\n*Tratamientos disponibles:*\n${lista}\n\n💬 ¿Te gustaría agendar una cita?`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  if (text === '💆 Tratamientos') {
    let msg = '💉 *Nuestros Tratamientos Destacados*\n\n';
    for (const [, esp] of Object.entries(ESPECIALIDADES)) {
      msg += `*${esp.nombre}*\n`;
      esp.tratamientos.slice(0, 3).forEach(t => msg += `  • ${t}\n`);
      msg += '\n';
    }
    bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
    return;
  }

  if (text === '📅 Agendar una Cita') {
    bot.sendMessage(chatId,
      `📅 *Agendar tu Cita en ARMONNIZA*\n\nTienes 3 opciones:\n\n1️⃣ *Online* → Reserva en nuestro sitio web\n2️⃣ *WhatsApp* → Escríbenos directamente\n3️⃣ *Aquí mismo* → Cuéntame qué tratamiento te interesa 😊`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🌐 Reservar Online', url: 'https://armonniza.com' }],
            [{ text: '💬 WhatsApp', url: 'https://wa.me/59178118003' }],
            [{ text: '📝 Agendar aquí', callback_data: 'agendar_aqui' }]
          ]
        }
      }
    );
    return;
  }

  if (text === '🕐 Horarios') {
    bot.sendMessage(chatId,
      `🕐 *Horarios de Atención*\n\n${HORARIOS.join('\n')}\n\n📍 *Sede principal:* La Paz, Bolivia`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  if (text === '🎁 Promociones') {
    const lista = PROMOCIONES.map((p, i) => `${i + 1}. ${p}`).join('\n\n');
    bot.sendMessage(chatId,
      `🎁 *Promociones de Temporada*\n\n${lista}\n\n⏰ ¡Ofertas por tiempo limitado!`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  if (text === '📞 Hablar con Humano') {
    bot.sendMessage(chatId,
      `👩‍💼 *Conectando con nuestro equipo...*\n\nEn breve una asesora te atenderá.\n\n📱 *WhatsApp:* +591 78118003\n📸 *Instagram:* @armonniza`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  if (text === '⬅️ Volver al menú') return menuPrincipal(chatId);

  if (lower.includes('botox')) {
    bot.sendMessage(chatId,
      `💉 *Botox Facial*\n\nRelaja arrugas de expresión naturalmente.\n• Duración: 4-6 meses\n• Procedimiento: 30 min\n• Recuperación: inmediata\n\n👨‍⚕️ *Dr. Julio Lucia* / *Dr. Claudio Tejada*`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  if (lower.includes('precio') || lower.includes('costo') || lower.includes('cuánto') || lower.includes('cuanto')) {
    bot.sendMessage(chatId,
      `💰 *Precios ARMONNIZA*\n\n• Valoración inicial: *Bs 50* (reembolsable)\n• Pagos: tarjetas, QR, transferencias\n• Paquetes con descuento disponibles\n\nAgenda tu valoración para un presupuesto exacto. 😊`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  bot.sendMessage(chatId,
    `🤔 No estoy segura de entender tu consulta.\n\nPuedo ayudarte con especialidades, tratamientos, precios, promociones y agendar citas. Usa el menú de abajo. 😊`,
    {
      reply_markup: {
        keyboard: [
          ['🌟 Ver Especialidades', '💆 Tratamientos'],
          ['📅 Agendar una Cita', '🕐 Horarios'],
          ['🎁 Promociones', '📞 Hablar con Humano']
        ],
        resize_keyboard: true
      }
    }
  );
});

bot.on('callback_query', (query) => {
  const chatId = query.message.chat.id;
  if (query.data === 'agendar_aqui') {
    bot.sendMessage(chatId,
      `📝 Cuéntame:\n1. ¿Qué tratamiento te interesa?\n2. ¿En qué ciudad estás?\n3. ¿Preferencia de día u hora?\n\nEscríbeme y coordino con el equipo. 😊`,
      { parse_mode: 'Markdown' }
    );
  }
  bot.answerCallbackQuery(query.id);
});

// ══════════════════════════════════════════
// WEBHOOK WHATSAPP
// ══════════════════════════════════════════
app.get('/webhook', (req, res) => {
  const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'armonniza2024';
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook de WhatsApp verificado');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', (req, res) => {
  const body = req.body;
  if (body.object === 'whatsapp_business_account') {
    body.entry?.forEach(entry => {
      entry.changes?.forEach(change => {
        const messages = change.value?.messages;
        if (messages) {
          messages.forEach(message => {
            const from = message.from;
            const text = message.text?.body || '';
            console.log(`📱 WhatsApp de ${from}: ${text}`);
            const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
fetch(`https://graph.facebook.com/v25.0/1049327234935783/messages`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    messaging_product: 'whatsapp',
    to: from,
    type: 'text',
    text: { body: '✨ *Bienvenida/o a ARMONNIZA Bolivia* ✨\n\nTu belleza, nuestra ciencia.\n\nSoy *ARIA*, tu asistente virtual. ¿En qué puedo ayudarte hoy?' }
  })
});
          });
        }
      });
    });
    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

// ══════════════════════════════════════════
// WEBHOOK TELEGRAM
// ══════════════════════════════════════════
app.post(`/bot${TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.get('/', (req, res) => {
  res.send('🤖 ARIA Bot — ARMONNIZA Bolivia — Activo ✅');
});

// Rutas requeridas por Meta
app.get('/privacy', (req, res) => {
  res.send('<h1>Política de Privacidad - ARMONNIZA</h1><p>ARMONNIZA recopila datos de contacto únicamente para gestionar citas y consultas médico-estéticas. No compartimos información con terceros.</p>');
});

app.get('/terms', (req, res) => {
  res.send('<h1>Términos de Servicio - ARMONNIZA</h1><p>Al usar nuestros servicios digitales aceptas que tus datos serán usados exclusivamente para gestión de citas en ARMONNIZA.</p>');
});

app.listen(PORT, () => {
  console.log(`✅ ARIA Bot corriendo en puerto ${PORT}`);
});
