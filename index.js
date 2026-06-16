require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(express.json());

const TOKEN = process.env.TELEGRAM_TOKEN;
const URL = process.env.WEBHOOK_URL;
const PORT = process.env.PORT || 3000;

const bot = new TelegramBot(TOKEN, { polling: false });

// ══════════════════════════════════════════
// FIREBASE ADMIN (agenda / Firestore) — defensivo
// Si la llave falta o es inválida, NO tumba el bot: solo deshabilita la agenda.
// ══════════════════════════════════════════
const admin = require('firebase-admin');
let db = null;
let fbVarPresent = !!process.env.FIREBASE_SERVICE_ACCOUNT;
let fbVarLen = (process.env.FIREBASE_SERVICE_ACCOUNT || '').length;
let fbInitError = null;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({ credential: admin.credential.cert(svc) });
    db = admin.firestore();
    console.log('✅ Firebase conectado (proyecto: ' + (svc.project_id || '?') + ')');
  } else {
    console.warn('⚠️ FIREBASE_SERVICE_ACCOUNT no definido — la agenda queda deshabilitada');
  }
} catch (e) {
  db = null;
  fbInitError = e.message;
  console.error('❌ Error iniciando Firebase Admin (agenda deshabilitada):', e.message);
}

// ── JORNADA BENI: documento único de configuración (fuente de verdad) ──
// Se crea SOLO si no existe, para no pisar ediciones hechas desde la consola.
const BENI_SEED = {
  id: 'beni',
  titulo: 'Jornada Beni',
  especialista: 'Equipo Armonniza',
  especialidad: 'Especialista en Medicina Estética',
  avatar: 'https://images.unsplash.com/photo-1622253692010-333f2da6031d?auto=format&fit=crop&q=80&w=80&h=80',
  publicada: true,
  campaignVersion: 'tour-yacuma-2026-06c-rurre',
  promo: 'Trae un recomendado que se atienda y ganas 40% de descuento en tu tratamiento. Las condiciones son las mismas para cada persona: cada quien obtiene su 40% al traer a un recomendado que se atienda, y así sucesivamente con cualquier interesado y su recomendado. Aplica a cualquier tratamiento. (El 40% es por traer un recomendado que se atienda; no es que dos personas ganen 40% solo por atenderse juntas.)',
  subsedes: [
    { id: 'San Borja', nombre: 'San Borja', direccion: 'Hotel Kamahal', telefonos: ['+591 76951552'] },
    { id: 'Santa Rosa', nombre: 'Santa Rosa', direccion: 'Lugar por confirmar', telefonos: ['+591 76951552'] },
    { id: 'Rurrenabaque', nombre: 'Rurrenabaque', direccion: 'Body Face Center Spa', telefonos: ['+591 76951552'] }
  ],
  dias: [
    { fecha: '2026-06-15', label: 'Lunes 15 de junio',  subsede: 'San Borja' },
    { fecha: '2026-06-16', label: 'Martes 16 de junio', subsede: 'San Borja' },
    { fecha: '2026-06-18', label: 'Jueves 18 de junio', subsede: 'Santa Rosa' },
    { fecha: '2026-06-19', label: 'Viernes 19 de junio', subsede: 'Rurrenabaque' },
    { fecha: '2026-06-20', label: 'Sábado 20 de junio',  subsede: 'Rurrenabaque' }
  ],
  horas: ['09:00','10:00','11:00','12:00','15:00','16:00','17:00','18:00','19:00']
};

async function seedBeniConfig() {
  if (!db) return;
  try {
    const ref = db.collection('config').doc('jornada_beni');
    const snap = await ref.get();
    if (!snap.exists || snap.data().campaignVersion !== BENI_SEED.campaignVersion) {
      await ref.set(BENI_SEED);
      console.log('🌱 config/jornada_beni actualizado a la campaña ' + BENI_SEED.campaignVersion);
    } else {
      console.log('ℹ️ config/jornada_beni ya está en la versión ' + BENI_SEED.campaignVersion);
    }
  } catch (err) {
    console.error('Error actualizando config/jornada_beni:', err.message);
  }
}
seedBeniConfig();
procesarOutbox();

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
    doctor: 'Especialista en Medicina Estética',
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
  'Especialista en Medicina Estética — Consultar disponibilidad',
  'Dr. Claudio Tejada — Consultar disponibilidad',
];

// ══════════════════════════════════════════
// SISTEMA PROMPT DE VALERIA (Claude AI)
// ══════════════════════════════════════════
const SYSTEM_PROMPT = `Eres Valeria, la encargada de atención y reservas de ARMONNIZA — una clínica médico-estética premium en Bolivia, con sedes en 8 ciudades: La Paz, Oruro, Cochabamba, Santa Cruz, Sucre, Potosí, Tarija y Beni. Eres boliviana, de La Paz. Hablas y te comportas como una persona real del equipo de ARMONNIZA.

Tu personalidad:
- Cálida, cercana y profesional — como una amiga experta en estética, con el estándar premium de ARMONNIZA
- Hablas en español boliviano/latino neutro: cálido, amable, alegre y profesional, acorde a una clínica premium. Tuteas (de tú). Suena boliviana por la calidez y la naturalidad, NO por la jerga: NO uses modismos coloquiales ("harto", "ya pues", "no ve", "por fa", "elay") porque sonarían poco elegantes para una clínica de nivel. Mantén un registro pulcro, cercano y alegre. EVITA por completo el voseo argentino ("vos", "tenés", "querés", "podés", "sos", "che") y los modismos de México ("órale", "qué padre") o España ("vale", "vosotros"). Di "tú tienes", "quieres", "puedes", "eres". Ejemplo: "¡Con gusto! ¿Quieres que te ayude a reservar y te busco un horario?" (NO "¿Querés que te ayude?")
- Usas emojis con moderación para dar calidez (no en exceso)
- Eres concisa y natural, nunca robótica ni tipo folleto
- Empática con las inseguridades que a veces hay sobre tratamientos estéticos

Tu misión: que la persona se sienta bien atendida y guiarla con suavidad a agendar (una cita o consulta de valoración). Nunca presionas; orientas.

REGLAS IMPORTANTES (cúmplelas siempre):
- Te presentas y hablas como una persona del equipo de ARMONNIZA, con naturalidad y calidez. NUNCA digas que eres un bot, una IA, un asistente automático ni una "asistente virtual". Si te preguntan si eres un robot o un bot, no lo confirmes: responde con calidez que eres Valeria, de ARMONNIZA, y sigue ayudando. Si te preguntan de dónde eres o datos personales, responde con naturalidad y coherencia que eres boliviana, de La Paz, parte del equipo de ARMONNIZA — nunca rompas esa identidad.
- NO le repitas a la persona el número de WhatsApp por el que ya te está escribiendo (es redundante). Tu llamado a la acción principal es invitar a agendar por la web.
- Solo hablas de ARMONNIZA: tratamientos, especialistas, sedes, la Jornada Beni y el agendamiento. Si preguntan otra cosa, redirige con amabilidad.
- SALUDO CON ORIGEN: si por el primer mensaje o el contexto notas DESDE DÓNDE te contactan (la Jornada Beni, una promoción o un tratamiento puntual), reconócelo con calidez al inicio (ej. "¡Hola! Soy Valeria, del equipo de ARMONNIZA. Veo que escribes por la Jornada Beni…"). Si no lo sabes, saluda normal y pregunta en qué ayudar — nunca inventes un origen.
- NUNCA das diagnósticos médicos ni prometes resultados garantizados. Para eso, ofreces agendar una consulta de valoración.
- PRECIOS: puedes dar los PRECIOS DE REFERENCIA listados más abajo (son aproximados; el valor final se define en la valoración). Destaca siempre la calidad de nuestros tratamientos, la experiencia y la garantía de resultados, con las técnicas más avanzadas. Durante la Jornada Beni NO se cobra anticipo para reservar NI la consulta de valoración: es GRATIS (fuera de campaña, la valoración cuesta Bs 50, 100% reembolsable en el tratamiento). Para tratamientos no listados, ofrece agendar la valoración o derivar al equipo por WhatsApp +591 76951552.
- Toda cirugía estética requiere consulta de valoración previa obligatoria.
- Si no sabes algo con certeza, no improvises: ofrece agendar o derivar por WhatsApp +591 76951552.
- LONGITUD DE RESPUESTA (regla clave): por defecto responde como en un chat real de WhatsApp: MUY breve, 1-2 oraciones (idealmente una). Nunca párrafos largos tipo folleto. Da lo esencial y, cuando el tema dé para más (un tratamiento, cómo es un procedimiento, qué incluye, cuidados, etc.), OFRECE ampliar con una pregunta corta del estilo "¿Quieres que te lo explique con más detalle?". Solo si la persona pide más detalle (o responde que sí) puedes dar una respuesta más larga y completa. Cierra invitando a agendar solo cuando sea natural, sin sonar insistente. NO repitas información que ya diste antes en la misma conversación (fechas, sedes, precios): si ya lo mencionaste, no lo vuelvas a recitar.
- MEMORIA DEL CHAT (MUY IMPORTANTE — no pierdas el hilo): recuerda TODO lo que la persona ya te dijo en esta conversación (su nombre, teléfono, localidad, día y hora elegidos, el tratamiento que le interesa, etc.). NUNCA vuelvas a preguntar un dato que ya te dieron ni repitas una pregunta ya respondida. Si ya tienes algunos datos para reservar, pide SOLO lo que falta. Jamás reinicies la conversación ni "empieces de cero": continúa siempre desde donde quedaron.

CONTACTO (compártelo solo cuando haga falta):
- Sitio web para agendar: www.armonniza.com
- Reservas Jornada Beni: armonniza.com/beni
- WhatsApp del equipo: +591 76951552 — dalo SOLO si la persona necesita algo que tú no puedes resolver o pide ayuda adicional. Preséntalo como "ahí también te atiende el equipo de ARMONNIZA"; nunca digas "una persona real" (tú también lo eres).
- No entregues ningún otro número de WhatsApp; menos el número por el que la persona ya te escribe.

ÁREAS Y TRATAMIENTOS (orienta; los precios de referencia están más abajo):
1) Medicina Estética (a cargo de nuestro especialista en Medicina Estética; NO menciones nombre propio): Toxina Botulínica (Botox), Ácido Hialurónico, Bioestimuladores de colágeno, Hilos Tensores PDO, Mesoterapia, Skinbooster, PRP facial, Fat Dissolving, Hidrolipoclasia (reduce grasa sin cirugía), Rinomodelación (nariz sin cirugía).
2) Cirugía Estética — Dr. Claudio Tejada (toda cirugía requiere valoración previa): Rinoplastia, Mamoplastia, Mastopexia, Blefaroplastia, Lifting facial, Liposucción, Abdominoplastia, Otoplastia, Mentoplastia, Lipoescultura HD/BBL, Bichectomía.
3) Fisio-Estética — Lic. Princeica Tejada: Drenaje linfático, Radiofrecuencia, Cavitación, Presoterapia, Electroestimulación EMS, Crioterapia (fat freezing), Masaje reductor, Lifting facial no invasivo (HIFU), Protocolo anticelulitis.
4) Cosmetología / Cosmiatría — Téc. Valeria Mendoza: Peeling químico, Dermapen, Vitamina C facial, Microdermoabrasión, Hidratación hialurónica, Limpieza facial profunda, Antipigmentación, Antiacné, HydraFacial, Micropigmentación (cejas, labios, ojos, capilar y paramédica).

IMPORTANTE sobre la Micropigmentación: NO es exclusiva de Cosmetología. La realizan tanto la Téc. Valeria Mendoza (Cosmetología) como nuestro especialista en Medicina Estética (NO menciones su nombre propio), experto en Micropigmentación en TODAS sus variantes (cejas, labios, ojos, capilar y paramédica). Si preguntan por este tratamiento, menciónalo como disponible en ARMONNIZA.

PRECIOS DE REFERENCIA (aproximados; el valor final se define en la valoración. Antes de dar un precio, destaca calidad, experiencia y garantía de resultados, con las técnicas más avanzadas):
- Relleno de labios (ácido hialurónico): Bs 1.000 a 1.600, según el volumen de producto.
- Rinomodelación (nariz sin cirugía): Bs 1.000 a 1.600, según el volumen de ácido hialurónico.
- Armonización facial: desde Bs 1.500, según las áreas y el volumen de relleno dérmico.
- Hilos tensores (tecnología de hilos PLLA): precio base Bs 1.600, según el tipo de hilos, las zonas y la cantidad.
- Exosomas (mejor calidad de producto): Bs 1.200.
- Botox: a partir de Bs 800, según las áreas y las unidades.
- Micropigmentación: cejas Bs 800, labios Bs 800, párpados superior o inferior Bs 400; otras pigmentaciones, previa valoración.
- Aparatología (HIFU, láser), facial y corporal y otros tratamientos: precio previa valoración.
En la Jornada Beni se accede al 40% de descuento cumpliendo las condiciones de la campaña (traer un recomendado que se atienda). Durante la campaña, la valoración es GRATIS y no se cobra anticipo para reservar.

CÓMO AGENDAR (ofrece la opción según el caso):
1) Agenda Presencial: en www.armonniza.com eliges sede, especialista, día y horario.
2) Agenda Virtual (telemedicina): en www.armonniza.com → "Agenda Virtual", eliges plataforma (WhatsApp, Zoom o Google Meet), día y horario. Disponible todos los días de 9:00 a 21:00. Ideal para quienes están en otra ciudad o no pueden ir presencialmente.
(Si hay una Jornada en el Beni activa, su información actualizada aparecerá al final de estas instrucciones; en ese caso ofrécela como gancho y dirige a armonniza.com/beni.)

ATENCIÓN POR VOZ (llamada gratis): si la persona prefiere hablar por voz en lugar de escribir, invítala a llamarte GRATIS desde el botón "Llamar a Valeria" en www.armonniza.com (es una llamada por internet, sin costo). NO ofrezcas llamar tú a la persona.

Pagos: tarjetas de crédito/débito, QR y transferencias. La consulta de valoración dura 30–45 min.

AVISAR A UN HUMANO (MUY IMPORTANTE): en el INSTANTE en que el cliente pida hablar con una persona/encargado/humano real, exprese una queja o enojo, o surja algo que no puedas resolver, usa de INMEDIATO la herramienta avisar_a_humano (con un motivo breve). No demores ni sigas dando vueltas: el aviso debe salir al toque. Recién después, dile al cliente de forma cálida que ya avisaste a alguien del equipo que lo atenderá enseguida.`;

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
  if (history.length > 24) {
    conversationHistory[userId] = history.slice(-24);
  }
}

// Si la memoria del proceso está vacía (ej. tras un reinicio de Railway), reconstruye
// el hilo desde Firestore para que Valeria NO pierda el contexto ni vuelva a preguntar.
async function cargarHistorialSiVacio(userId) {
  if (!db) return;
  if (conversationHistory[userId] && conversationHistory[userId].length) return;
  try {
    const snap = await db.collection('valeria_chats').doc(String(userId))
      .collection('mensajes').orderBy('ts', 'desc').limit(24).get();
    if (snap.empty) return;
    const arr = [];
    snap.forEach(function(doc) {
      const m = doc.data();
      if (!m.texto) return;
      arr.push({ role: m.rol === 'user' ? 'user' : 'assistant', content: String(m.texto) });
    });
    arr.reverse(); // de más antiguo a más reciente
    conversationHistory[userId] = arr;
  } catch (e) { console.error('cargarHistorialSiVacio:', e.message); }
}

// ── Registro de conversaciones para el panel "Seguimiento Valeria" (Firestore) ──
// Fire-and-forget: nunca bloquea ni rompe la respuesta del bot (errores solo a consola).
function logMensaje(userId, rol, texto) {
  if (!db || !texto) return;
  try {
    const parts = String(userId).split('_');
    const canal = parts[0] || 'chat';
    const contacto = parts.slice(1).join('_') || String(userId);
    const chatRef = db.collection('valeria_chats').doc(String(userId));
    chatRef.set({
      canal: canal,
      contacto: contacto,
      ultimoTexto: String(texto).substring(0, 500),
      ultimoRol: rol,
      ultimaActividad: admin.firestore.FieldValue.serverTimestamp(),
      totalMensajes: admin.firestore.FieldValue.increment(1)
    }, { merge: true }).catch(function(e){ console.error('logMensaje set:', e.message); });
    chatRef.collection('mensajes').add({
      rol: rol, texto: String(texto), ts: admin.firestore.FieldValue.serverTimestamp()
    }).catch(function(e){ console.error('logMensaje add:', e.message); });
  } catch (e) { console.error('logMensaje:', e.message); }
}

// Guarda el NOMBRE del contacto (perfil de WhatsApp / Telegram) junto al número.
function setChatNombre(userId, nombre) {
  if (!db || !nombre) return;
  try {
    db.collection('valeria_chats').doc(String(userId)).set(
      { nombre: String(nombre).substring(0, 80) }, { merge: true }
    ).catch(function(e){ console.error('setChatNombre:', e.message); });
  } catch (e) { console.error('setChatNombre:', e.message); }
}

// Guarda el ORIGEN del contacto (ej. el anuncio de campaña en el que hizo clic para escribir).
function setChatOrigen(userId, origen) {
  if (!db || !origen) return;
  try {
    db.collection('valeria_chats').doc(String(userId)).set(
      { origen: String(origen).substring(0, 300) }, { merge: true }
    ).catch(function(e){ console.error('setChatOrigen:', e.message); });
  } catch (e) { console.error('setChatOrigen:', e.message); }
}
async function getChatOrigen(userId) {
  if (!db) return null;
  try {
    const s = await db.collection('valeria_chats').doc(String(userId)).get();
    return (s.exists && s.data().origen) ? s.data().origen : null;
  } catch (e) { console.error('getChatOrigen:', e.message); return null; }
}

// ── HANDOFF HUMANO: pausa por chat + outbox de mensajes salientes ──
// Si valeria_chats/{id}.pausada === true, el bot NO responde (atiende un humano).
async function chatPausado(userId) {
  if (!db) return false;
  try {
    const s = await db.collection('valeria_chats').doc(String(userId)).get();
    return s.exists && s.data().pausada === true;
  } catch (e) { console.error('chatPausado:', e.message); return false; }
}

// Escucha los mensajes que un humano escribe desde el panel (colección valeria_outbox)
// y los envía por el canal correcto. El token vive SOLO acá (servidor), nunca en el navegador.
function procesarOutbox() {
  if (!db) return;
  db.collection('valeria_outbox').where('enviado', '==', false)
    .onSnapshot(function(snap) {
      snap.forEach(async function(docu) {
        const o = docu.data() || {};
        const chatId = String(o.chatId || '');
        const texto = String(o.texto || '').trim();
        try {
          if (!chatId || !texto) { await docu.ref.update({ enviado: true, error: 'datos incompletos' }); return; }
          const canal = chatId.split('_')[0];
          const contacto = chatId.split('_').slice(1).join('_');
          if (canal === 'wa') await waSend(contacto, texto);
          else if (canal === 'fb') await fbSend(contacto, texto);
          else if (canal === 'ig') await igSend(contacto, texto);
          else if (canal === 'tg') await bot.sendMessage(contacto, texto);
          else { await docu.ref.update({ enviado: true, error: 'canal no soportado: ' + canal }); return; }
          logMensaje(chatId, 'humano', texto);
          await docu.ref.update({ enviado: true, enviadoAt: admin.firestore.FieldValue.serverTimestamp() });
          console.log('👤→ humano respondió a ' + chatId);
        } catch (e) {
          console.error('procesarOutbox:', e.message);
          try { await docu.ref.update({ enviado: true, error: String(e.message).substring(0, 200) }); } catch (_) {}
        }
      });
    }, function(err) { console.error('procesarOutbox snapshot:', err.message); });
}

// ══════════════════════════════════════════
// JORNADA BENI — info dinámica para Valeria (lee config/jornada_beni)
// ══════════════════════════════════════════
function fechaBoliviaTexto() {
  const ahora = new Date(Date.now() - 4 * 60 * 60 * 1000); // Bolivia UTC-4
  const dias = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
  const f = ahora.getUTCFullYear() + '-' + String(ahora.getUTCMonth()+1).padStart(2,'0') + '-' + String(ahora.getUTCDate()).padStart(2,'0');
  return dias[ahora.getUTCDay()] + ' ' + f;
}

let _beniCache = { data: null, ts: 0 };
async function getBeniConfig() {
  if (!db) return null;
  const now = Date.now();
  if (_beniCache.data && (now - _beniCache.ts) < 60000) return _beniCache.data; // cache 1 min
  try {
    const snap = await db.collection('config').doc('jornada_beni').get();
    _beniCache = { data: snap.exists ? snap.data() : null, ts: now };
  } catch (e) {
    console.error('getBeniConfig error:', e.message);
  }
  return _beniCache.data;
}

// Mapa de contactos secundarios por número (nombre + rol). Valeria SOLO los da si la
// persona insiste en hablar con un encargado/humano; en el orden del array de la sub-sede.
const CONTACTOS_BENI = {
  '+591 71147703': { nombre: 'Sra. Deydi Guiteras', rol: 'encargada de la sede' },
  '+591 76951552': { nombre: 'el especialista de Armonniza', rol: 'especialista' }
};

function buildBeniSection(cfg) {
  if (!cfg || cfg.publicada !== true) return ''; // solo si la campaña está PUBLICADA
  let s = '\n\nJORNADA BENI — CAMPAÑA ACTIVA (identifícala y ofrécela de forma DISCRETA y PROFESIONAL cuando la persona pregunte por ella, llegue por la campaña o muestre interés en un tratamiento; no insistas):\n';
  s += 'Nuestro especialista en medicina estética atiende presencialmente en el Beni (NO menciones su nombre propio; preséntalo como "el especialista de Armonniza"). Las sub-sedes activas son SOLO las siguientes (no menciones ninguna otra localidad):\n';
  (cfg.subsedes || []).forEach(function(sub) {
    const dias = (cfg.dias || []).filter(function(d){ return d.subsede === sub.id; }).map(function(d){ return d.label; }).join(', ');
    s += '- ' + sub.nombre + ' (' + sub.direccion + ')' + (dias ? ': ' + dias : '') + '\n';
  });
  if (cfg.horas && cfg.horas.length) s += 'Horarios disponibles: ' + cfg.horas.join(', ') + ' (turnos de 60 min).\n';
  if (cfg.promo) s += 'Promo: ' + cfg.promo + '\n';

  // Atención principal y derivación a secundarios (solo si la persona lo necesita)
  s += '\nATENCIÓN: TÚ (Valeria) eres la atención PRINCIPAL y respondes TODO; no derives por defecto. Si la persona necesita hablar con alguien del equipo, usa estas reglas por sub-sede:\n';
  (cfg.subsedes || []).forEach(function(sub) {
    const tels = sub.telefonos || [];
    if (!tels.length) return;
    let encargada = null, especialista = null;
    tels.forEach(function(t) {
      const c = CONTACTOS_BENI[t] || {};
      const rol = (c.rol || '').toLowerCase();
      if (rol.indexOf('encargad') !== -1) encargada = { tel: t, nombre: c.nombre || 'la encargada' };
      else if (rol.indexOf('especialista') !== -1) especialista = { tel: t, nombre: c.nombre || 'el especialista' };
      else if (!especialista) especialista = { tel: t, nombre: c.nombre || 'el equipo' };
    });
    if (encargada) {
      s += '- ' + sub.nombre + ': da SOLO el número de la encargada ' + encargada.nombre + ' (' + encargada.tel + ').';
      if (especialista) {
        s += ' Comparte el del especialista de Armonniza (' + especialista.tel + ') ÚNICAMENTE si la persona pregunta si hay alguien más, y aclara que con la encargada será atendido con más rapidez.';
      }
      s += '\n';
    } else if (especialista) {
      s += '- ' + sub.nombre + ': no hay encargada, así que el contacto (opción 1) es ' + especialista.nombre + ' (' + especialista.tel + ').\n';
    }
  });

  // Precios y contexto durante la campaña
  s += '\nPRECIOS EN ESTA CAMPAÑA: puedes dar los PRECIOS DE REFERENCIA de la lista (son aproximados; el valor final se define en la valoración), destacando siempre la calidad de nuestros tratamientos, la experiencia y la garantía de resultados. Recuérdales la PROMO DEL RECOMENDADO: traer un recomendado que se atienda da 40% de descuento en tu tratamiento (cada persona obtiene su propio 40% al traer a su recomendado). IMPORTANTE: durante la Jornada Beni la consulta de valoración es GRATIS y NO se cobra anticipo para reservar — menciónalo como un beneficio para invitar a reservar.\n';
  s += '\nCONTEXTO DE LA CAMPAÑA: la Jornada Beni es con nuestro especialista en medicina estética (NO menciones su nombre propio; di "el especialista de Armonniza"). Si preguntan por micropigmentación o por cualquier tratamiento que él realiza (Botox, rinomodelación, rellenos, hilos, PRP, micropigmentación en todas sus variantes), di que ÉL lo realiza y ofrécelo en la jornada; NO lo derives a otra especialista.\n';

  // Cómo agendar — SIEMPRE ofrecer las dos vías
  s += '\nAGENDAR — REGLA OBLIGATORIA: en cuanto la persona muestre intención de reservar/agendar, lo PRIMERO que haces (ANTES de pedir cualquier dato) es ofrecerle las DOS formas y preguntarle cuál prefiere. NUNCA empieces a pedir datos sin haber mencionado antes la opción del calendario web. Las dos formas son:\n';
  s += '(1) Que te la reserve YO aquí mismo en el chat ahora.\n';
  s += '(2) Que la persona MISMA vea el calendario en la web y elija su horario en pantalla. Cuando le compartas el enlace, hazlo cálido y con una frase de invitación, por ejemplo: "podés agendar vos misma acá 👉 armonniza.com/beni" — NUNCA pegues el link "pelado" sin una frase amable. Ahí ve los días y horas disponibles y reserva sola, con confirmación inmediata y sin pago online.\n';
  s += 'Menciona SIEMPRE la opción (2) del calendario web, aunque vayas a ayudarle tú; jamás la omitas. Solo DESPUÉS de que elija la opción (1), pide los datos —localidad y día (San Borja el lunes 15 o martes 16; Santa Rosa el jueves 18; Rurrenabaque el viernes 19 o sábado 20), hora, nombre completo y teléfono— de a poco y en frases cortas. Antes de crear, verifica con tu herramienta que el horario esté libre; si está ocupado, ofrece otro. Tras crear, confirma breve y cálida con localidad, día y hora.';
  return s;
}

// ══════════════════════════════════════════
// HELPERS DE "ESCRIBIENDO…" (delay proporcional al largo)
// ══════════════════════════════════════════
function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

function typingDelay(text) {
  const palabras = (text || '').trim().split(/\s+/).filter(Boolean).length;
  const ms = 600 + palabras * 90;            // ~90ms por palabra
  return Math.max(800, Math.min(ms, 3500));   // entre 0.8s y 3.5s
}

// ══════════════════════════════════════════
// HERRAMIENTAS DE CALENDARIO — JORNADA BENI (tool-use de Claude)
// ══════════════════════════════════════════
const BENI_TOOLS = [
  {
    name: 'consultar_disponibilidad_beni',
    description: 'Consulta los días y horarios LIBRES de la Jornada Beni. Úsala cuando la persona pregunte por disponibilidad, qué días hay, o quiera reservar. Devuelve los cupos libres por sub-sede y fecha.',
    input_schema: {
      type: 'object',
      properties: {
        subsede: { type: 'string', enum: ['San Borja', 'Santa Rosa', 'Rurrenabaque'], description: 'Localidad. Opcional; si se omite, devuelve todas.' },
        fecha: { type: 'string', description: 'Fecha en formato YYYY-MM-DD. Opcional; si se omite, devuelve todos los días de la campaña.' }
      }
    }
  },
  {
    name: 'crear_reserva_beni',
    description: 'Crea (confirma) una reserva en la Jornada Beni. Úsala SOLO cuando ya tengas los 5 datos: subsede, fecha, hora, nombre completo y teléfono, y el horario esté libre. Si el horario está ocupado devolverá error y deberás ofrecer otro.',
    input_schema: {
      type: 'object',
      properties: {
        subsede: { type: 'string', enum: ['San Borja', 'Santa Rosa', 'Rurrenabaque'] },
        fecha: { type: 'string', description: 'YYYY-MM-DD' },
        hora: { type: 'string', description: 'HH:MM en 24h, ej 09:00, 16:00' },
        nombre: { type: 'string', description: 'Nombre completo del paciente' },
        telefono: { type: 'string', description: 'Teléfono / WhatsApp del paciente' },
        tratamiento: { type: 'string', description: 'Tratamiento de interés. Opcional.' }
      },
      required: ['subsede', 'fecha', 'hora', 'nombre', 'telefono']
    }
  },
  {
    name: 'avisar_a_humano',
    description: 'Avisa de INMEDIATO a una persona del equipo de Armonniza para que intervenga en este chat. Úsala apenas: el cliente pide hablar con una persona/encargado/humano, expresa una queja o molestia, hay un problema que no puedes resolver, o pide algo fuera de tus capacidades. Tras usarla, dile al cliente de forma cálida que ya avisaste a alguien del equipo.',
    input_schema: {
      type: 'object',
      properties: {
        motivo: { type: 'string', description: 'Motivo breve por el que se necesita un humano (ej: "pide hablar con encargado", "queja por demora", "consulta médica compleja").' }
      },
      required: ['motivo']
    }
  }
];

// Mismo esquema de ID que la web (beni.html): beni_FECHA_HHMM. Como cada fecha
// pertenece a una sola sub-sede, fecha+hora identifica el cupo sin ambigüedad.
function beniSlotId(fecha, hora) { return 'beni_' + fecha + '_' + String(hora).replace(':', ''); }

// Normaliza la hora que diga el modelo ("4 pm", "4 de la tarde", "16", "9") → "HH:MM".
// Si recibe la lista de horas válidas, ajusta mañana/tarde automáticamente.
function normalizarHora(h, horasValidas) {
  var s = String(h || '').toLowerCase().trim();
  var tarde = /tarde|noche|p\s*\.?\s*m/.test(s);
  var manana = /ma(ñ|n)ana|a\s*\.?\s*m/.test(s);
  var m = s.match(/(\d{1,2})(?::?(\d{2}))?/);
  if (!m) return String(h || '');
  var hh = parseInt(m[1], 10), mm = m[2] || '00';
  if (tarde && hh < 12) hh += 12;
  if (manana && hh === 12) hh = 0;
  var cand = ('0' + hh).slice(-2) + ':' + mm;
  if (horasValidas && horasValidas.length) {
    if (horasValidas.indexOf(cand) !== -1) return cand;
    var alt = ('0' + ((hh + 12) % 24)).slice(-2) + ':' + mm;  // ej: "4" sin franja → prueba 16:00
    if (horasValidas.indexOf(alt) !== -1) return alt;
  }
  return cand;
}
// Resuelve la localidad sin importar mayúsculas/acentos ("san borja" → "San Borja").
function resolverSubsede(sub, cfg) {
  var norm = function(x) { return String(x || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim(); };
  var s = norm(sub);
  if (!s) return sub;
  var ids = (cfg.subsedes || []).map(function(x) { return x.id; });
  var hit = ids.find(function(id) { return norm(id) === s || norm(id).replace(/\s/g, '') === s.replace(/\s/g, ''); });
  return hit || sub;
}
// Resuelve la fecha que diga el modelo ("lunes 15", "15", "2026-6-15") → "YYYY-MM-DD" de la campaña.
function resolverFecha(fechaArg, subsede, cfg) {
  var dias = (cfg.dias || []).filter(function(d) { return !subsede || d.subsede === subsede; });
  if (!dias.length) dias = cfg.dias || [];
  var f = String(fechaArg || '').trim();
  var ex = dias.find(function(d) { return d.fecha === f; });
  if (ex) return ex.fecha;
  var m = f.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) { var norm = m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2); var n = dias.find(function(d) { return d.fecha === norm; }); if (n) return n.fecha; }
  var dm = f.match(/(\d{1,2})/);
  if (dm) { var dd = ('0' + dm[1]).slice(-2); var byDay = dias.find(function(d) { return d.fecha.slice(-2) === dd; }); if (byDay) return byDay.fecha; }
  return f;
}

async function toolConsultarDisponibilidad(args, cfg) {
  if (!db) return { error: 'No puedo acceder a la agenda en este momento.' };
  if (!cfg || cfg.publicada !== true) return { error: 'La Jornada Beni aún no está publicada.' };
  const horas = cfg.horas || [];
  let dias = cfg.dias || [];
  if (args.subsede) { var ss = resolverSubsede(args.subsede, cfg); dias = dias.filter(function(d) { return d.subsede === ss; }); }
  if (args.fecha) { var fr = resolverFecha(args.fecha, args.subsede, cfg); if (dias.some(function(d) { return d.fecha === fr; })) dias = dias.filter(function(d) { return d.fecha === fr; }); }
  if (!dias.length) return { disponibilidad: [], nota: 'No hay jornadas para ese criterio. Las sedes activas son San Borja (lunes 15 y martes 16 de junio) y Santa Rosa (jueves 18 de junio).' };

  // Fuente de verdad de cupos = colección cupos_ocupados (la MISMA que usa la web).
  const ocupados = new Set();
  try {
    const snap = await db.collection('cupos_ocupados').where('jornadaId', '==', 'beni').get();
    snap.forEach(function(doc) { ocupados.add(doc.id); });
  } catch (e) { console.error('cupos_ocupados read:', e.message); }

  const result = dias.map(function(d) {
    const libres = horas.filter(function(h) { return !ocupados.has(beniSlotId(d.fecha, h)); });
    const sub = (cfg.subsedes || []).find(function(s) { return s.id === d.subsede; }) || {};
    return { subsede: d.subsede, direccion: sub.direccion || '', fecha: d.fecha, label: d.label, horas_libres: libres };
  });
  return { disponibilidad: result, promo: cfg.promo };
}

async function toolCrearReserva(args, cfg, canal) {
  if (!db) return { error: 'No puedo acceder a la agenda en este momento.' };
  if (!cfg || cfg.publicada !== true) return { error: 'La Jornada Beni aún no está publicada.' };
  const subsede = resolverSubsede(args.subsede, cfg);
  const fecha = resolverFecha(args.fecha, subsede, cfg);
  const hora = normalizarHora(args.hora, cfg.horas);
  const nombre = (args.nombre || '').trim(), telefono = (args.telefono || '').trim();
  if (!subsede || !fecha || !hora || !nombre || !telefono) {
    return { error: 'Faltan datos. Necesito localidad, día, hora, nombre completo y teléfono.' };
  }
  const diaOk = (cfg.dias || []).some(function(d) { return d.subsede === subsede && d.fecha === fecha; });
  const horaOk = (cfg.horas || []).includes(hora);
  if (!diaOk || !horaOk) return { error: 'Ese día/hora no es parte de la Jornada Beni. Ofrece un día y hora válidos de la campaña.' };

  const slotId = beniSlotId(fecha, hora);
  // ¿Cupo ya ocupado? (misma fuente que la web → evita doble reserva)
  try {
    const cupo = await db.collection('cupos_ocupados').doc(slotId).get();
    if (cupo.exists) return { error: 'Ese horario ya está ocupado. Ofrece otro horario libre del mismo día u otro día.' };
  } catch (e) { console.error('cupo check:', e.message); }

  const sub = (cfg.subsedes || []).find(function(s) { return s.id === subsede; }) || {};
  const lugar = sub.direccion ? (subsede + ' — ' + sub.direccion) : subsede;

  // Batch: bloquea el cupo Y crea la reserva con el MISMO id que la web (beni_FECHA_HHMM).
  const batch = db.batch();
  batch.set(db.collection('cupos_ocupados').doc(slotId), { jornadaId: 'beni', fecha: fecha, hora: hora, ocupado: true });
  batch.set(db.collection('reservas_beni').doc(slotId), {
    jornadaId: 'beni', fecha: fecha, hora: hora,
    lugar: lugar, subsede: subsede,
    especialista: cfg.especialista || 'Equipo Armonniza', especialidad: cfg.especialidad || '',
    nombre: nombre, telefono: telefono, email: '', notas: args.tratamiento || '',
    estado: 'confirmada', canal: canal || 'chat',
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
  await batch.commit();

  return { ok: true, id: slotId, mensaje: 'Reserva confirmada: ' + subsede + ', ' + fecha + ' ' + hora + ', a nombre de ' + nombre + '.' };
}

// ── AVISO A HUMANO (handoff proactivo): Telegram + WhatsApp ──
const ADMIN_WHATSAPP = process.env.ADMIN_WHATSAPP || '59178922666';
const ADMIN_PIN = process.env.ADMIN_PIN || 'armonniza591';

async function getAdminTelegram() {
  if (db) {
    try { const s = await db.collection('config').doc('handoff').get(); if (s.exists && s.data().telegramAdminChatId) return s.data().telegramAdminChatId; } catch (e) {}
  }
  return process.env.ADMIN_TELEGRAM_CHAT_ID || null;
}

// Avisa AL INSTANTE a Julio (Telegram + WhatsApp) que un chat necesita atención humana.
async function notificarHumano(userId, motivo) {
  const canal = String(userId).split('_')[0];
  const contacto = String(userId).split('_').slice(1).join('_');
  const canalNombre = canal === 'tg' ? 'Telegram' : canal === 'wa' ? 'WhatsApp' : canal === 'fb' ? 'Facebook' : canal;
  let nombre = '';
  try { if (db) { const s = await db.collection('valeria_chats').doc(userId).get(); if (s.exists) nombre = s.data().nombre || ''; } } catch (e) {}
  const aviso = '🔔 Valeria necesita un humano\n'
    + 'Canal: ' + canalNombre + (nombre ? ' — ' + nombre : '') + '\n'
    + 'Contacto: ' + contacto + '\n'
    + 'Motivo: ' + (motivo || 'el cliente pidió atención personal') + '\n'
    + 'Abrí el chat: https://www.armonniza.com/valeria-seguimiento?chat=' + encodeURIComponent(userId);
  // marca el chat para que el panel lo resalte
  try { if (db) await db.collection('valeria_chats').doc(userId).set({ necesitaHumano: true, motivoHumano: motivo || '', humanoTs: Date.now() }, { merge: true }); } catch (e) { console.error('flag humano:', e.message); }
  // Telegram (confiable hoy)
  try { const adm = await getAdminTelegram(); if (adm) await bot.sendMessage(adm, aviso); else console.log('⚠️ aviso humano: sin admin de Telegram registrado (/admin)'); } catch (e) { console.error('aviso TG:', e.message); }
  // WhatsApp (libre; si no hay ventana de 24h Meta lo rechaza, por eso conviene plantilla)
  try { await waSend(ADMIN_WHATSAPP, aviso); } catch (e) { console.error('aviso WA:', e.message); }
  console.log('🔔 Aviso humano enviado para ' + userId + ' (' + motivo + ')');
  return { ok: true, mensaje: 'Listo, ya avisé a una persona del equipo para que te atienda enseguida.' };
}

async function ejecutarTool(block, cfg, canal, userId) {
  try {
    if (block.name === 'consultar_disponibilidad_beni') return await toolConsultarDisponibilidad(block.input || {}, cfg);
    if (block.name === 'crear_reserva_beni') return await toolCrearReserva(block.input || {}, cfg, canal);
    if (block.name === 'avisar_a_humano') return await notificarHumano(userId, (block.input && block.input.motivo) || '');
    return { error: 'herramienta desconocida' };
  } catch (e) {
    console.error('Tool error (' + block.name + '):', e.message);
    return { error: 'No pude completar esa acción ahora mismo.' };
  }
}

// ══════════════════════════════════════════
// FUNCIÓN PRINCIPAL CLAUDE AI
// ══════════════════════════════════════════
async function askValeria(userId, userMessage) {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

  await cargarHistorialSiVacio(userId);
  addToHistory(userId, 'user', userMessage);
  logMensaje(userId, 'user', userMessage);

  // Handoff: si un humano tomó este chat (pausada), el bot no responde.
  if (await chatPausado(userId)) {
    console.log('⏸️ Valeria pausada (humano atendiendo): ' + userId);
    return null;
  }

  const beniCfg = await getBeniConfig();
  const origen = await getChatOrigen(userId);
  const systemPrompt = SYSTEM_PROMPT
    + '\n\nFecha actual (Bolivia): ' + fechaBoliviaTexto() + '.'
    + buildBeniSection(beniCfg)
    + (origen ? ('\n\n[ORIGEN DE ESTE CONTACTO — MUY IMPORTANTE]: esta persona te escribió tras hacer clic en un ' + origen + '. Trátala como un contacto CALIENTE de la Jornada Beni: si aún no la saludaste en esta conversación, salúdala con calidez reconociendo que te escribe desde nuestra Jornada Beni e INTRODUCE de entrada la campaña (las sedes y fechas vigentes, el 40% de descuento por traer un recomendado y la valoración GRATIS), orientándola con naturalidad a reservar su cupo. Responde su pregunta puntual, pero engánchala siempre con la Jornada Beni. No suenes insistente ni vuelvas a saludar si ya lo hiciste.') : '');

  // Copia de trabajo del historial (los turnos de herramientas NO se persisten,
  // solo el texto final, para mantener limpio conversationHistory).
  // Construye los turnos garantizando que ALTERNEN (requisito del modelo) y empiecen en "user".
  const messages = [];
  getHistory(userId).forEach(function(m) {
    const role = m.role === 'user' ? 'user' : 'assistant';
    if (messages.length && messages[messages.length - 1].role === role) {
      messages[messages.length - 1].content += '\n' + m.content; // colapsa turnos del mismo rol
    } else {
      messages.push({ role: role, content: m.content });
    }
  });
  while (messages.length && messages[0].role !== 'user') messages.shift(); // debe empezar con user
  const canal = (userId.split('_')[0]) || 'chat';
  const toolsEnabled = !!db && beniCfg && beniCfg.publicada === true;

  try {
    for (let iter = 0; iter < 4; iter++) {
      const reqBody = {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        system: systemPrompt,
        messages: messages
      };
      if (toolsEnabled) reqBody.tools = BENI_TOOLS;

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify(reqBody)
      });

      const data = await response.json();

      if (data.error) {
        console.error('Claude API error:', data.error);
        return 'Hola! Soy Valeria de ARMONNIZA 💆‍♀️ Tengo un problema técnico en este momento. Por favor escríbenos al WhatsApp +591 76951552 y te atendemos de inmediato 😊';
      }

      // ¿Claude pide usar una herramienta? Ejecutarla y volver a llamar.
      if (data.stop_reason === 'tool_use') {
        messages.push({ role: 'assistant', content: data.content });
        const toolResults = [];
        for (const block of data.content) {
          if (block.type === 'tool_use') {
            const result = await ejecutarTool(block, beniCfg, canal, userId);
            console.log('🛠️ ' + block.name + ' →', JSON.stringify(result).substring(0, 160));
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
          }
        }
        messages.push({ role: 'user', content: toolResults });
        continue;
      }

      // Respuesta de texto normal.
      const reply = (data.content || [])
        .filter(function(b) { return b.type === 'text'; })
        .map(function(b) { return b.text; })
        .join('\n').trim() || 'Con gusto te ayudo 😊';
      addToHistory(userId, 'assistant', reply);
      logMensaje(userId, 'valeria', reply);
      console.log(`🤖 Valeria → ${userId}: ${reply.substring(0, 100)}...`);
      return reply;
    }

    // Si se agotó el bucle sin respuesta final.
    return 'Con gusto te ayudo a reservar tu cupo en la Jornada Beni 😊 Atendemos en San Borja (Hotel Kamahal) el lunes 15 y martes 16, y en Santa Rosa el jueves 18 de junio. ¿Qué localidad y día te quedan mejor?';

  } catch (err) {
    console.error('Error Claude AI:', err);
    return 'Hola! Soy Valeria de ARMONNIZA 💆‍♀️ Tengo un problema técnico. Por favor escríbenos al WhatsApp +591 76951552 😊';
  }
}

// ══════════════════════════════════════════
// TELEGRAM
// ══════════════════════════════════════════
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  if (!text) return;

  // Registro del admin que recibirá los avisos de handoff: "/admin <PIN>"
  if (text.toLowerCase().startsWith('/admin')) {
    const pin = text.split(/\s+/)[1] || '';
    if (pin === ADMIN_PIN) {
      try { if (db) await db.collection('config').doc('handoff').set({ telegramAdminChatId: chatId }, { merge: true }); } catch (e) { console.error('reg admin:', e.message); }
      bot.sendMessage(chatId, '✅ Listo. Vas a recibir acá los avisos cuando Valeria necesite que intervengas.');
    } else {
      bot.sendMessage(chatId, '🔒 PIN incorrecto. Usá: /admin TU_PIN');
    }
    return;
  }

  setChatNombre(`tg_${chatId}`, [msg.from && msg.from.first_name, msg.from && msg.from.last_name].filter(Boolean).join(' '));

  console.log(`📱 Telegram de ${chatId}: ${text}`);
  const t0 = Date.now();
  bot.sendChatAction(chatId, 'typing');
  const reply = await askValeria(`tg_${chatId}`, text);
  const espera = typingDelay(reply) - (Date.now() - t0);
  if (reply) {
    if (espera > 0) { bot.sendChatAction(chatId, 'typing'); await sleep(espera); }
    bot.sendMessage(chatId, reply);
  }
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

// Indicador "escribiendo…" de WhatsApp Cloud API (usa el message_id entrante).
// Defensivo: si la API lo rechaza, no afecta la respuesta.
async function waTyping(messageId) {
  if (!messageId) return;
  const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
  const PHONE_ID = process.env.WHATSAPP_PHONE_ID;
  try {
    await fetch(`https://graph.facebook.com/v25.0/${PHONE_ID}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: messageId, typing_indicator: { type: 'text' } })
    });
  } catch (err) { console.error('Error WA typing:', err.message); }
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

// "escribiendo…" en Messenger (sender_action: typing_on / typing_off)
async function fbAction(recipientId, action) {
  const FB_TOKEN = process.env.MESSENGER_TOKEN;
  try {
    await fetch(`https://graph.facebook.com/v25.0/me/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${FB_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: { id: recipientId }, sender_action: action })
    });
  } catch (err) { console.error('Error Messenger action:', err.message); }
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

// "escribiendo…" en Instagram (sender_action: typing_on / typing_off)
async function igAction(recipientId, action) {
  const IG_TOKEN = process.env.INSTAGRAM_TOKEN;
  const PAGE_ID = '100361346281528';
  try {
    await fetch(`https://graph.facebook.com/v25.0/${PAGE_ID}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${IG_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: { id: recipientId }, sender_action: action })
    });
  } catch (err) { console.error('Error IG action:', err.message); }
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
        const nombreWa = change.value?.contacts?.[0]?.profile?.name;
        if (messages) {
          messages.forEach(async (message) => {
            const from = message.from;
            if (from.includes('78118003')) return;
            const text = message.text?.body || '';
            console.log(`📱 WhatsApp de ${from}: ${text}`);
            setChatNombre(`wa_${from}`, nombreWa);
            const ref = message.referral;
            if (ref && (ref.source_type === 'ad' || ref.headline || ref.body)) {
              const desc = 'anuncio en Facebook/Instagram/WhatsApp'
                + (ref.headline ? ' titulado "' + ref.headline + '"' : '')
                + (ref.body ? ' — ' + String(ref.body).substring(0, 200) : '');
              setChatOrigen(`wa_${from}`, desc);
              console.log(`📢 WhatsApp referral (anuncio): ${desc.substring(0, 140)}`);
            }
            const t0 = Date.now();
            await waTyping(message.id);
            const reply = await askValeria(`wa_${from}`, text);
            if (reply) {
              const espera = typingDelay(reply) - (Date.now() - t0);
              if (espera > 0) await sleep(espera);
              await waSend(from, reply);
            }
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
          const t0 = Date.now();
          await fbAction(userId, 'typing_on');
          const reply = await askValeria(`fb_${userId}`, text);
          if (reply) {
            const espera = typingDelay(reply) - (Date.now() - t0);
            if (espera > 0) await sleep(espera);
            await fbSend(userId, reply);
          }
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
          const t0 = Date.now();
          await igAction(userId, 'typing_on');
          const reply = await askValeria(`ig_${userId}`, text);
          if (reply) {
            const espera = typingDelay(reply) - (Date.now() - t0);
            if (espera > 0) await sleep(espera);
            await igSend(userId, reply);
          }
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

// Verificación de conexión a Firebase (sin secretos)
app.get('/firebase-status', (req, res) => {
  res.json({ connected: !!db, varPresent: fbVarPresent, varLen: fbVarLen, error: fbInitError });
});

// Diagnóstico: ¿está activa la WhatsApp Cloud API? (sin exponer el token)
app.get('/wa-check', async (req, res) => {
  const TOKEN_WA = process.env.WHATSAPP_TOKEN;
  const PHONE_ID = process.env.WHATSAPP_PHONE_ID;
  const out = { tokenPresent: !!TOKEN_WA, phoneIdPresent: !!PHONE_ID };
  if (!TOKEN_WA || !PHONE_ID) { out.activa = false; out.motivo = 'Faltan variables WHATSAPP_TOKEN / WHATSAPP_PHONE_ID'; return res.json(out); }
  try {
    const r = await fetch(`https://graph.facebook.com/v21.0/${PHONE_ID}?fields=verified_name,display_phone_number,quality_rating,code_verification_status,name_status`, {
      headers: { 'Authorization': `Bearer ${TOKEN_WA}` }
    });
    const data = await r.json();
    out.httpStatus = r.status;
    if (r.ok) { out.activa = true; out.numero = data.display_phone_number; out.nombre = data.verified_name; out.calidad = data.quality_rating; out.verificacion = data.code_verification_status; out.nameStatus = data.name_status; }
    else { out.activa = false; out.error = (data.error && data.error.message) || 'token o phone_id inválidos'; }
  } catch (e) { out.activa = false; out.error = e.message; }
  res.json(out);
});

// Lectura de la config de la Jornada Beni (datos públicos de campaña)
app.get('/beni-config', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Firebase no conectado' });
  try {
    const snap = await db.collection('config').doc('jornada_beni').get();
    res.json(snap.exists ? snap.data() : { error: 'documento no existe' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/privacy', (req, res) => {
  res.send('<h1>Política de Privacidad - ARMONNIZA</h1><p>ARMONNIZA recopila datos de contacto únicamente para gestionar citas y consultas médico-estéticas. No compartimos información con terceros.</p>');
});

app.get('/terms', (req, res) => {
  res.send('<h1>Términos de Servicio - ARMONNIZA</h1><p>Al usar nuestros servicios digitales aceptas que tus datos serán usados exclusivamente para gestión de citas en ARMONNIZA.</p>');
});

// ══════════════════════════════════════════
// RECORDATORIOS AUTOMÁTICOS — Jornada Beni (plantilla WhatsApp aprobada por Meta)
// 24h antes de la cita + el mismo día a partir de las 8:00 AM (hora Bolivia, UTC-4).
// Lee reservas_beni, envía la plantilla y marca el doc para no duplicar.
// ══════════════════════════════════════════
const WA_TEMPLATE_RECORDATORIO = process.env.WA_TEMPLATE_RECORDATORIO || 'recordatorio_jornada_beni';
const WA_TEMPLATE_LANG = process.env.WA_TEMPLATE_LANG || 'es';

// 8 dígitos -> 591XXXXXXXX (Bolivia). Si ya viene con 591, se respeta.
function normalizarTelefono(tel) {
  let d = String(tel || '').replace(/\D/g, '');
  if (d.length === 8) d = '591' + d;
  return d;
}

// Cita (hora Bolivia) -> Date en UTC (Bolivia = UTC-4, por eso +4h)
function citaFechaUTC(fecha, hora) {
  const p = String(fecha || '').split('-').map(Number);
  const t = String(hora || '').split(':').map(Number);
  if (p.length < 3) return new Date(NaN);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2], (t[0] || 0) + 4, t[1] || 0, 0));
}

async function enviarPlantillaRecordatorio(r, cfg) {
  const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
  const PHONE_ID = process.env.WHATSAPP_PHONE_ID;
  const to = normalizarTelefono(r.telefono);
  if (!to || to.length < 8) { console.warn('Recordatorio: teléfono inválido', r.telefono); return false; }
  const dia = ((cfg && cfg.dias) || []).find(function (x) { return x.fecha === r.fecha; });
  const diaLabel = (dia && dia.label) || r.fecha;
  const lugar = r.lugar || r.subsede || 'la sede de la Jornada Beni';
  const nombre = (r.nombre || 'paciente').trim().split(/\s+/)[0]; // primer nombre, más cálido
  try {
    const resp = await fetch(`https://graph.facebook.com/v25.0/${PHONE_ID}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: to,
        type: 'template',
        template: {
          name: WA_TEMPLATE_RECORDATORIO,
          language: { code: WA_TEMPLATE_LANG },
          components: [{
            type: 'body',
            parameters: [
              { type: 'text', text: nombre },
              { type: 'text', text: diaLabel },
              { type: 'text', text: r.hora || '' },
              { type: 'text', text: lugar }
            ]
          }]
        }
      })
    });
    const data = await resp.json();
    if (data.error) { console.error('Recordatorio API error:', JSON.stringify(data.error)); return false; }
    console.log('🔔 Recordatorio enviado a ' + to + ' (' + nombre + ', ' + diaLabel + ' ' + (r.hora || '') + ')');
    return true;
  } catch (e) { console.error('Recordatorio fetch error:', e.message); return false; }
}

let _recoRunning = false;
async function correrRecordatorios() {
  if (!db || _recoRunning) return;
  _recoRunning = true;
  try {
    const cfg = await getBeniConfig();
    const ahora = new Date(); // UTC real
    const bo = new Date(Date.now() - 4 * 60 * 60 * 1000); // desplazado a hora Bolivia
    const boHora = bo.getUTCHours();
    const boFecha = bo.getUTCFullYear() + '-' + String(bo.getUTCMonth() + 1).padStart(2, '0') + '-' + String(bo.getUTCDate()).padStart(2, '0');
    const h24 = 24 * 60 * 60 * 1000;

    const snap = await db.collection('reservas_beni').get();
    for (const doc of snap.docs) {
      const r = doc.data();
      if (!r || !r.fecha || !r.hora || !r.telefono || r.estado === 'cancelada') continue;
      const citaUTC = citaFechaUTC(r.fecha, r.hora);
      if (isNaN(citaUTC.getTime()) || ahora.getTime() >= citaUTC.getTime()) continue; // sin fecha válida o ya pasó
      const msHastaCita = citaUTC.getTime() - ahora.getTime();

      // Recordatorio 1: cuando faltan 24h o menos (una sola vez)
      if (!r.recordatorio24Enviado && msHastaCita <= h24) {
        const ok = await enviarPlantillaRecordatorio(r, cfg);
        if (ok) await doc.ref.update({ recordatorio24Enviado: true, recordatorio24At: admin.firestore.FieldValue.serverTimestamp() });
      }
      // Recordatorio 2: el mismo día desde las 8:00 AM Bolivia (una sola vez)
      if (!r.recordatorioDiaEnviado && boFecha === r.fecha && boHora >= 8) {
        const ok = await enviarPlantillaRecordatorio(r, cfg);
        if (ok) await doc.ref.update({ recordatorioDiaEnviado: true, recordatorioDiaAt: admin.firestore.FieldValue.serverTimestamp() });
      }
    }
  } catch (e) {
    console.error('correrRecordatorios error:', e.message);
  } finally {
    _recoRunning = false;
  }
}

// Arranca a los 30s y luego cada 20 minutos
if (db) {
  setTimeout(correrRecordatorios, 30000);
  setInterval(correrRecordatorios, 20 * 60 * 1000);
}

// Disparo manual para probar (no reenvía los ya marcados)
app.get('/run-recordatorios', async (req, res) => {
  await correrRecordatorios();
  res.json({ ok: true, ts: new Date().toISOString() });
});

// Prueba directa de la plantilla: GET /test-recordatorio?to=59171234567
// Envía la plantilla con datos de ejemplo y devuelve la respuesta de Meta (para ver errores).
app.get('/test-recordatorio', async (req, res) => {
  const to = normalizarTelefono(req.query.to || '');
  if (!to || to.length < 8) return res.status(400).json({ error: 'falta o es inválido ?to=NUMERO (ej: 59171234567)' });
  const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
  const PHONE_ID = process.env.WHATSAPP_PHONE_ID;
  try {
    const resp = await fetch(`https://graph.facebook.com/v25.0/${PHONE_ID}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', to: to, type: 'template',
        template: {
          name: WA_TEMPLATE_RECORDATORIO, language: { code: WA_TEMPLATE_LANG },
          components: [{ type: 'body', parameters: [
            { type: 'text', text: 'Ana' },
            { type: 'text', text: 'lunes 15 de junio' },
            { type: 'text', text: '10:00' },
            { type: 'text', text: 'San Borja — Hotel Kamahal' }
          ] }]
        }
      })
    });
    const data = await resp.json();
    res.json({ sentTo: to, lang: WA_TEMPLATE_LANG, template: WA_TEMPLATE_RECORDATORIO, response: data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════
// HERRAMIENTAS PARA LA VOZ (Vapi) — agenda en vivo (misma base que el chat)
// Vapi llama a este endpoint cuando Valeria (voz) usa una herramienta.
// ══════════════════════════════════════════
app.post('/vapi/tools', async (req, res) => {
  try {
    const msg = (req.body && req.body.message) || {};
    const calls = msg.toolCallList || msg.toolCalls || [];
    const cfg = await getBeniConfig();
    const results = [];
    for (const c of calls) {
      const id = c.id || (c.toolCall && c.toolCall.id) || '';
      const name = c.name || (c.function && c.function.name) || '';
      let args = c.arguments || (c.function && c.function.arguments) || {};
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch (e) { args = {}; } }
      let result;
      if (name === 'consultar_disponibilidad_beni') result = await toolConsultarDisponibilidad(args, cfg);
      else if (name === 'crear_reserva_beni') result = await toolCrearReserva(args, cfg, 'voz');
      else result = { error: 'herramienta desconocida: ' + name };
      console.log('🛠️ [Vapi] ' + name + ' →', JSON.stringify(result).substring(0, 160));
      results.push({ toolCallId: id, result: JSON.stringify(result) });
    }
    res.json({ results: results });
  } catch (e) {
    console.error('/vapi/tools:', e.message);
    res.status(200).json({ results: [] });
  }
});

// Endpoints REST simples para el tipo "Solicitud de API" de Vapi (parámetros en el body, respuesta directa).
app.post('/beni/disponibilidad', async (req, res) => {
  console.log('📞 [Vapi disponibilidad] body:', JSON.stringify(req.body || {}));
  try {
    const cfg = await getBeniConfig();
    const r = await toolConsultarDisponibilidad(req.body || {}, cfg);
    console.log('📞 [Vapi disponibilidad] resp:', JSON.stringify(r).substring(0, 200));
    res.json(r);
  } catch (e) { console.error('/beni/disponibilidad:', e.message); res.status(200).json({ error: 'No pude consultar la agenda ahora.' }); }
});
app.post('/beni/reservar', async (req, res) => {
  console.log('📞 [Vapi reservar] body:', JSON.stringify(req.body || {}));
  try {
    const cfg = await getBeniConfig();
    const r = await toolCrearReserva(req.body || {}, cfg, 'voz');
    console.log('📞 [Vapi reservar] resp:', JSON.stringify(r).substring(0, 200));
    res.json(r);
  } catch (e) { console.error('/beni/reservar:', e.message); res.status(200).json({ error: 'No pude crear la reserva ahora.' }); }
});

app.listen(PORT, () => console.log(`✅ Valeria Bot corriendo en puerto ${PORT}`));
