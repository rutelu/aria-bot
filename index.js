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
// ESTADOS TELEGRAM
// ══════════════════════════════════════════
const userStates = {};
function setState(chatId, state) { userStates[chatId] = state; }
function getState(chatId) { return userStates[chatId] || 'inicio'; }

// ══════════════════════════════════════════
// MENÚ PRINCIPAL TELEGRAM
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
    `✨ *Bienvenida/o a ARMONNIZA Bolivia* ✨\n\n_Tu belleza, nuestra ciencia._\n\nSoy *Valeria*, tu asistente virtual. ¿En qué puedo ayudarte hoy?\n\nElige una opción del menú 👇`,
    { parse_mode: 'Markdown', ...opts }
  );
  setState(chatId, 'menu');
}

// ══════════════════════════════════════════
// MANEJADOR TELEGRAM
// ══════════════════════════════════════════
bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  const lower = text.toLowerCase();

  if (text === '/start' || lower.includes('hola') || lower.includes('inicio')) return menuPrincipal(chatId);

  if (text === '🌟 Ver Especialidades') {
    bot.sendMessage(chatId, '🏥 *Nuestras Especialidades*\n\nSelecciona una:', {
      parse_mode: 'Markdown',
      reply_markup: {
        keyboard: [
          ['💉 Medicina Estética', '🏥 Cirugía Estética'],
          ['💆 Fisio-Estética', '✨ Cosmetología'],
          ['⬅️ Volver al menú']
        ],
        resize_keyboard: true
      }
    });
    return;
  }

  const espMap = { '💉 medicina estética': 'medicina', '🏥 cirugía estética': 'cirugia', '💆 fisio-estética': 'fisio', '✨ cosmetología': 'cosmetologia' };
  const espKey = espMap[lower];
  if (espKey) {
    const esp = ESPECIALIDADES[espKey];
    const lista = esp.tratamientos.map(t => `  • ${t}`).join('\n');
    bot.sendMessage(chatId, `${esp.nombre}\n👨‍⚕️ *${esp.doctor}*\n\n*Tratamientos:*\n${lista}\n\n👉 Agenda en *${AGENDA_URL}*`, { parse_mode: 'Markdown' });
    return;
  }

  if (text === '💆 Tratamientos') {
    let m = '💉 *Tratamientos Destacados*\n\n';
    for (const [, esp] of Object.entries(ESPECIALIDADES)) {
      m += `*${esp.nombre}*\n`;
      esp.tratamientos.slice(0, 3).forEach(t => m += `  • ${t}\n`);
      m += '\n';
    }
    bot.sendMessage(chatId, m, { parse_mode: 'Markdown' });
    return;
  }

  if (text === '📅 Agendar una Cita') {
    bot.sendMessage(chatId,
      `📅 *Agenda tu Cita en ARMONNIZA*\n\nReserva en segundos desde nuestra agenda online:\n👉 *${AGENDA_URL}*\n\nO cuéntame qué tratamiento te interesa 😊`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: `🌐 Reservar en ${AGENDA_URL}`, url: `https://${AGENDA_URL}` }]] } }
    );
    return;
  }

  if (text === '🕐 Horarios') {
    bot.sendMessage(chatId, `🕐 *Horarios de Atención*\n\n${HORARIOS.map(h => `📅 ${h}`).join('\n')}\n\n📍 La Paz, Bolivia`, { parse_mode: 'Markdown' });
    return;
  }

  if (text === '🎁 Promociones') {
    const lista = PROMOCIONES.map((p, i) => `${i + 1}. 🌟 ${p}`).join('\n\n');
    bot.sendMessage(chatId, `🎁 *Promociones de Temporada*\n\n${lista}\n\n⏰ ¡Por tiempo limitado!\n👉 *${AGENDA_URL}*`, { parse_mode: 'Markdown' });
    return;
  }

  if (text === '📞 Hablar con Humano') {
    bot.sendMessage(chatId, `👩‍💼 *Conectando con nuestro equipo...*\n\n📱 WhatsApp: +591 78118003\n📸 Instagram: @armonniza\n🌐 ${AGENDA_URL}`, { parse_mode: 'Markdown' });
    return;
  }

  if (text === '⬅️ Volver al menú') return menuPrincipal(chatId);

  if (lower.includes('botox')) {
    bot.sendMessage(chatId, `💉 *Botox Facial* — Desde Bs 350\n\n• Duración: 4-6 meses\n• Procedimiento: 30 min\n• Recuperación: inmediata\n\n👉 Agenda en *${AGENDA_URL}*`, { parse_mode: 'Markdown' });
    return;
  }

  if (lower.includes('precio') || lower.includes('costo') || lower.includes('cuánto') || lower.includes('cuanto')) {
    bot.sendMessage(chatId, `💰 *Precios ARMONNIZA*\n\n• Valoración: *Bs 50* (reembolsable)\n• Pagos: tarjetas, QR, transferencias\n\n👉 *${AGENDA_URL}*`, { parse_mode: 'Markdown' });
    return;
  }

  bot.sendMessage(chatId, `🤔 No entendí tu consulta. Usa el menú de abajo 😊`, {
    reply_markup: { keyboard: [['🌟 Ver Especialidades', '💆 Tratamientos'], ['📅 Agendar una Cita', '🕐 Horarios'], ['🎁 Promociones', '📞 Hablar con Humano']], resize_keyboard: true }
  });
});

bot.on('callback_query', (query) => {
  bot.answerCallbackQuery(query.id);
});

// ══════════════════════════════════════════
// WHATSAPP — ESTADOS
// ══════════════════════════════════════════
const waStates = {};
function waSetState(phone, state) { waStates[phone] = { state }; }
function waGetState(phone) { return waStates[phone] || { state: 'inicio' }; }

async function waSend(to, text) {
  const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
  const PHONE_ID = process.env.WHATSAPP_PHONE_ID || '1072474535952812';
  try {
    await fetch(`https://graph.facebook.com/v25.0/${PHONE_ID}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } })
    });
  } catch (err) { console.error('Error WA:', err); }
}

function waMenuPrincipal(from) {
  waSend(from,
    `✨ Bienvenida/o a ARMONNIZA Bolivia ✨\n` +
    `Tu belleza, nuestra ciencia.\n\n` +
    `Soy Valeria, tu asistente virtual 🤖\n\n` +
    `¿En qué puedo ayudarte?\n\n` +
    `1️⃣ Ver Especialidades\n` +
    `2️⃣ Tratamientos disponibles\n` +
    `3️⃣ Agendar una cita\n` +
    `4️⃣ Horarios de atención\n` +
    `5️⃣ Promociones\n` +
    `6️⃣ Hablar con una persona\n\n` +
    `Responde con el número 👇`
  );
  waSetState(from, 'menu');
}

function waMenuEspecialidades(from) {
  waSend(from,
    `🏥 Nuestras Especialidades\n\n` +
    `1️⃣ 💉 Medicina Estética\n` +
    `2️⃣ 🏥 Cirugía Estética\n` +
    `3️⃣ 💆 Fisio-Estética\n` +
    `4️⃣ ✨ Cosmetología\n` +
    `0️⃣ Volver al menú\n\n` +
    `Responde con el número 👇`
  );
  waSetState(from, 'especialidades');
}

async function waHandleMessage(from, text) {
  const lower = text.trim().toLowerCase();
  const { state } = waGetState(from);

  if (['hola', 'inicio', 'menu', 'menú', 'start', '0'].includes(lower) || lower.includes('hola')) {
    return waMenuPrincipal(from);
  }

  if (state === 'inicio' || state === 'menu') {
    switch (text.trim()) {
      case '1': return waMenuEspecialidades(from);
      case '2': {
        let msg = `💉 Tratamientos Destacados\n\n`;
        for (const [, esp] of Object.entries(ESPECIALIDADES)) {
          msg += `${esp.nombre}\n`;
          esp.tratamientos.slice(0, 3).forEach(t => msg += `  • ${t}\n`);
          msg += '\n';
        }
        msg += `👉 Agenda en: ${AGENDA_URL}\n\nEscribe menu para volver`;
        await waSend(from, msg);
        waSetState(from, 'menu');
        break;
      }
      case '3':
        await waSend(from,
          `📅 Agenda tu Cita en ARMONNIZA\n\n` +
          `Reserva en segundos desde nuestra agenda online:\n` +
          `👉 ${AGENDA_URL}\n\n` +
          `O cuéntame qué tratamiento te interesa y te conecto con el equipo 😊\n\n` +
          `📱 También: +591 78118003`
        );
        waSetState(from, 'agendar');
        break;
      case '4':
        await waSend(from,
          `🕐 Horarios de Atención\n\n` +
          `📅 ${HORARIOS.join('\n📅 ')}\n\n` +
          `📍 La Paz, Bolivia\n` +
          `🌐 ${AGENDA_URL}\n\n` +
          `Escribe menu para volver`
        );
        waSetState(from, 'menu');
        break;
      case '5': {
        const lista = PROMOCIONES.map((p, i) => `${i + 1}. ${p}`).join('\n\n');
        await waSend(from,
          `🎁 Promociones de Temporada\n\n${lista}\n\n` +
          `⏰ ¡Por tiempo limitado!\n` +
          `👉 Reserva en: ${AGENDA_URL}\n\n` +
          `Escribe menu para volver`
        );
        waSetState(from, 'menu');
        break;
      }
      case '6':
        await waSend(from,
          `👩‍💼 Conectando con nuestro equipo...\n\n` +
          `Una asesora te atenderá pronto.\n\n` +
          `📱 WhatsApp: +591 78118003\n` +
          `📸 Instagram: @armonniza\n` +
          `🌐 ${AGENDA_URL}\n\n` +
          `¡Gracias por contactar a ARMONNIZA! 💖`
        );
        waSetState(from, 'menu');
        break;
      default:
        if (lower.includes('botox')) {
          await waSend(from, `💉 Botox Facial — Desde Bs 350\n\n• Duración: 4-6 meses\n• Procedimiento: 30 min\n• Recuperación: inmediata\n\n👉 Agenda en: ${AGENDA_URL}\n\nEscribe menu para más opciones`);
        } else if (lower.includes('precio') || lower.includes('costo') || lower.includes('cuánto') || lower.includes('cuanto')) {
          await waSend(from, `💰 Precios ARMONNIZA\n\n• Valoración: Bs 50 (reembolsable)\n• Pagos: tarjetas, QR, transferencias\n\n👉 Agenda en: ${AGENDA_URL}\n\nEscribe menu para volver`);
        } else {
          await waMenuPrincipal(from);
        }
    }
    return;
  }

  if (state === 'especialidades') {
    const espList = ['medicina', 'cirugia', 'fisio', 'cosmetologia'];
    const idx = parseInt(text.trim()) - 1;
    if (idx >= 0 && idx < espList.length) {
      const esp = ESPECIALIDADES[espList[idx]];
      const lista = esp.tratamientos.map(t => `  • ${t}`).join('\n');
      await waSend(from, `${esp.nombre}\n👨‍⚕️ ${esp.doctor}\n\nTratamientos:\n${lista}\n\n👉 Agenda en: ${AGENDA_URL}\n\nEscribe 3 para agendar o menu para volver`);
      waSetState(from, 'menu');
    } else if (text.trim() === '0') {
      waMenuPrincipal(from);
    } else {
      waMenuEspecialidades(from);
    }
    return;
  }

  if (state === 'agendar') {
    await waSend(from,
      `✅ ¡Recibido!\n\n` +
      `Una asesora te contactará pronto 📅\n\n` +
      `También puedes reservar directamente:\n` +
      `👉 ${AGENDA_URL}\n\n` +
      `Escribe menu para volver`
    );
    waSetState(from, 'menu');
    return;
  }

  waMenuPrincipal(from);
}

// ══════════════════════════════════════════
// MESSENGER (FACEBOOK DM) — ESTADOS
// ══════════════════════════════════════════
const fbStates = {};
function fbSetState(userId, state) { fbStates[userId] = { state }; }
function fbGetState(userId) { return fbStates[userId] || { state: 'inicio' }; }

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

function fbMenuPrincipal(userId) {
  fbSend(userId,
    `✨ Hola! Soy Valeria, asistente de ARMONNIZA 💆‍♀️\n\n` +
    `Gracias por escribirnos en Facebook 📘\n\n` +
    `¿En qué puedo ayudarte?\n\n` +
    `1️⃣ Ver tratamientos\n` +
    `2️⃣ Precios y promociones\n` +
    `3️⃣ Agendar una cita\n` +
    `4️⃣ Horarios de atención\n` +
    `5️⃣ Hablar con una persona\n\n` +
    `Responde con el número 👇`
  );
  fbSetState(userId, 'menu');
}

async function fbHandleMessage(userId, text) {
  const lower = text.trim().toLowerCase();
  const { state } = fbGetState(userId);

  if (['hola', 'hi', 'hello', 'inicio', 'menu', 'menú', 'start'].includes(lower) || lower.includes('hola')) {
    return fbMenuPrincipal(userId);
  }

  if (state === 'inicio' || state === 'menu') {
    switch (text.trim()) {
      case '1': {
        let msg = `💆‍♀️ Nuestros Tratamientos\n\n`;
        for (const [, esp] of Object.entries(ESPECIALIDADES)) {
          msg += `${esp.nombre}\n`;
          esp.tratamientos.slice(0, 2).forEach(t => msg += `  • ${t}\n`);
          msg += '\n';
        }
        msg += `✨ Reserva en:\n👉 ${AGENDA_URL}\n\nEscribe menu para volver`;
        await fbSend(userId, msg);
        fbSetState(userId, 'menu');
        break;
      }
      case '2': {
        const lista = PROMOCIONES.map((p, i) => `${i + 1}. ${p}`).join('\n\n');
        await fbSend(userId,
          `💰 Precios y Promociones\n\n` +
          `• Valoración: Bs 50 (reembolsable)\n` +
          `• Pagos: tarjetas, QR, transferencias\n\n` +
          `🎁 Promociones activas:\n\n${lista}\n\n` +
          `👉 ${AGENDA_URL}\n\nEscribe menu para volver`
        );
        fbSetState(userId, 'menu');
        break;
      }
      case '3':
        await fbSend(userId,
          `📅 Agenda tu Cita\n\n` +
          `Reserva en segundos:\n` +
          `👉 ${AGENDA_URL}\n\n` +
          `O cuéntame qué tratamiento te interesa 😊`
        );
        fbSetState(userId, 'agendar_fb');
        break;
      case '4':
        await fbSend(userId,
          `🕐 Horarios\n\n` +
          `📅 ${HORARIOS.join('\n📅 ')}\n\n` +
          `📍 La Paz, Bolivia\n` +
          `🌐 ${AGENDA_URL}\n\n` +
          `Escribe menu para volver`
        );
        fbSetState(userId, 'menu');
        break;
      case '5':
        await fbSend(userId,
          `👩‍💼 Conectando con el equipo...\n\n` +
          `Una asesora te atenderá pronto.\n\n` +
          `📱 WhatsApp: +591 78118003\n` +
          `📸 Instagram: @armonniza\n` +
          `🌐 ${AGENDA_URL}\n\n` +
          `¡Gracias por contactar a ARMONNIZA! 💖`
        );
        fbSetState(userId, 'menu');
        break;
      default:
        if (lower.includes('precio') || lower.includes('costo') || lower.includes('cuanto') || lower.includes('cuánto') || lower.includes('botox')) {
          await fbSend(userId,
            `💰 Precios desde Bs 150\n\n` +
            `• Botox Facial — Bs 350\n` +
            `• Rellenos — Bs 450\n` +
            `• HydraFacial — Bs 350\n` +
            `• Criolipólisis — Bs 500\n\n` +
            `👉 ${AGENDA_URL}\n\nEscribe menu para volver`
          );
        } else {
          fbMenuPrincipal(userId);
        }
    }
    return;
  }

  if (state === 'agendar_fb') {
    await fbSend(userId,
      `✅ Recibido!\n\n` +
      `Reserva directamente en:\n` +
      `👉 ${AGENDA_URL}\n\n` +
      `O una asesora te contactará pronto 📅\n\n` +
      `Escribe menu para volver`
    );
    fbSetState(userId, 'menu');
    return;
  }

  fbMenuPrincipal(userId);
}

// ══════════════════════════════════════════
// INSTAGRAM — ESTADOS
// ══════════════════════════════════════════
const igStates = {};
function igSetState(userId, state) { igStates[userId] = { state }; }
function igGetState(userId) { return igStates[userId] || { state: 'inicio' }; }

// ── igSend CON ID DE PÁGINA CORRECTO ──
async function igSend(recipientId, text) {
  const IG_TOKEN = process.env.INSTAGRAM_TOKEN;
  const PAGE_ID = '100361346281528';
  console.log(`📤 igSend → recipientId: ${recipientId}, token existe: ${!!IG_TOKEN}`);
  try {
    const response = await fetch(`https://graph.facebook.com/v25.0/${PAGE_ID}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${IG_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: { text }
      })
    });
    const data = await response.json();
    console.log(`📸 IG API response:`, JSON.stringify(data));
  } catch (err) {
    console.error('Error IG:', err);
  }
}

function igMenuPrincipal(userId) {
  igSend(userId,
    `✨ Hola! Soy Valeria, asistente de ARMONNIZA 💆‍♀️\n\n` +
    `Gracias por escribirnos en Instagram 📸\n\n` +
    `¿En qué puedo ayudarte?\n\n` +
    `1️⃣ Ver tratamientos y resultados\n` +
    `2️⃣ Precios y promociones\n` +
    `3️⃣ Agendar una cita\n` +
    `4️⃣ Horarios de atención\n` +
    `5️⃣ Hablar con una persona\n\n` +
    `Responde con el número 👇`
  );
  igSetState(userId, 'menu');
}

async function igHandleMessage(userId, text) {
  const lower = text.trim().toLowerCase();
  const { state } = igGetState(userId);

  if (['hola', 'hi', 'hello', 'inicio', 'menu', 'menú', 'start'].includes(lower) || lower.includes('hola')) {
    return igMenuPrincipal(userId);
  }

  if (state === 'inicio' || state === 'menu') {
    switch (text.trim()) {
      case '1': {
        let msg = `💆‍♀️ Nuestros Tratamientos\n\n`;
        for (const [, esp] of Object.entries(ESPECIALIDADES)) {
          msg += `${esp.nombre}\n`;
          esp.tratamientos.slice(0, 2).forEach(t => msg += `  • ${t}\n`);
          msg += '\n';
        }
        msg += `✨ Reserva y ve todos los resultados en:\n👉 ${AGENDA_URL}\n\nEscribe menu para volver`;
        await igSend(userId, msg);
        igSetState(userId, 'menu');
        break;
      }
      case '2': {
        const lista = PROMOCIONES.map((p, i) => `${i + 1}. ${p}`).join('\n\n');
        await igSend(userId,
          `💰 Precios y Promociones ARMONNIZA\n\n` +
          `• Valoración: Bs 50 (reembolsable)\n` +
          `• Pagos: tarjetas, QR, transferencias\n\n` +
          `🎁 Promociones activas:\n\n${lista}\n\n` +
          `⏰ Por tiempo limitado!\n` +
          `👉 Reserva en: ${AGENDA_URL}\n\n` +
          `Escribe menu para volver`
        );
        igSetState(userId, 'menu');
        break;
      }
      case '3':
        await igSend(userId,
          `📅 Agenda tu Cita en ARMONNIZA\n\n` +
          `Reserva en segundos desde nuestra agenda online:\n` +
          `👉 ${AGENDA_URL}\n\n` +
          `Es rapido y puedes elegir el horario que prefieras 😊\n\n` +
          `O cuentame que tratamiento te interesa y te ayudo`
        );
        igSetState(userId, 'agendar_ig');
        break;
      case '4':
        await igSend(userId,
          `🕐 Horarios de Atención\n\n` +
          `📅 ${HORARIOS.join('\n📅 ')}\n\n` +
          `📍 La Paz, Bolivia\n` +
          `🌐 ${AGENDA_URL}\n\n` +
          `Escribe menu para volver`
        );
        igSetState(userId, 'menu');
        break;
      case '5':
        await igSend(userId,
          `👩‍💼 Conectando con nuestro equipo...\n\n` +
          `Una asesora te atenderá pronto.\n\n` +
          `📱 WhatsApp: +591 78118003\n` +
          `📸 Instagram: @armonniza\n` +
          `🌐 ${AGENDA_URL}\n\n` +
          `Gracias por seguirnos! 💖`
        );
        igSetState(userId, 'menu');
        break;
      default:
        if (lower.includes('botox') || lower.includes('relleno') || lower.includes('precio') || lower.includes('costo') || lower.includes('cuanto') || lower.includes('cuánto')) {
          await igSend(userId,
            `💉 Nuestros tratamientos desde Bs 150\n\n` +
            `• Botox Facial — Desde Bs 350\n` +
            `• Rellenos — Desde Bs 450\n` +
            `• HydraFacial — Desde Bs 350\n` +
            `• Criolipólisis — Desde Bs 500\n\n` +
            `👉 Ve todos los precios en:\n${AGENDA_URL}\n\n` +
            `Escribe menu para más opciones`
          );
        } else {
          igMenuPrincipal(userId);
        }
    }
    return;
  }

  if (state === 'agendar_ig') {
    await igSend(userId,
      `✅ Perfecto!\n\n` +
      `La forma mas rapida de reservar:\n` +
      `👉 ${AGENDA_URL}\n\n` +
      `O una asesora te contactara pronto 📅\n\n` +
      `Escribe menu para volver`
    );
    igSetState(userId, 'menu');
    return;
  }

  igMenuPrincipal(userId);
}

// ══════════════════════════════════════════
// WEBHOOK — WhatsApp + Messenger + Instagram
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

app.post('/webhook', (req, res) => {
  const body = req.body;

  // WhatsApp
  if (body.object === 'whatsapp_business_account') {
    body.entry?.forEach(entry => {
      entry.changes?.forEach(change => {
        const messages = change.value?.messages;
        if (messages) {
          messages.forEach(message => {
            const from = message.from;
            if (from.includes('78118003')) return;
            const text = message.text?.body || '';
            console.log(`📱 WhatsApp de ${from}: ${text}`);
            waHandleMessage(from, text);
          });
        }
      });
    });
    res.sendStatus(200);
    return;
  }

  // Messenger (Facebook DM)
  if (body.object === 'page') {
    body.entry?.forEach(entry => {
      entry.messaging?.forEach(event => {
        if (event.message && !event.message.is_echo) {
          const userId = event.sender.id;
          const text = event.message.text || '';
          console.log(`💬 Messenger DM de ${userId}: ${text}`);
          fbHandleMessage(userId, text);
        }
      });
    });
    res.sendStatus(200);
    return;
  }

  // Instagram
  if (body.object === 'instagram') {
    body.entry?.forEach(entry => {
      entry.messaging?.forEach(event => {
        if (event.message && !event.message.is_echo) {
          const userId = event.sender.id;
          const text = event.message.text || '';
          console.log(`📸 Instagram DM de ${userId}: ${text}`);
          igHandleMessage(userId, text);
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
