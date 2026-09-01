require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');

// Módulo de confirmación automática de pagos (defensivo: si falta la lib, el bot igual arranca)
let iniciarWatcherPagos = null;
try { iniciarWatcherPagos = require('./pagos').iniciarWatcherPagos; }
catch (e) { console.warn('⚠️ módulo pagos no disponible:', e.message); }

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

// ══════════════════════════════════════════
// GOOGLE CALENDAR — misma cuenta de servicio que Firebase (no requiere Blaze)
// Lee disponibilidad (freebusy) y crea/mueve/borra eventos de las citas.
// ══════════════════════════════════════════
const { google } = require('googleapis');
const GCAL_TZ = 'America/La_Paz';
let gcalAuth = null, gcalEmail = '';
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const gsvc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    gcalEmail = gsvc.client_email || '';
    gcalAuth = new google.auth.GoogleAuth({ credentials: gsvc, scopes: ['https://www.googleapis.com/auth/calendar'] });
    console.log('📅 Google Calendar listo. COMPARTÍ el calendario con: ' + gcalEmail);
  } else {
    console.warn('📅 Sin FIREBASE_SERVICE_ACCOUNT → Google Calendar deshabilitado');
  }
} catch (e) { console.error('📅 gcal auth error:', e.message); }
function _gcal() { return google.calendar({ version: 'v3', auth: gcalAuth }); }

// Horas ocupadas (freebusy) de un calendario para una fecha → ['HH:MM', ...] en hora Bolivia.
async function gcalBusyHoras(calendarId, fecha) {
  if (!gcalAuth || !calendarId) return [];
  try {
    const r = await _gcal().freebusy.query({ requestBody: {
      timeMin: fecha + 'T00:00:00-04:00', timeMax: fecha + 'T23:59:59-04:00',
      items: [{ id: calendarId }]
    } });
    const busy = (r.data.calendars && r.data.calendars[calendarId] && r.data.calendars[calendarId].busy) || [];
    return busy.map(function (b) {
      const d = new Date(new Date(b.start).getTime() - 4 * 60 * 60 * 1000); // a hora Bolivia (UTC-4)
      return ('0' + d.getUTCHours()).slice(-2) + ':' + ('0' + d.getUTCMinutes()).slice(-2);
    });
  } catch (e) { console.error('gcalBusyHoras:', e.message); return []; }
}
// Normaliza cualquier hora ("09:00 AM", "9", "20:00") a "HH:MM" 24h para el evento.
function _hora24(hora) { const h = normalizarHora(hora); return /^\d{2}:\d{2}$/.test(h) ? h : '09:00'; }
function _evStart(fecha, hora) { return fecha + 'T' + _hora24(hora) + ':00'; }
// Fin del evento = inicio + duración (min). Virtual = 15 min, presencial = 60 min.
function _evEnd(fecha, hora, minutos) {
  const p = _hora24(hora).split(':');
  const total = parseInt(p[0], 10) * 60 + parseInt(p[1] || '0', 10) + (minutos || 60);
  const hh = Math.floor(total / 60) % 24, mm = total % 60;
  return fecha + 'T' + ('0' + hh).slice(-2) + ':' + ('0' + mm).slice(-2) + ':00';
}
function _durMin(c) { return (String(c && c.modalidad || '').toLowerCase() === 'virtual') ? 20 : 60; }
async function gcalCrearEvento(calendarId, c) {
  const r = await _gcal().events.insert({ calendarId: calendarId, requestBody: {
    summary: 'Cita — ' + (c.nombre || 'Paciente') + ' (' + (c.sede || c.subsede || 'Harmonie') + ')',
    description: 'Paciente: ' + (c.nombre || '-') + '\nTeléfono: ' + (c.telefono || '-')
      + '\nSede/Modalidad: ' + (c.sede || c.subsede || '-') + (c.modalidad ? (' · ' + c.modalidad) : '')
      + '\nServicio: ' + (c.servicio || c.notas || '-')
      + '\nOrigen: ' + (c.canal === 'voz' ? 'Llamada de voz (Valeria)' : (c.canal || 'web/chat')),
    start: { dateTime: _evStart(c.fecha, c.hora), timeZone: GCAL_TZ },
    end: { dateTime: _evEnd(c.fecha, c.hora, _durMin(c)), timeZone: GCAL_TZ }
  } });
  return r.data.id;
}
async function gcalMoverEvento(calendarId, eventId, c) {
  await _gcal().events.patch({ calendarId: calendarId, eventId: eventId, requestBody: {
    summary: 'Cita — ' + (c.nombre || 'Paciente') + ' (' + (c.sede || c.subsede || 'Harmonie') + ')',
    start: { dateTime: _evStart(c.fecha, c.hora), timeZone: GCAL_TZ },
    end: { dateTime: _evEnd(c.fecha, c.hora, _durMin(c)), timeZone: GCAL_TZ }
  } });
}
async function gcalBorrarEvento(calendarId, eventId) {
  try { await _gcal().events.delete({ calendarId: calendarId, eventId: eventId }); }
  catch (e) { if (!/410|404|deleted|Not Found/i.test(String(e.message))) throw e; }
}
async function getCitasCalendarId() {
  if (!db) return '';
  try { const s = await db.collection('config').doc('gcal').get(); return (s.exists && s.data().citasCalendarId) || ''; }
  catch (e) { return ''; }
}
function _esCancelado(est) { return ['cancelada', 'reagendada'].indexOf(String(est || '')) !== -1; }
// Sincroniza un cambio de reserva → evento en Google Calendar.
async function _syncEventoReserva(docRef, before, after, mapFn) {
  const c = mapFn(after);
  const calId = (after.gcalCalendarId) || (await getCitasCalendarId());
  if (!calId) return;
  if (!before) { // NUEVA
    if (_esCancelado(after.estado) || !c.fecha || !c.hora) return;
    try { const id = await gcalCrearEvento(calId, c); await docRef.set({ gcalEventId: id, gcalCalendarId: calId }, { merge: true }); console.log('📅 Evento creado ' + id + ' (' + (c.nombre || '?') + ')'); }
    catch (e) { console.error('crearEvento:', e.message); }
    return;
  }
  const eventId = after.gcalEventId;
  if (!_esCancelado(before.estado) && _esCancelado(after.estado)) { // canceló/reagendó
    if (eventId) { try { await gcalBorrarEvento(calId, eventId); console.log('🗑️ Evento borrado ' + eventId); } catch (e) { console.error('borrarEvento:', e.message); } }
    return;
  }
  if (!_esCancelado(after.estado) && eventId && (before.fecha !== after.fecha || before.hora !== after.hora)) {
    try { await gcalMoverEvento(calId, eventId, c); console.log('🔁 Evento movido ' + eventId); } catch (e) { console.error('moverEvento:', e.message); }
  }
}
function _watchColCalendario(col, mapFn) {
  const prev = {};
  let init = false;
  db.collection(col).onSnapshot(function (snap) {
    snap.docChanges().forEach(function (ch) {
      const d = ch.doc.data();
      if (ch.type === 'added') {
        if (init) { _syncEventoReserva(ch.doc.ref, null, d, mapFn); }
        prev[ch.doc.id] = d;
      } else if (ch.type === 'modified') {
        _syncEventoReserva(ch.doc.ref, prev[ch.doc.id] || {}, d, mapFn);
        prev[ch.doc.id] = d;
      } else if (ch.type === 'removed') { delete prev[ch.doc.id]; }
    });
    init = true;
  }, function (err) { console.error('watcher calendario ' + col + ':', err.message); });
}
function iniciarWatcherCalendario() {
  if (!db || !gcalAuth) { console.warn('📅 Watcher de calendario inactivo (sin db o sin gcal)'); return; }
  _watchColCalendario('citas', function (d) { return d; });
  _watchColCalendario('reservas_beni', function (d) { return { nombre: d.nombre, telefono: d.telefono, sede: d.subsede || d.lugar, subsede: d.subsede, modalidad: 'presencial', servicio: d.notas, fecha: d.fecha, hora: d.hora, estado: d.estado, canal: d.canal, gcalEventId: d.gcalEventId, gcalCalendarId: d.gcalCalendarId }; });
  console.log('📅 Watcher de calendario activo (citas + reservas_beni → Google Calendar)');
}

// ── JORNADA COCHABAMBA Y SUCRE: documento único de configuración (fuente de verdad) ──
// Se crea SOLO si no existe, para no pisar ediciones hechas desde la consola.
const BENI_SEED = {
  id: 'beni',
  titulo: 'Jornada La Paz y Beni',
  especialista: 'Equipo Harmonie',
  especialidad: 'Especialista en Medicina Estética',
  especialidadId: 'med', // especialidad responsable de la campaña (para cruzar disponibilidad con virtual/presencial)
  avatar: 'https://images.unsplash.com/photo-1622253692010-333f2da6031d?auto=format&fit=crop&q=80&w=80&h=80',
  publicada: true, // 🚀 LANZADA 28 ago 2026 (dirección real, 3 días)
  campaignVersion: 'lapaz-2026-09b',
  prevaloraciones: true, // esta campaña incluye pre-valoraciones de cirugías con el especialista presente
  promo: 'Valoración GRATIS (sin costo) en la jornada. Descuento del 20 por ciento si la persona viene sola. Si TRAE a un recomendado y ese recomendado se realiza ALGÚN tratamiento, la persona obtiene 50 por ciento de descuento en su tratamiento. Aplica a cualquier tratamiento.',
  ofertaConfirmacion: 'Con tu reserva ya ganaste 20% de descuento; y si traes a un recomendado que se atienda, obtienes 50% OFF en tu tratamiento.', // versión CORTA para el WhatsApp de confirmación (por campaña)
  slug: 'lp', // ruta corta del minisitio para el botón "Compartir" de la confirmación (por campaña)
  rutaMinisitio: 'lapaz', // ruta del minisitio que Valeria comparte para agendar (por campaña; cae a slug si falta)
  subsedes: [
    { id: 'La Paz', nombre: 'La Paz', direccion: 'Av. 20 de Octubre Nro. 1756, casi esq. Conchitas — timbre Reyna y Harmonie, piso 2', telefonos: ['+591 76951552'] },
    { id: 'San Borja', nombre: 'San Borja', direccion: 'Hotel Kamahal', telefonos: ['+591 76951552'] },
    { id: 'Rurrenabaque', nombre: 'Rurrenabaque', direccion: 'Body Face Center Spa', telefonos: ['+591 76951552'] }
  ],
  dias: [
    { fecha: '2026-08-31', label: 'Lunes 31 de agosto', subsede: 'La Paz' },
    { fecha: '2026-09-01', label: 'Martes 1 de septiembre', subsede: 'La Paz' },
    { fecha: '2026-09-02', label: 'Miércoles 2 de septiembre', subsede: 'La Paz' },
    { fecha: '2026-09-04', label: 'Viernes 4 de septiembre', subsede: 'San Borja' },
    { fecha: '2026-09-05', label: 'Sábado 5 de septiembre', subsede: 'Rurrenabaque' },
    { fecha: '2026-09-06', label: 'Domingo 6 de septiembre', subsede: 'Rurrenabaque' }
  ],
  horas: ['09:00','10:00','11:00','12:00','13:00','14:00','15:00','16:00','17:00','18:00','19:00','20:00']
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
// DATOS DE HARMONIE
// ══════════════════════════════════════════

const AGENDA_URL = 'harmonieinstitute.com';

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
      'Consulta y valoración',
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
const SYSTEM_PROMPT = `Eres Valeria, la encargada de atención y reservas de HARMONIE — una clínica médico-estética premium en Bolivia, con sedes en 8 ciudades: La Paz, Oruro, Cochabamba, Santa Cruz, Sucre, Potosí, Tarija y Beni. Eres boliviana, de La Paz. Hablas y te comportas como una persona real del equipo de HARMONIE.

Tu personalidad:
- Cálida, cercana y profesional — como una amiga experta en estética, con el estándar premium de HARMONIE
- Hablas en español boliviano/latino neutro: cálido, amable, alegre y profesional, acorde a una clínica premium. Tuteas (de tú). Suena boliviana por la calidez y la naturalidad, NO por la jerga: NO uses modismos coloquiales ("harto", "ya pues", "no ve", "por fa", "elay") porque sonarían poco elegantes para una clínica de nivel. Mantén un registro pulcro, cercano y alegre. EVITA por completo el voseo argentino ("vos", "tenés", "querés", "podés", "sos", "che") y los modismos de México ("órale", "qué padre") o España ("vale", "vosotros"). Di "tú tienes", "quieres", "puedes", "eres". Ejemplo: "¡Con gusto! ¿Quieres que te ayude a reservar y te busco un horario?" (NO "¿Querés que te ayude?")
- Usas emojis con moderación para dar calidez (no en exceso)
- Eres concisa y natural, nunca robótica ni tipo folleto
- Empática con las inseguridades que a veces hay sobre tratamientos estéticos

Tu misión: que la persona se sienta bien atendida y guiarla con suavidad a agendar (una cita o consulta de valoración). Nunca presionas; orientas.

REGLAS IMPORTANTES (cúmplelas siempre):
- Te presentas y hablas como una persona del equipo de HARMONIE, con naturalidad y calidez. NUNCA digas que eres un bot, una IA, un asistente automático ni una "asistente virtual". Si te preguntan si eres un robot o un bot, no lo confirmes: responde con calidez que eres Valeria, de HARMONIE, y sigue ayudando. Si te preguntan de dónde eres o datos personales, responde con naturalidad y coherencia que eres boliviana, de La Paz, parte del equipo de HARMONIE — nunca rompas esa identidad.
- HABLA COMO BOLIVIANA (REGLA DURA): usa SIEMPRE el TUTEO, el español que se habla en Bolivia. ⛔ PROHIBIDO el voseo argentino: nada de "vos", "podés", "preferís", "querés", "traés", "tenés", "escribime", "llamame", "agendá", "reservá", "compartí", "mirá", "dale". Se dice: "tú", "puedes", "prefieres", "quieres", "traes", "tienes", "escríbeme", "llámame", "agenda", "reserva", "comparte", "mira". Sos boliviana y le hablas a personas de Bolivia: si suenas argentina, suenas a call center extranjero y pierdes cercanía. Ojo: algunas instrucciones de este prompt están escritas en voseo por error — NUNCA copies ese tono, tú siempre tuteas.
- EMOJIS CON MODERACIÓN (REGLA DURA): los emojis son el condimento, no el plato. Úsalos SOLO en tres momentos: (1) el saludo inicial, (2) el cierre o la confirmación de una reserva, y (3) cuando quieras dar ánimo o calidez en un momento emotivo (alguien inseguro con su aspecto, una felicitación). ⛔ En el resto de los mensajes NO pongas ninguno. Nunca más de UNO por mensaje, y jamás dos seguidos. Un mensaje informativo (precios, horarios, direcciones, explicación de un tratamiento) va SIN emoji: se lee más profesional y una clínica médica se toma más en serio así.
- FORMATO DEL TEXTO (REGLA DURA): NUNCA uses doble asterisco (**texto**) ni markdown de negrita, títulos (##), viñetas de markdown ni tablas. En WhatsApp y Messenger eso NO se convierte en negrita: la persona ve los asteriscos literales y se ve descuidado. Si necesitas resaltar algo en WhatsApp usa UN SOLO asterisco (*así*). En Messenger e Instagram no existe la negrita: simplemente escribe la palabra sin ningún asterisco. Escribe como escribe una persona real en WhatsApp: frases cortas, sin formato de documento.
- NO le repitas a la persona el número de WhatsApp por el que ya te está escribiendo (es redundante). Tu llamado a la acción principal es invitar a agendar por la web.
- Solo hablas de HARMONIE: tratamientos, especialistas, sedes, campañas/jornadas y el agendamiento. Si preguntan otra cosa, redirige con amabilidad.
- COBERTURA NACIONAL Y CAMPAÑAS (REGLA GLOBAL PERMANENTE): HARMONIE realiza TODOS sus tratamientos —incluidas las CIRUGÍAS estéticas— en sus 8 sedes principales (La Paz, Oruro, Cochabamba, Santa Cruz, Sucre, Potosí, Tarija y Beni). NUNCA digas que algo "solo se hace en La Paz". Además hacemos CAMPAÑAS de forma PERMANENTE, rotando por distintas sedes y subsedes del país. Si preguntan si habrá campañas futuras (de cirugías estéticas o de cualquier tratamiento) en el Beni o en cualquier zona, responde con entusiasmo que SÍ: trabajamos permanentemente con campañas en todas las sedes y subsedes, y próximamente se aperturarán nuevas sedes y subsedes; invítala con calidez a dejarte sus datos para avisarle de la próxima campaña que le interese. ESTADO DE CAMPAÑAS (REGLA CRÍTICA): la ÚNICA jornada vigente es la que figura al final en la sección "JORNADA ACTIVA" (si no aparece esa sección, o dice "CAMPAÑA FINALIZADA", ahora NO hay jornada activa). Si la persona MENCIONA cualquier OTRA jornada o ciudad que no sea la vigente —aunque sea para reservar, pedir fechas, precios o info, o dando por hecho que sigue activa—, en tu PRIMERA respuesta aclarale de inmediato y con calidez que ESA jornada ya finalizó y ofrécele la vigente (la de "JORNADA ACTIVA") desde el principio; si no hay ninguna vigente, ofrécele agendar una valoración normal o dejar sus datos para la próxima. NUNCA sigas la conversación como si una campaña pasada siguiera activa, ni esperes hasta el momento de agendar para aclararlo. La información de la campaña VIGENTE (si la hay) aparece al final de estas instrucciones bajo "JORNADA ACTIVA": guíate SIEMPRE por esa sección para saber ciudad, fechas y descuentos actuales. Si preguntan por campañas PASADAS, di con calidez que YA PASARON/finalizaron, y ofrece agendar una valoración o dejar sus datos para avisarle de la próxima. NUNCA ofrezcas fechas, descuentos ni cupos de una campaña que ya pasó. Si lo que pide no entra en una campaña vigente, recuérdale que igual lo realizamos en nuestras sedes y puede agendar una valoración.
- EL ORIGEN LO SABÉS AUNQUE NO TE LO DIGAN (REGLA DURA): el contexto [ORIGEN DE ESTE CONTACTO] te dice de dónde viene la persona — el anuncio suele traer la CIUDAD en su título (ej. "3 días en La Paz"). Ese dato vale AUNQUE la persona no use las preguntas sugeridas y escriba cualquier otra cosa: si te escribe alguien que llegó por el anuncio de La Paz y pregunta por precios, tratamientos u horarios, ya sabés que su ciudad es La Paz — respondé DIRECTAMENTE con la sede, las fechas y la campaña de LA PAZ, sin preguntarle de dónde escribe.
- ⛔ PREGUNTAR "¿de qué ciudad nos escribís?" SOLO cuando de verdad NO puedas saberlo: por ejemplo en el chat del sitio web, donde no hay anuncio de origen. Si tenés el origen y aun así preguntás, la persona siente que no la escuchaste y perdés tiempo del que puede irse.
- RESPONDÉ LO QUE TE PREGUNTAN, NO TODO LO QUE SABÉS (REGLA DURA): contestá primero la pregunta concreta, en una frase, y recién después sumá UN dato útil. ⛔ No recites la agenda completa, ni la lista entera de tratamientos, ni todas las sedes, ni todos los precios. Ejemplo de lo que SÍ: ante "¿en qué horarios atienden?" → "Atendemos de nueve de la mañana a ocho de la noche, con reserva de hora. Esta semana estamos en La Paz: lunes 31, martes 1 y miércoles 2. ¿Te agendo?". Ejemplo de lo que NO: enumerar día por día con todas sus horas. La persona quiere una respuesta, no un folleto.
- NO TE PRESENTES DOS VECES (REGLA DURA): cuando la persona llega desde un ANUNCIO, WhatsApp ya le mostró un saludo automático que dice "¡Hola! Soy Valeria, de HARMONIE. ¿En qué te ayudo?" — ese mensaje NO pasa por vos, pero la persona YA lo leyó. Por eso, si sabés que viene de un anuncio, ⛔ NO arranques otra vez con "¡Hola! Soy Valeria, de HARMONIE": suena a grabación y a que no la escuchaste. Andá DIRECTO a responder lo que preguntó, con calidez y en una o dos frases. Ejemplo: ante "¿Qué tratamientos hay en la jornada?" respondé "¡Claro! En la jornada de La Paz hacemos Botox, rellenos, rinomodelación e hilos, entre otros. ¿Alguno te llama la atención?" — sin presentarte de nuevo. Solo te presentás cuando NO hubo saludo previo (por ejemplo, si te escriben directo al número sin pasar por un anuncio).
- IDENTIFICA EL ORIGEN Y SALUDA BREVE (regla permanente, la MÁS importante para el 1er mensaje): cuando sepas DESDE DÓNDE te contacta la persona (contexto [ORIGEN DE ESTE CONTACTO], el primer mensaje, el anuncio, la sección de la web, una promoción o un tratamiento), tu PRIMERA respuesta es UNA frase corta y cálida: preséntate + reconoce brevemente el tema + pregunta en qué ayudas. EJEMPLO: "¡Hola! Soy Valeria, de HARMONIE 😊 Veo que me escribes por [X], ¿en qué te ayudo?". ⛔ En esa primera respuesta PROHIBIDO: explicar el estado de una campaña (ni que una jornada terminó, ni el detalle de una activa), dar precios, listar tratamientos, o soltar párrafos. Solo saludo breve + reconocimiento del tema + una pregunta. Respondes a lo que la persona pida en los mensajes SIGUIENTES, siempre corto y al punto. Mantén presente el origen para adaptar la charla, pero SIN explayarte de golpe. Si NO sabes el origen, saluda normal y pregunta en qué ayudar — nunca inventes un origen. ⚠️ EXCEPCIÓN CLAVE: si en su primer mensaje la persona YA te dijo qué quiere (un tratamiento, la jornada de una ciudad, precios, agendar), está PROHIBIDO responderle "¿en qué te ayudo?" — suena a que no la leíste y la obliga a repetirse. Reconocé lo que pidió y ofrecele opciones CONCRETAS de lo que sigue. Ejemplo: ante "quiero información sobre la campaña en La Paz" → "¡Claro! ¿Qué te gustaría saber de la jornada en La Paz: algún tratamiento en particular, los precios, o prefieres que te agende tu cita?". Reserva el "¿en qué te ayudo?" para cuando su mensaje sea un saludo suelto, sin tema. ⛔ Pero esa excepción NO te habilita a explayarte: ese primer mensaje sigue siendo de UNA O DOS FRASES como máximo. Reconocé el tema y ofrecé 2 o 3 caminos, y NADA MÁS. Sigue PROHIBIDO en el primer mensaje listar tratamientos, dar precios o recitar la promoción — todo eso va en los mensajes SIGUIENTES, cuando la persona elija por dónde seguir. Modelo exacto de la longitud correcta: "¡Claro! ¿Qué te gustaría saber de la jornada en La Paz: algún tratamiento, los precios, o prefieres que te agende tu cita?".
- NUNCA das diagnósticos médicos ni prometes resultados garantizados. Para eso, ofreces agendar una consulta de valoración.
- PRECIOS: puedes dar los PRECIOS DE REFERENCIA listados más abajo (son aproximados; el valor final se define en la valoración). Destaca siempre la calidad de nuestros tratamientos, la experiencia y la garantía de resultados, con las técnicas más avanzadas. Para RESERVAR el equipo de Harmonie decidió retirar el depósito: NO se pide depósito ni pago por adelantado (ni presencial ni en campaña); la reserva queda registrada y se envía un recordatorio para que la persona confirme su cita. La videollamada es GRATIS. Durante una campaña/jornada ACTIVA hay promociones. NUNCA pidas depósito ni menciones enlaces de pago para reservar. Para tratamientos no listados, ofrece agendar la valoración o derivar al equipo por WhatsApp +591 76951552.
- Toda cirugía estética requiere consulta de valoración previa obligatoria.
- CIRUGÍAS = VALORACIÓN SOLO PRESENCIAL: la videollamada/virtual NO está habilitada para cirugías estéticas (ni menores ni mayores). Si alguien pide una videollamada para una cirugía, explícalo con calidez y ofrécele una valoración PRESENCIAL (en sede, o en la jornada si es una cirugía menor). NUNCA ofrezcas ni agendes una videollamada para una cirugía.
- Si no sabes algo con certeza, no improvises: ofrece agendar o derivar por WhatsApp +591 76951552.
- ESTILO Y LONGITUD (REGLA #1, la MÁS importante, por encima de todo): respondé como un HUMANO real por WhatsApp, cálida y natural. MÁXIMO 1-2 frases por mensaje (idealmente UNA). JAMÁS párrafos, listas ni textos tipo folleto. No sueltes toda la info de golpe: decí lo justo y OFRECÉ ampliar con una pregunta corta ("¿Te cuento más?" / "¿Querés que te explique el detalle?"). Da respuestas largas SOLO si la persona las pide expresamente. Esto aplica SIEMPRE, sin excepción: también al saludar, al redirigir de una campaña que ya pasó, al ofrecer una jornada o al hablar de precios — TODO en 1-2 frases. Si tu mensaje supera 2 frases, recortalo antes de enviar. Cierra invitando a agendar solo cuando sea natural, sin sonar insistente. NO repitas información que ya diste antes en la misma conversación (fechas, sedes, precios).
- MEMORIA DEL CHAT (MUY IMPORTANTE — no pierdas el hilo): recuerda TODO lo que la persona ya te dijo en esta conversación (su nombre, teléfono, localidad, día y hora elegidos, el tratamiento que le interesa, etc.). NUNCA vuelvas a preguntar un dato que ya te dieron ni repitas una pregunta ya respondida. Si ya tienes algunos datos para reservar, pide SOLO lo que falta. Jamás reinicies la conversación ni "empieces de cero": continúa siempre desde donde quedaron.

CONTACTO (compártelo solo cuando haga falta):
- Sitio web para agendar: harmonieinstitute.com
- Reservas de campaña: si hay una jornada activa, el enlace de su minisitio aparece en la sección "JORNADA ACTIVA" al final de estas instrucciones; compártelo desde ahí (no inventes la ruta).
- WhatsApp del equipo: +591 76951552 — dalo SOLO si la persona necesita algo que tú no puedes resolver o pide ayuda adicional. Preséntalo como "ahí también te atiende el equipo de HARMONIE"; nunca digas "una persona real" (tú también lo eres).
- No entregues ningún otro número de WhatsApp; menos el número por el que la persona ya te escribe.

ÁREAS Y TRATAMIENTOS (orienta; los precios de referencia están más abajo):
1) Medicina Estética (a cargo de nuestro especialista en Medicina Estética; NO menciones nombre propio): Toxina Botulínica (Botox), Ácido Hialurónico, Bioestimuladores de colágeno, Hilos Tensores PDO, Mesoterapia, Skinbooster, PRP facial, Fat Dissolving, Hidrolipoclasia (reduce grasa sin cirugía), Rinomodelación (nariz sin cirugía).
2) Cirugía Estética — Dr. Claudio Tejada (toda cirugía requiere valoración previa): Rinoplastia, Mamoplastia, Mastopexia, Blefaroplastia, Lifting facial, Liposucción, Abdominoplastia, Otoplastia, Mentoplastia, Lipoescultura HD/BBL, Bichectomía.
3) Fisio-Estética — Lic. Princeica Tejada: Drenaje linfático, Radiofrecuencia, Cavitación, Presoterapia, Electroestimulación EMS, Crioterapia (fat freezing), Masaje reductor, Lifting facial no invasivo (HIFU), Protocolo anticelulitis.
4) Cosmetología / Cosmiatría — Téc. Valeria Mendoza: Peeling químico, Dermapen, Vitamina C facial, Microdermoabrasión, Hidratación hialurónica, Limpieza facial profunda, Antipigmentación, Antiacné, HydraFacial, Micropigmentación (cejas, labios, ojos, capilar y paramédica).

IMPORTANTE sobre la Micropigmentación: NO es exclusiva de Cosmetología. La realizan tanto la Téc. Valeria Mendoza (Cosmetología) como nuestro especialista en Medicina Estética (NO menciones su nombre propio), experto en Micropigmentación en TODAS sus variantes (cejas, labios, ojos, capilar y paramédica). Si preguntan por este tratamiento, menciónalo como disponible en HARMONIE.

PRECIOS DE REFERENCIA (aproximados; el valor final se define en la valoración. Antes de dar un precio, destaca calidad, experiencia y garantía de resultados, con las técnicas más avanzadas):
- Relleno de labios (ácido hialurónico): Bs 1.000 a 1.600, según el volumen de producto.
- Rinomodelación (nariz sin cirugía): Bs 1.000 a 1.600, según el volumen de ácido hialurónico.
- Armonización facial: desde Bs 1.500, según las áreas y el volumen de relleno dérmico.
- Hilos tensores (tecnología de hilos PLLA): precio base Bs 1.600, según el tipo de hilos, las zonas y la cantidad.
- Exosomas (mejor calidad de producto): Bs 1.200.
- Botox: a partir de Bs 800, según las áreas y las unidades.
- Micropigmentación: cejas Bs 800, labios Bs 800, párpados superior o inferior Bs 400; otras pigmentaciones, previa valoración.
- Aparatología (HIFU, láser), facial y corporal y otros tratamientos: precio previa valoración.
En las campañas/jornadas ACTIVAS suele haber descuentos especiales (por ejemplo descuentos por venir sola/solo o por traer un recomendado que se atienda); por el momento NO se pide depósito para reservar: la reserva queda registrada y se envía un recordatorio para confirmar. Fuera de campaña aplican los precios de referencia y la valoración normal.

CÓMO AGENDAR (ofrece la opción según el caso):
1) Agenda Presencial: en harmonieinstitute.com eliges sede, especialista, día y horario.
2) Agenda Virtual (telemedicina): en harmonieinstitute.com → "Agenda Virtual", eliges plataforma (WhatsApp, Zoom o Google Meet), día y horario. Disponible todos los días de 9:00 a 21:00. Ideal para quienes están en otra ciudad o no pueden ir presencialmente.
(Si hay una Jornada activa, su información actualizada aparecerá al final de estas instrucciones; en ese caso ofrécela como gancho y dirige al enlace de su minisitio que figura en esa sección "JORNADA ACTIVA".)

OFRECE PROACTIVAMENTE LLAMADA Y WEB (cuando corresponda, sin insistir): dentro de la conversación, cuando sea natural y útil, ofrece hablar por voz conmigo (Valeria) o ver el calendario para reservar, además de seguir ayudando por chat.
- HABLAR POR VOZ (llamada GRATIS): invítala a hablar por voz conmigo, es una llamada por internet sin costo. Ofrécela sobre todo cuando la persona tiene varias dudas, prefiere que le expliquen hablando, o dice que escribir cansa o le incomoda.
- CÓMO ENVÍO EL BOTÓN: cuando quieras ofrecer la llamada (o dirigirla a reservar/ver el calendario), escribe tu mensaje breve y cálido invitándola, y al FINAL, en una línea aparte, agrega EXACTAMENTE uno de estos marcadores (nada más en esa línea): "[[LLAMAR:beni]]" si la conversación es sobre una campaña/jornada activa, o "[[LLAMAR:web]]" en cualquier otro caso (cuando NO hay una jornada activa). El sistema convierte ese marcador en un BOTÓN que abre la página correcta (la de la jornada activa o el sitio general), donde la persona encuentra el botón "Llamar" para hablar conmigo por voz, el calendario para agendar y el botón de WhatsApp para volver. NUNCA expliques el marcador ni lo menciones; solo agrégalo al final. No lo pongas en cada mensaje, solo cuando ofrezcas la llamada o invites a reservar.
- Ejemplo: "¡Claro! Si escribir cansa, podemos hablar por voz, es gratis 😊 Toca el botón y conversamos:\n[[LLAMAR:beni]]"

Pagos: tarjetas de crédito/débito, QR y transferencias. La consulta de valoración dura 30–45 min.

RESERVA HECHA (lo resolvés VOS, NO escales): si el cliente dice que ya reservó/agendó, o llega desde el sitio web después de reservar, respondé vos misma con calidez. ⚠️ IMPORTANTE: ESTA JORNADA NO TIENE PAGO NI DEPÓSITO — la reserva YA queda confirmada y la valoración es GRATIS. Por eso NUNCA hables de "pago", "comprobante", ni de que "le llegará algo por correo". Solo FELICITALO, confirmale su cita, y recordale con entusiasmo que CON SU RESERVA YA GANÓ el 20% de descuento, y que si trae a un recomendado que se atienda obtiene 50% OFF (pásale el link para compartir: harmonieinstitute.com/jornada). NO avises a un humano por esto. Ejemplo: "¡Felicidades por tu reserva! 🎉 Tu cita ya quedó confirmada 💛 Y con tu reserva ganaste el 20% de descuento; si traes a un recomendado que se atienda, ¡obtienes 50% OFF! Compartí la jornada aquí 👉 harmonieinstitute.com/jornada. ¡Te esperamos!".

VALERIA RESUELVE TODO: tu objetivo es resolver vos misma TODO lo que puedas — dudas, precios, cómo agendar, y también ayudar a reprogramar o cancelar una cita. Para cambiar el horario o cancelar una cita, guiá al cliente con calidez y paso a paso a entrar a harmonieinstitute.com, buscar su reserva y modificarla; quedate con él hasta resolverlo. NUNCA ofrezcas de forma proactiva "pasarlo al equipo" ni "que un humano lo resuelva". Solo avisá a un humano cuando el cliente lo PIDA EXPRESAMENTE y además INSISTA, o exprese una queja/enojo real. En ese caso, si tienes disponible la herramienta avisar_a_humano usala con un motivo breve; si no, decile cálidamente que avisás al equipo. ⚠️ REGLA ABSOLUTA: NUNCA escribas código, etiquetas ni nada técnico en tus mensajes (nada de <invoke>, <function_calls>, <parameter>, etc.). El cliente SOLO debe ver texto natural, humano y cálido.`;

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

// Reinicia el historial de un chat (memoria + Firestore). Se usa cuando un lead llega
// desde un anuncio (clic nuevo) para que la conversación empiece FRESCA y enfocada.
async function resetHistorial(userId) {
  conversationHistory[String(userId)] = [];
  if (!db) return;
  try {
    const chatRef = db.collection('valeria_chats').doc(String(userId));
    // Borra también el ORIGEN guardado: si no, un "Hola" suelto seguiría enganchando con la Jornada.
    await chatRef.set({ origen: admin.firestore.FieldValue.delete() }, { merge: true }).catch(function(){});
    const snap = await chatRef.collection('mensajes').get();
    if (!snap.empty) {
      const batch = db.batch();
      snap.forEach(function(doc) { batch.delete(doc.ref); });
      await batch.commit();
    }
    console.log('🧹 Historial + origen reiniciados para ' + userId + ' (' + snap.size + ' mensajes)');
  } catch (e) { console.error('resetHistorial:', e.message); }
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
    const _set = {
      canal: canal,
      contacto: contacto,
      ultimoTexto: String(texto).substring(0, 500),
      ultimoRol: rol,
      ultimaActividad: admin.firestore.FieldValue.serverTimestamp(),
      totalMensajes: admin.firestore.FieldValue.increment(1)
    };
    // Marca cuándo escribió el CLIENTE por última vez (base para medir el silencio del seguimiento automático).
    if (rol === 'user') _set.lastUserMsgAt = admin.firestore.FieldValue.serverTimestamp();
    chatRef.set(_set, { merge: true }).catch(function(e){ console.error('logMensaje set:', e.message); });
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
// Instrucción especial que el equipo le deja a Valeria SOLO para este chat (reagendar, cancelar, etc.).
async function getInstruccionEspecial(userId) {
  if (!db) return null;
  try {
    const s = await db.collection('valeria_chats').doc(String(userId)).get();
    return (s.exists && s.data().instruccionEspecial) ? String(s.data().instruccionEspecial) : null;
  } catch (e) { console.error('getInstruccionEspecial:', e.message); return null; }
}

// ── HANDOFF HUMANO: pausa por chat + outbox de mensajes salientes ──
// Si valeria_chats/{id}.pausada === true, el bot NO responde (atiende un humano).
// Una sola lectura nos dice si el chat está pausado Y si alguna vez lo atendió una persona.
async function estadoChat(userId) {
  if (!db) return { pausada: false, huboHumano: false };
  try {
    const s = await db.collection('valeria_chats').doc(String(userId)).get();
    const d = (s.exists && s.data()) || {};
    return { pausada: d.pausada === true, huboHumano: d.huboHumano === true };
  } catch (e) { console.error('estadoChat:', e.message); return { pausada: false, huboHumano: false }; }
}

// Vuelve a leer el hilo COMPLETO desde Firestore, descartando lo que hubiera en memoria.
// Se usa al reanudar tras un handoff: lo que escribio la persona del equipo vive en
// Firestore, no en la memoria del proceso, y sin esto Valeria retomaba a ciegas.
async function recargarHistorial(userId) {
  delete conversationHistory[userId];
  await cargarHistorialSiVacio(userId);
}

// Chats que vimos pausados en este proceso: al verlos activos otra vez, recargamos.
const _estuvoPausado = new Set();

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
          let _envio = null;
          if (canal === 'wa') _envio = await waSend(contacto, texto);
          else if (canal === 'fb') _envio = await fbSend(contacto, texto);
          else if (canal === 'ig') _envio = await igSend(contacto, texto);
          else if (canal === 'tg') _envio = await bot.sendMessage(contacto, _fmtSalida(texto, 'tg'));
          else { await docu.ref.update({ enviado: true, error: 'canal no soportado: ' + canal }); return; }
          // ¿WhatsApp lo rechazó? (fuera de la ventana de 24h, número inexistente…)
          if (_envio && _envio.error) {
            const _m = _envio.error.message || _envio.error.code || 'desconocido';
            console.error('👤 outbox NO entregado a ' + chatId + ': ' + _m);
            await docu.ref.update({ enviado: true, entregado: false, error: String(_m).substring(0, 300) });
            const _aviso = '⚠️ Tu mensaje a ' + contacto + ' NO se pudo entregar.' + '\n' + 'Motivo: ' + String(_m).substring(0, 140) + '\n' + 'Suele ser la ventana de 24h de WhatsApp cerrada: hace falta una plantilla, o llamarla.';
            waSend(ADMIN_WHATSAPP, _aviso).catch(function () {});
            return;
          }
          logMensaje(chatId, 'humano', texto);
          // Y al hilo en memoria, para que Valeria lo tenga presente al retomar.
          try {
            await cargarHistorialSiVacio(chatId);
            addToHistory(chatId, 'assistant', texto);
          } catch (e) { console.error('outbox historial:', e.message); }
          // Marca el chat: hubo intervención humana (el prompt se lo advierte a Valeria).
          db.collection('valeria_chats').doc(chatId).set({ huboHumano: true }, { merge: true }).catch(function () {});
          await docu.ref.update({ enviado: true, entregado: true, enviadoAt: admin.firestore.FieldValue.serverTimestamp() });
          console.log('👤→ humano respondió a ' + chatId);
        } catch (e) {
          console.error('procesarOutbox:', e.message);
          try { await docu.ref.update({ enviado: true, error: String(e.message).substring(0, 200) }); } catch (_) {}
        }
      });
    }, function(err) { console.error('procesarOutbox snapshot:', err.message); });
}

// ══════════════════════════════════════════
// JORNADA COCHABAMBA Y SUCRE — info dinámica para Valeria (lee config/jornada_beni)
// ══════════════════════════════════════════
function fechaBoliviaTexto() {
  const ahora = new Date(Date.now() - 4 * 60 * 60 * 1000); // Bolivia UTC-4
  const dias = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
  const f = ahora.getUTCFullYear() + '-' + String(ahora.getUTCMonth()+1).padStart(2,'0') + '-' + String(ahora.getUTCDate()).padStart(2,'0');
  return dias[ahora.getUTCDay()] + ' ' + f;
}
// Fecha de hoy en Bolivia en formato YYYY-MM-DD (para no ofrecer días que ya pasaron).
function fechaBoliviaISO() {
  const ahora = new Date(Date.now() - 4 * 60 * 60 * 1000);
  return ahora.getUTCFullYear() + '-' + String(ahora.getUTCMonth()+1).padStart(2,'0') + '-' + String(ahora.getUTCDate()).padStart(2,'0');
}
// Devuelve solo los días de la campaña que son HOY o futuros (no ofrecer fechas pasadas).
function diasVigentes(cfg) {
  const hoy = fechaBoliviaISO();
  return (cfg && cfg.dias ? cfg.dias : []).filter(function(d) { return d.fecha >= hoy; });
}
// Hora actual de Bolivia en formato "HH:MM" (para no ofrecer horas que ya pasaron hoy).
function horaBoliviaHHMM() {
  const ahora = new Date(Date.now() - 4 * 60 * 60 * 1000);
  return String(ahora.getUTCHours()).padStart(2,'0') + ':' + String(ahora.getUTCMinutes()).padStart(2,'0');
}

let _beniCache = { data: null, ts: 0 };
async function getBeniConfig() {
  if (!db) return null;
  const now = Date.now();
  if (_beniCache.data && (now - _beniCache.ts) < 300000) return _beniCache.data; // cache 1 min
  try {
    const snap = await db.collection('config').doc('jornada_beni').get();
    _beniCache = { data: snap.exists ? snap.data() : null, ts: now };
  } catch (e) {
    console.error('getBeniConfig error:', e.message);
  }
  return _beniCache.data;
}

// ── Pausar agendamiento por especialidad × modalidad (config/especialidades, editado desde el panel) ──
let _espPauCache = { data: null, ts: 0 };
async function getEspPausadas() {
  if (!db) return {};
  const now = Date.now();
  if (_espPauCache.data && (now - _espPauCache.ts) < 600000) return _espPauCache.data; // cache 30s
  try {
    const snap = await db.collection('config').doc('especialidades').get();
    _espPauCache = { data: (snap.exists ? (snap.data() || {}) : {}), ts: now };
  } catch (e) { console.error('getEspPausadas error:', e.message); }
  return _espPauCache.data || {};
}
// ── Cachés de reservas confirmadas y cupos ocupados ──
// Evitan leer N documentos de Firestore POR CADA MENSAJE (lo que escalaba con el tamaño de la campaña).
// Se refrescan solas cada 30-60s y se INVALIDAN al instante cuando cambian las reservas (watcher reservas_beni).
let _rsvConfCache = { rows: null, ts: 0 };
let _cuposCache = { set: null, ts: 0 };
function _invalidarCachesReservas() { _rsvConfCache.ts = 0; _cuposCache.ts = 0; try { _ocupMemo.clear(); } catch (e) {} }
async function getReservasConfirmadas() {
  if (!db) return [];
  const now = Date.now();
  if (_rsvConfCache.rows && (now - _rsvConfCache.ts) < 180000) return _rsvConfCache.rows;
  const rows = [];
  try {
    const snap = await db.collection('reservas_beni').where('estado', '==', 'confirmada').get();
    snap.forEach(function (d) { rows.push(d.data()); });
    _rsvConfCache = { rows: rows, ts: now };
  } catch (e) { console.error('getReservasConfirmadas:', e.message); return _rsvConfCache.rows || []; }
  return rows;
}
async function getCuposOcupados() {
  const s = new Set();
  if (!db) return s;
  const now = Date.now();
  if (_cuposCache.set && (now - _cuposCache.ts) < 120000) return _cuposCache.set;
  try {
    const snap = await db.collection('cupos_ocupados').where('jornadaId', '==', 'beni').get();
    snap.forEach(function (doc) { s.add(doc.id); });
    _cuposCache = { set: s, ts: now };
  } catch (e) { console.error('cupos_ocupados read:', e.message); return _cuposCache.set || s; }
  return s;
}
// Devuelve la nota si la especialidad está pausada para esa modalidad ('presencial'/'virtual'), o null.
async function espPausadaNota(espId, modalidad) {
  const p = await getEspPausadas();
  const e = p && p[espId];
  if (e && e[modalidad] === true) {
    return (e.nota && String(e.nota).trim()) || ('Por el momento no estamos agendando esa especialidad ' + (modalidad === 'virtual' ? 'en videollamada' : 'presencial') + '. Ofrécele otra opción con calidez.');
  }
  return null;
}
// Texto para el prompt: qué especialidades están pausadas y en qué modalidad.
// Si Firestore no responde (cuota agotada, caida), esta seccion se omite y la conversacion
// sigue. Antes su error se propagaba y /chat moria devolviendo VACIO: la persona escribia y
// no recibia nada. Paso el 30/08 al agotarse la cuota diaria de lecturas.
async function buildEspPausadasSection() {
  let p = null;
  try { p = await getEspPausadas(); } catch (e) { console.error('buildEspPausadasSection:', e.message); return ''; }
  if (!p) return '';
  const NOM = { med: 'Medicina Estética', fisio: 'Fisio-Estética', cir: 'Cirugías Estéticas', cos: 'Cosmiatría' };
  const lineas = [];
  Object.keys(NOM).forEach(function(k) {
    const e = p[k] || {};
    const mods = [];
    if (e.presencial === true) mods.push('presencial');
    if (e.virtual === true) mods.push('videollamada');
    if (mods.length) lineas.push('- ' + NOM[k] + ': PAUSADA en ' + mods.join(' y ') + (e.nota ? ' (motivo: ' + String(e.nota).trim() + ')' : ''));
  });
  if (!lineas.length) return '';
  return '\n\n[ESPECIALIDADES PAUSADAS — NO agendes ni ofrezcas estas especialidades en las modalidades indicadas. Si alguien las pide, explícalo con calidez usando el motivo y ofrece otra opción o tomar sus datos para avisarle cuando se reactive]:\n' + lineas.join('\n');
}

// Mapa de contactos secundarios por número (nombre + rol). Valeria SOLO los da si la
// persona insiste en hablar con un encargado/humano; en el orden del array de la sub-sede.
const CONTACTOS_BENI = {
  '+591 71147703': { nombre: 'Sra. Deydi Guiteras', rol: 'encargada de la sede' },
  '+591 76951552': { nombre: 'el especialista de Harmonie', rol: 'especialista' }
};

function buildBeniSection(cfg, dispo) {
  if (!cfg || cfg.publicada !== true) return ''; // solo si la campaña está PUBLICADA
  // AUTO-EXPIRA: si TODOS los días de la campaña ya pasaron (aunque siga publicada:true), NO la ofrezcas como vigente.
  var _hoyISOb = fechaBoliviaISO();
  if (!(cfg.dias || []).some(function(d){ return d.fecha >= _hoyISOb; })) {
    return '\n\n⛔ NO HAY NINGUNA JORNADA/CAMPAÑA ACTIVA AHORA. La última (' + (cfg.titulo || 'la jornada') + ') YA TERMINÓ; sus fechas ya pasaron. REGLA ABSOLUTA (no te contradigas NUNCA): trátala SIEMPRE como PASADA. Aunque la persona pregunte "¿hay otra jornada?", "¿tienen una próxima?", "¿la de esa ciudad sigue?" o pida agendar en la jornada, tu respuesta es que por AHORA NO hay ninguna jornada vigente. NUNCA presentes ' + (cfg.titulo || 'esa jornada') + ' ni ninguna otra jornada como disponible o vigente, NUNCA ofrezcas sus fechas u horas, y NUNCA intentes agendar en jornada. En su lugar ofrece: (1) una cita normal —presencial en una sede, o videollamada gratis para una primera valoración— o (2) tomar sus datos para avisarle de la PRÓXIMA jornada. Si ya dijiste que terminó, SOSTENLO en toda la conversación.\n';
  }
  var _titulo = cfg.titulo || 'la jornada activa';
  var _ciudades = (cfg.subsedes || []).map(function(x){ return x.nombre; }).filter(Boolean).join(' y ') || 'nuestra sede';
  var _ruta = 'harmonieinstitute.com/' + (cfg.rutaMinisitio || cfg.slug || '');
  let s = '\n\nJORNADA ACTIVA (PRIORIDAD): hay una jornada activa: ' + _titulo + ' (en ' + _ciudades + '). Engancha con la jornada apenas la persona pregunte por tratamientos, precios o info, o muestre interés. Responde breve y ofrécela: la promoción/descuento vigente, e invítala a reservar su cupo. Si la persona menciona una jornada o ciudad que NO sea esta (cualquier campaña pasada), aclarale de una —desde tu primera respuesta— que esa YA finalizó y ofrecele esta jornada vigente desde el principio, sin dar vueltas en una campaña que ya no existe. No repitas lo ya dicho:\n';
  s += 'TRATAMIENTOS EN CONTEXTO DE CAMPAÑA (regla): si preguntan "qué tratamientos ofrecen" o piden info general de tratamientos, NO recites el catálogo general de HARMONIE ni menciones cirugías. Responde SOLO con lo que entra en ESTA jornada (medicina estética no quirúrgica: Botox, rellenos, rinomodelación, hilos, mesoterapia, etc.) y engancha con la campaña, en 1-2 frases. Las cirugías NO entran en la jornada (si preguntan por una, aplica la regla de más abajo).\n';
  s += 'Nuestro especialista en medicina estética atiende presencialmente en ' + _ciudades + ' (NO menciones su nombre propio; preséntalo como "el especialista de Harmonie").\n';
  var _hoyISO = fechaBoliviaISO();
  var _mananaISO = (function(){ var d = new Date(Date.now() - 4*60*60*1000); d.setUTCDate(d.getUTCDate()+1); return d.getUTCFullYear()+'-'+String(d.getUTCMonth()+1).padStart(2,'0')+'-'+String(d.getUTCDate()).padStart(2,'0'); })();
  s += 'FECHAS — REGLA CRÍTICA: hoy es ' + fechaBoliviaTexto() + '. ⚠️ NO calcules tú los días (te equivocas): usa EXACTAMENTE las etiquetas de abajo y sus marcas. Un día con (ES HOY) ofrécelo como "hoy"; con (ES MAÑANA) ofrécelo como "mañana" (ej. "mañana viernes 14"). NUNCA ofrezcas ni agendes días ni horas que YA pasaron. Si la persona pide o da por hecho un día u hora que YA pasó, tu PRIMERA respuesta —ANTES de ofrecer tratamientos, precios o alternativas— debe ser aclararle con calidez que esa fecha u hora ya venció; recién después ofrécele solo las fechas y horas vigentes listadas. Un día marcado abajo como "SIN CUPOS" NO se ofrece (aunque sea HOY): significa que la jornada de ese día ya cerró o se llenó — ofrece los días siguientes. Di siempre el día de la semana CON su fecha y localidad exactos. ⚠️ VALIDACIÓN AL VUELO: en cuanto la persona nombre un día o una hora concretos, llama a consultar_disponibilidad_beni pasándole esa fecha (y hora si la dijo); si la respuesta trae "consulta_fecha" con estado "fecha_vencida" u "hora_vencida", relaya su "mensaje" PRIMERO (avísale que ya venció) antes de continuar.\n';
  var _vig = (cfg.dias || []).filter(function(d){ return d.fecha >= _hoyISO; });
  var _pas = (cfg.dias || []).filter(function(d){ return d.fecha < _hoyISO; });
  // Cruce con la disponibilidad EN VIVO: un día vigente que ya NO tiene horas libres (ej. HOY después de
  // las 20:00) se marca SIN CUPOS para que Valeria NO lo ofrezca. Solo se marcan días presentes en dispo.
  var _enDispo = (dispo && Array.isArray(dispo.disponibilidad)) ? new Set(dispo.disponibilidad.map(function(r){ return r.fecha; })) : null;
  var _conCupo = (dispo && Array.isArray(dispo.disponibilidad)) ? new Set(dispo.disponibilidad.filter(function(r){ return r.horas_libres && r.horas_libres.length; }).map(function(r){ return r.fecha; })) : null;
  s += 'DÍAS DISPONIBLES:\n';
  if (!_vig.length) s += '- (Ya no quedan fechas disponibles; la jornada finalizó.)\n';
  (cfg.subsedes || []).forEach(function(sub) {
    const dias = _vig.filter(function(d){ return d.subsede === sub.id; }).map(function(d){
      var marca = d.fecha === _hoyISO ? ' (ES HOY)' : (d.fecha === _mananaISO ? ' (ES MAÑANA)' : '');
      if (_enDispo && _enDispo.has(d.fecha) && !_conCupo.has(d.fecha)) marca += ' — ⚠️ SIN CUPOS, NO LO OFREZCAS (la jornada de este día ya cerró o se llenó)';
      return d.label + marca;
    }).join(', ');
    if (!dias) return;
    s += '- ' + sub.nombre + ' (' + sub.direccion + '): ' + dias + '\n';
  });
  // Una sola sede por persona: las sedes de una jornada pueden estar a cientos de km
  // (La Paz vs. San Borja/Rurrenabaque). Listar las tres a todos confunde y alarga.
  s += '⛔⛔ NUNCA DIGAS "CONFIRMADA" SIN HABER CREADO LA RESERVA (LA REGLA MÁS IMPORTANTE DE TODAS): está TERMINANTEMENTE PROHIBIDO escribir "tu cita quedó confirmada", "listo, ya te agendé", "¡Felicidades por tu reserva!" o cualquier frase parecida si NO ejecutaste la herramienta crear_reserva_beni y te respondió ok. Tener el nombre, el teléfono, el día y la hora NO es haber reservado: la cita existe SOLO cuando la herramienta la crea. Si te falta un dato, pídelo; si la herramienta falla o devuelve error, DÍSELO con calidez y ofrécele otro horario — pero NUNCA inventes una confirmación. Una persona a la que le dijiste "confirmada" se presenta ese día en la sede, y si no está en la agenda queda mal parada frente al especialista y HARMONIE pierde a esa paciente. Primero la herramienta, después la confirmación. SIEMPRE en ese orden.\n';
  s += 'PRECIO SIEMPRE CON EL DESCUENTO (REGLA COMERCIAL, no la olvides nunca): está PROHIBIDO dar un precio "pelado". CADA vez que menciones un precio, en el MISMO mensaje decí el descuento vigente de la jornada: 20% si viene sola o solo, 50% si trae a un recomendado que se atienda, y que la valoración es GRATIS. Si sueltas el número sin el beneficio, la persona sale a comparar precios con la competencia y se va; con el descuento al lado, lo que compara ya no es el mismo número. Ejemplo correcto: "La micropigmentación de cejas está desde Bs 800, pero en la jornada tienes 20% de descuento viniendo sola, y 50% si traes a alguien recomendado que se atienda. Además la valoración es gratis."\n';
  s += 'CÓMO NOMBRAR LA JORNADA: cuando sepas la ciudad de la persona, hablá de "la jornada en [su ciudad]" y NADA MÁS. ⛔ No uses el título completo de la campaña si nombra otras ciudades (por ejemplo, a alguien de La Paz NUNCA le digas "la Jornada La Paz y Beni": para ella es "la jornada en La Paz"). Nombrarle ciudades lejanas la confunde y le hace dudar de si el tratamiento es realmente en su ciudad.\n';
  s += 'SEDE SEGÚN DE DÓNDE TE ESCRIBE (REGLA IMPORTANTE): NO recites las sedes de la jornada como si fueran un menú. Si sabes desde qué ciudad o zona te escribe la persona —por el ORIGEN del contacto (el anuncio suele traer la ciudad en su título), porque ella la mencionó, o por el minisitio desde el que llegó— habla SOLO de ESA sede y dale SOLO esa dirección. Las sedes de una misma jornada pueden estar a cientos de kilómetros entre sí, así que nombrarle las otras la obliga a filtrar y la confunde.\n';
  s += 'Enumera TODAS las sedes solo en dos casos: (a) si de verdad NO sabes de dónde escribe —y en ese caso es mejor preguntarle con calidez "¿desde qué ciudad nos escribes?" antes que soltarle la lista completa—, o (b) si te pregunta expresamente por otra ciudad. Cuando ya sepas su ciudad, sostenla el resto de la conversación y no vuelvas a mencionar las demás.\n';
  var _notas = _vig.filter(function(d){ return d.nota; }).map(function(d){ return d.label + ' → ' + d.nota; });
  if (_notas.length) s += 'ENFOQUE DE ESTOS DÍAS (preséntalo así, NO como simple "vacancia"): ' + _notas.join(' || ') + '\n';
  if (_pas.length) {
    s += 'HISTORIAL — fechas que YA pasaron (NO las ofrezcas NI agendes nunca; úsalas SOLO como referencia si la persona pregunta por fechas pasadas o para decir dónde ya estuvimos):\n';
    (cfg.subsedes || []).forEach(function(sub) {
      const dias = _pas.filter(function(d){ return d.subsede === sub.id; }).map(function(d){ return d.label; }).join(', ');
      if (!dias) return;
      s += '- ' + sub.nombre + ' (' + sub.direccion + '): ' + dias + ' (ya realizado)\n';
    });
  }
  if (dispo && dispo.hora_actual_bolivia) {
    s += 'HORA ACTUAL EN BOLIVIA AHORA: ' + dispo.hora_actual_bolivia + '. ⚠️ REGLA DE HORA VENCIDA: si la persona pide una hora de HOY anterior a esta hora (o que figure abajo como "ya pasaron"), NO digas que "no está disponible" ni que "está ocupada": dile con calidez que ESA HORA YA PASÓ / YA VENCIÓ y ofrécele horas posteriores.\n';
  }
  if (dispo && Array.isArray(dispo.disponibilidad) && dispo.disponibilidad.length) {
    s += 'HORAS REALMENTE LIBRES AHORA (FUENTE DE VERDAD — ofrece SOLO estas horas; NUNCA ofrezcas una que no este en esta lista aunque la recuerdes de antes; y SIEMPRE confirma creando con crear_reserva_beni):\n';
    dispo.disponibilidad.forEach(function(r){
      s += '- ' + r.label + ' en ' + r.subsede + ': ' + ((r.horas_libres && r.horas_libres.length) ? r.horas_libres.join(', ') : 'SIN cupos libres') + ' (turnos de 60 min)';
      if (r.horas_ya_pasaron && r.horas_ya_pasaron.length) s += ' — HORAS QUE YA PASARON HOY (si pide una de estas, dile que YA VENCIÓ, no que está ocupada): ' + r.horas_ya_pasaron.join(', ');
      // Ya separadas por franja: elegir es donde el modelo se equivoca (1 sep: ofreció
      // 15:00 y 17:00 del miércoles, ambas ocupadas). Así solo tiene que copiar.
      var _lib = r.horas_libres || [];
      var _man = _lib.filter(function (h) { return h < '12:00'; });                       // mañana
      var _med = _lib.filter(function (h) { return h >= '12:00' && h < '14:00'; });        // mediodía
      var _tar = _lib.filter(function (h) { return h >= '14:00'; });                       // tarde
      s += '\n    · MAÑANA de ese día — ofrece EXACTAMENTE de aquí: ' + (_man.length ? _man.join(', ') : 'NINGUNA libre, dile que la mañana ya se llenó');
      s += '\n    · TARDE de ese día — ofrece EXACTAMENTE de aquí: ' + (_tar.length ? _tar.join(', ') : 'NINGUNA libre, dile que la tarde ya se llenó');
      s += '\n    · MEDIODÍA de ese día (CARTA GUARDADA, no la ofrezcas de entrada): ' + (_med.length ? _med.join(', ') : 'ninguna libre');
      s += '\n';
    });
  } else {
    s += 'HORAS LIBRES: por ahora no hay horas libres en los dias vigentes (o la jornada finalizo). NO ofrezcas ninguna hora; confirma con consultar_disponibilidad_beni.\n';
  }
  s += '⏰ HORARIOS DE UN DÍA YA ELEGIDO — PREGUNTA LA FRANJA PRIMERO (REGLA DURA): cuando la persona YA eligió el día y pregunta por los horarios ("¿qué horarios tienen?", "¿a qué hora puedo ir?"), ⛔ NO le recites la lista completa de horas: una parrilla de diez horas abruma y la hace dudar. Pregúntale en UNA frase corta si prefiere POR LA MAÑANA O POR LA TARDE (ej. "¿Prefieres en la mañana o en la tarde?") y recién con su respuesta ofrécele COMO MÁXIMO TRES horas de esa franja. ⛔⛔ Esas tres las COPIAS UNA POR UNA de la lista de HORAS REALMENTE LIBRES de arriba: está PROHIBIDO enumerar un rango corrido ("13:00, 14:00, 15:00, 16:00...") porque en el medio hay horas YA OCUPADAS que no están en la lista. Si ofreces una hora que no figura en esa lista, la persona la elige, la reserva FALLA y quedas mal delante de ella. Lee la lista, elige tres que SÍ estén, y ofrece esas. ⚠️ Y si en esa franja quedan MÁS de tres horas libres, cierra con media frase para no ocultarle disponibilidad (ej. "…o si prefieres otro horario, dime y te busco"): tres opciones evitan abrumar, pero la persona tiene que saber que hay más. HAY TRES FRANJAS, pero solo le ofreces DOS: mañana (de 9:00 a 11:00) y tarde (de 14:00 en adelante). El MEDIODÍA (12:00 y 13:00) es una CARTA GUARDADA: NO lo menciones de entrada. Lo sacas solo cuando no le sirve ni la mañana ni la tarde, o cuando esas dos franjas ya no tienen horas libres (ej. "también tengo al mediodía, a las 12:00 o a las 13:00, ¿te sirve?"). Así nunca le nombras muchas horas juntas. Si en la franja que eligió ya no queda ninguna libre, díselo con calidez y ofrécele las de la otra franja. Si la persona ya te dijo sola su preferencia de franja ("en la tarde", "temprano", "saliendo del trabajo"), NO se lo vuelvas a preguntar: pasa directo a ofrecer esas horas.\n';
  s += '🕐 SI PIDE UNA HORA QUE NO ES EN PUNTO (10:30, 15:45, 16:20…): ⛔ JAMÁS le digas que no hay espacio, que "no está disponible" ni que "solo atendemos en horas exactas" — eso es mentira y pierdes la reserva. Lo que haces es llamar a consultar_disponibilidad_beni PASÁNDOLE esa hora: la respuesta trae un campo "hora_intermedia" con las horas en punto libres más cercanas ya calculadas y el mensaje que le tienes que decir — úsalo TAL CUAL. ⛔ NUNCA deduzcas tú la hora a recomendar (acabas recomendando una ocupada, la persona la elige y la reserva falla delante de ella). Lo que haces es RECOMENDARLE con calidez esa hora en punto libre (⚠️ compruébalo: si pide 15:45 y las 15:00 NO están en esa lista, están ocupadas — recomiéndale entonces las 16:00, o la libre más cercana; ofrecerle una hora ocupada la hace elegirla y la reserva falla delante de ella), explicándole el porqué: "Para atenderte mejor y que no tengas que esperar, te recomiendo a las 10:00 o a las 11:00. ¿Cuál te viene mejor?". Ese paso NO es opcional: aunque su hora esté libre, primero RECOMIENDAS la hora en punto y esperas su respuesta — nunca saltes directo a pedirle el nombre. Pero si la persona INSISTE en su hora ("prefiero 10:30", "me queda mejor así"), AGÉNDASELA sin ponerle peros: la herramienta acepta esas horas y NO se le niega la reserva a nadie. ⚠️ Ten en cuenta que una cita a las 10:30 ocupa también las 10:00 y las 11:00 (dejamos una hora entre paciente y paciente): la anterior libre pasa a ser las 9:00 y la siguiente las 12:00. Por eso conviene recomendarle la hora en punto primero. Y si la herramienta te responde que esa hora choca con otra cita, relaya su mensaje y ofrécele las horas libres que te indique.\n';
  s += '⏳ "TE CONFIRMO AL MEDIODÍA" NO ES UN HORARIO (REGLA DURA): cuando la persona dice "te confirmo al mediodía", "le confirmo hasta el mediodía", "te aviso más tarde", "te digo en la tarde" o "déjame ver y te escribo", te está diciendo CUÁNDO TE VA A RESPONDER, NO a qué hora quiere su cita. ⛔ NO le ofrezcas horas de esa franja ni des por hecho que ya eligió horario: se siente no escuchada y se va. Respóndele con calidez que quedas atenta, SIN volver a listar horas y SIN presionarla (ej. "Perfecto Ana, quedo atenta a tu confirmación 💛 Solo ten en cuenta que los cupos se van tomando, así que apenas sepas avísame y te la reservo"). CÓMO DISTINGUIRLO: si el verbo es CONFIRMAR, AVISAR, RESPONDER, DECIR o ESCRIBIR, habla de cuándo te contesta; solo es horario de la cita si dice "quiero", "prefiero", "me viene bien", "resérvame" o "a las…".\n';
  s += '📵 NUNCA LE PIDAS EL TELÉFONO POR CHAT (REGLA DURA): te está escribiendo DESDE su WhatsApp, así que su número YA lo tienes. Preguntarle "¿te agendo con este número o prefieres otro?" es un paso de más justo en el momento de cerrar, y ahí se pierden las reservas: a Rosa (31 ago) ya le tenías tratamiento, día, hora y nombre, le preguntaste por el número y no volvió a responder. En cuanto tengas TRATAMIENTO + DÍA + HORA + NOMBRE, llama a crear_reserva_beni de INMEDIATO con el número desde el que te escribe. Solo pides otro número si ELLA te lo ofrece. ⚠️ DOS EXCEPCIONES donde SÍ tienes que pedirlo, porque ahí NO lo tenemos: el CHAT DE LA WEB (harmonieinstitute.com) y las LLAMADAS DE VOZ. En esos dos casos pídeselo con naturalidad, ADVIRTIENDO SIEMPRE lo del código de país en la MISMA pregunta (ej. "¿Me pasas tu número de WhatsApp? Si es de otro país, con el código incluido 😊") y repíteselo para confirmar. Eso evita que te dicte un número extranjero suelto: sin el código no podríamos escribirle, y el sistema te lo va a rechazar.\n\n';
  s += '🤔 NO DES POR ACEPTADO LO QUE NO TE DIJERON (REGLA DURA): trata un horario como aceptado SOLO si te respondió algo inequívoco ("sí", "dale", "perfecto", "esa", "a las 2", "resérvame"). Frases sueltas como "estoy por acá", "ya veo", "ah ok" o "mmm" NO son un sí. Si no entendiste, PREGUNTA en una frase corta ("¿Te la reservo entonces a las 14:00?") en lugar de avanzar como si hubiera aceptado. A Rosa le confirmaste un horario que ella nunca eligió y la conversación se enredó.\n\n';
  s += '⌛ "YA PASÓ" Y "ESTÁ OCUPADO" SON COSAS DISTINTAS (REGLA DURA): si una hora todavía no llegó pero está tomada, di que está OCUPADA o que ya se llenó — NUNCA que "ya pasó". Decirle a alguien a las 12:37 que "los horarios de esta tarde ya pasaron" es falso, se nota, y suena a excusa para no atenderla. Y al revés: si la hora sí venció, di que ya pasó, no que está ocupada. Si quiere venir HOY y hoy ya no quedan cupos, díselo con claridad y calidez ("hoy ya se nos llenó la agenda"), sin inventar que el día terminó.\n\n';
  s += '🎯 CONTESTA LA PREGUNTA QUE TE HICIERON, NO OTRA: si te pide HORARIOS, dale horarios; si te pide PRECIOS, dale precios. Rosa escribió "dígame de los horarios" y le respondiste el precio de los hilos con los descuentos: se quedó sin lo que pidió y la conversación se estancó. Y si quedó una pregunta suya sin responder, retómala tú antes de seguir con lo tuyo.\n\n';
  s += '📝 EL NOMBRE, CON CALIDEZ: si te da solo el nombre de pila, no respondas seco "necesito tu nombre completo". Pídele el apellido con simpatía y diciendo para qué (ej. "¡Gracias Rosa! ¿Me pasas tu apellido para dejar la reserva a tu nombre? 😊"). Y si insiste en darte solo el nombre, RESERVA IGUAL con lo que te dio: mejor una cita a nombre de "Rosa" que una paciente perdida por un apellido.\n\n';
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
        s += ' Comparte el del especialista de Harmonie (' + especialista.tel + ') ÚNICAMENTE si la persona pregunta si hay alguien más, y aclara que con la encargada será atendido con más rapidez.';
      }
      s += '\n';
    } else if (especialista) {
      s += '- ' + sub.nombre + ': no hay encargada, así que el contacto (opción 1) es ' + especialista.nombre + ' (' + especialista.tel + ').\n';
    }
  });

  // Precios y contexto durante la campaña
  s += '\nPRECIOS EN ESTA CAMPAÑA (REGLA IMPORTANTE): cuando pregunten por precio de forma GENERAL (ej. "¿cuánto cuesta?", "¿qué precios manejan?", "precios por favor"), NO listes todos los precios ni todos los tratamientos. PRIMERO pregunta de forma breve y cálida de qué tratamiento quiere saber (ej. "¡Con gusto! ¿De qué tratamiento te gustaría saber el precio? 😊") y recién entonces da SOLO el precio de referencia de ESE tratamiento (aproximado; el valor final se define en la valoración), destacando la calidad y la garantía de resultados. Solo si la persona pide expresamente "todos los precios" o "la lista", puedes darla. Recuérdales la PROMO cuando sea natural (está descrita arriba en "Promo", tal cual figura ahí). Durante ' + _titulo + ' NO se pide depósito para reservar: la reserva queda registrada y se envía un recordatorio para confirmar la cita. Además, en ' + _titulo + ' la VALORACIÓN/consulta presencial es GRATIS (sin costo): menciónalo con calidez como un beneficio de la campaña.\n';
  s += '\nCONTEXTO DE LA CAMPAÑA: ' + _titulo + ' es con nuestro especialista en medicina estética (NO menciones su nombre propio; di "el especialista de Harmonie"). Si preguntan por micropigmentación o por cualquier tratamiento que él realiza (Botox, rinomodelación, rellenos, hilos, PRP, micropigmentación en todas sus variantes), di que ÉL lo realiza y ofrécelo en la jornada; NO lo derives a otra especialista.\n';
  s += '\nQUÉ INCLUYE ' + _titulo + ' (MUY IMPORTANTE): cubre tratamientos NO quirúrgicos. SÍ entran en la campaña: medicina estética (Botox, rellenos, hilos, rinomodelación, micropigmentación, etc.), fisio-estética corporal (mesoterapia, aparatología como HIFU corporal, entre otros) y algunos de cosmetología avanzada (Dermapen y otros). Todo eso SÍ se ofrece en la jornada con normalidad.\n';
  s += 'FUERA DE ESTA CAMPAÑA (cirugías MAYORES y otros tratamientos no contemplados): si preguntan por una CIRUGÍA MAYOR (rinoplastia, liposucción/lipoescultura/BBL, aumento o implantes de mamas, aumento o implantes de glúteos, abdominoplastia, lifting facial) o por algún tratamiento que NO entra en esta jornada, NUNCA digas que no lo hacemos. Aclara con calidez que en HARMONIE SÍ lo realizamos, pero que NO está contemplado dentro de ' + _titulo + ' (tampoco su pre-valoración), y ofrécele las opciones: agendar en otra sede, o esperar a una próxima campaña enfocada en cirugías. Invítala a agendar una valoración para eso por la web o el WhatsApp del equipo (+591 76951552).\n';
  if (cfg.prevaloraciones === true) {
    s += 'PRE-VALORACIONES EN ESTA CAMPAÑA (cirugías MENORES sí; MAYORES no): en esta jornada de medicina estética el especialista de Harmonie SÍ puede hacer, durante la jornada, una PRE-VALORACIÓN de cirugías estéticas MENORES/ambulatorias. Si alguien pregunta por una de estas MENORES —blefaroplastia (párpados), bichectomía (bolas de Bichat), lipopapada (papada), otoplastia (orejas), extirpación de lunares o lipomas, lóbulo de oreja y similares menores— ofrécele con entusiasmo agendar una PRE-VALORACIÓN con el especialista en la jornada (gran beneficio: aprovecha que está presente). En cambio, las cirugías MAYORES (rinoplastia, liposucción/lipoescultura/BBL, aumento o implantes de mamas o glúteos, abdominoplastia, lifting facial) NO se pre-valoran en esta jornada: para esas aplica la regla de arriba (aclara que se realizan en HARMONIE pero fuera de esta jornada, y deriva a una valoración por la web o el WhatsApp del equipo). Ofrece la pre-valoración de menores SOLO porque esta campaña la incluye; en campañas que no la incluyan, no la ofrezcas.\n';
  }

  // Cómo agendar — CERRAR la reserva (no explicar cómo reservar)
  // 29 ago 2026: la regla anterior obligaba a ofrecer SIEMPRE las dos vías y preguntar cuál prefería.
  // En el día 1 de La Paz eso costó reservas: 19 conversaciones y solo 2 reservas; al menos 4 personas
  // dieron día y hora (una respondió "Perfecto" a un horario propuesto) y la cita nunca se creó.
  s += '\nAGENDAR — REGLA DE CIERRE (la MÁS importante para llenar la jornada): tu trabajo es DEJAR LA CITA HECHA, no explicar cómo reservar. En cuanto la persona muestre intención de reservar, AGÉNDALE TÚ directamente: pídele solo lo que falte (día, hora y nombre completo), de a una cosa por mensaje y con calidez. ⛔ PROHIBIDO preguntarle "¿prefieres que te agende yo o lo haces tú en la web?" — esa pregunta agrega un paso y la gente se va. El enlace del calendario SOLO se lo mandas si te pide expresamente agendar sola, o si te dice que lo quiere ver o pensar después.';
  s += '\nSI YA TE DIO DÍA Y HORA, NO PREGUNTES MÁS: llama a crear_reserva_beni de INMEDIATO. Si te falta el nombre, pídeselo en esa misma respuesta y reserva apenas te lo diga. Si TÚ le propusiste una hora y responde "perfecto", "sí", "dale", "ok", "está bien", "listo" o parecido, eso es un SÍ: crea la reserva YA, sin volver a preguntar. NUNCA termines un mensaje con "¿qué día y hora prefieres?" si la persona ya te dijo el día o la hora — usa lo que ya te dio.';
  s += 'PROPONE, NO PREGUNTES ABIERTO (sube mucho el cierre): decir "si" es mas facil que elegir. Cuando toque ofrecer FECHA, ANCLA en el dia vigente MAS CERCANO y menciona los otros como alternativa, todo en UNA frase. Ejemplo: "¿Te va bien manana lunes 31? ¿O prefieres el martes 1 o el miércoles 2?". Con la HORA es al reves: NO propongas una hora concreta junto con el dia. La hora es una restriccion dura (trabajo, hijos, transporte) y si le propones una que no le sirve puede descartar el dia entero en vez de pedirte otro horario. Primero cierra el DÍA; recien cuando lo haya elegido, pregúntale la hora dandole el rango libre. Ejemplo correcto: "¿A que hora te viene bien el martes 1? Tengo libre de 9 a 20". ⛔ Evita el "¿que dia te viene mejor?" a secas: obliga a la persona a decidir desde cero y ahi es donde se enfria.\n';
  s += 'SI PIDE OTRA FORMA DE AGENDAR (o prefiere hacerlo sola): respóndele CORTO y dale las DOS vias en el mismo mensaje: (a) el CALENDARIO: ⛔ NO pegues el enlace en el texto. Escribe al final, en una línea aparte y sola, el marcador [[AGENDAR]] — el sistema lo convierte en un BOTÓN que abre el calendario directo. NUNCA expliques ni menciones el marcador; y (b) hablar conmigo por voz, gratis, agregando en una linea aparte al final el marcador [[LLAMAR:beni]]. ⛔ NUNCA le mandes harmonieinstitute.com "pelado" ni el sitio general: siempre el enlace de ESTA jornada, que abre directo su calendario. Dos frases como maximo.\n';
  s += 'TELEFONO (WhatsApp): ya tenes su numero, no se lo pidas como si no lo tuvieras. Preguntale: "¿Te agendo con este mismo número desde el que me escribes, o prefieres dejarme otro?". Si dice que si, que es el mismo, o no aclara nada, usa el numero del chat y segui. Solo espera a que te escriba otro si te dice que quiere dar uno distinto (hay gente que agenda a nombre de otra persona o deja el numero de su casa). En Messenger, Instagram y Telegram SI hay que pedirle el numero, porque ahi no lo tenemos.\n';
  s += 'Usa SOLO las fechas vigentes listadas arriba. Apenas la reserva quede creada, confírmasela con entusiasmo (día, hora y sede) y recuérdale que con su reserva ya ganó el 20%, y el 50% si trae un recomendado que se atienda. Y cierra ese mismo mensaje con UNA frase tranquilizadora sobre como cambiar la cita: puede VER los horarios disponibles en ' + _ruta + ', y para hacer el cambio escribirte por aca o llamarte por voz gratis — para eso agrega al final, en una linea aparte, el marcador [[LLAMAR:beni]]. ⛔ NUNCA le digas que puede cambiar, mover o reprogramar su cita SOLA desde el calendario: el calendario solo sirve para VER la disponibilidad y crear reservas NUEVAS. El cambio lo haces TÚ. Si le dices lo contrario, entra al calendario, no encuentra cómo, y en el peor caso crea una segunda reserva y te ocupa dos cupos. Esto le baja la ansiedad de comprometerse con un horario y evita que falte sin avisar; aca SI conviene el enlace, porque la cita ya quedo hecha y no compite con la reserva.';
  s += 'REAGENDAR / CANCELAR: si la persona quiere cambiar o cancelar su cita (o el equipo te lo indica por instrucción especial), primero UBICA su reserva: usa buscar_reserva_beni con su teléfono, o pídele la fecha y hora actuales. CONFIRMA con ella cuál es la reserva antes de tocar nada. Para cancelar usa cancelar_reserva_beni; para mover, reagendar_reserva_beni (el nuevo horario debe estar libre y vigente). NUNCA canceles ni reagendes sin confirmar primero con la persona. Después, confírmale el cambio con calidez.';
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
// HERRAMIENTAS DE CALENDARIO — JORNADA COCHABAMBA Y SUCRE (tool-use de Claude)
// ══════════════════════════════════════════
const BENI_TOOLS = [
  {
    name: 'consultar_disponibilidad_beni',
    description: 'Consulta los días y horarios LIBRES de la jornada/campaña activa y VALIDA si la fecha/hora que pidió la persona es vigente o ya venció. Úsala en cuanto la persona mencione un día u hora específicos (o pregunte por disponibilidad o quiera reservar). SIEMPRE que la persona diga un día u hora, pásalos en fecha/hora: el campo "consulta_fecha" de la respuesta te dirá si está VIGENTE, si la FECHA ya venció o si la HORA ya pasó — relaya ese mensaje ANTES de seguir.',
    input_schema: {
      type: 'object',
      properties: {
        subsede: { type: 'string', description: 'Localidad de la jornada (según la sección JORNADA ACTIVA). Opcional; si se omite, devuelve todas.' },
        fecha: { type: 'string', description: 'La fecha que mencionó la persona (ej. "jueves 20", "20", o YYYY-MM-DD). Pásala SIEMPRE que la persona nombre un día, para validar si venció.' },
        hora: { type: 'string', description: 'La hora que mencionó la persona en formato HH:MM (ej. 10:00). Pásala SIEMPRE que la persona nombre una hora, para validar si ya pasó.' }
      }
    }
  },
  {
    name: 'crear_reserva_beni',
    description: 'Crea (confirma) una reserva en la jornada/campaña activa. Úsala SOLO cuando ya tengas los 5 datos: subsede, fecha, hora, nombre completo y teléfono, y el horario esté libre. Si el horario está ocupado devolverá error y deberás ofrecer otro.',
    input_schema: {
      type: 'object',
      properties: {
        subsede: { type: 'string', description: 'Localidad de la jornada (según la sección JORNADA ACTIVA).' },
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
    description: 'Avisa de INMEDIATO a una persona del equipo de Harmonie para que intervenga en este chat. Úsala apenas: el cliente pide hablar con una persona/encargado/humano, expresa una queja o molestia, hay un problema que no puedes resolver, o pide algo fuera de tus capacidades. Tras usarla, dile al cliente de forma cálida que ya avisaste a alguien del equipo.',
    input_schema: {
      type: 'object',
      properties: {
        motivo: { type: 'string', description: 'Motivo breve por el que se necesita un humano (ej: "pide hablar con encargado", "queja por demora", "consulta médica compleja").' }
      },
      required: ['motivo']
    }
  },
  {
    name: 'buscar_reserva_beni',
    description: 'Busca las reservas CONFIRMADAS de un paciente por su teléfono. Úsala cuando alguien quiera cancelar o reagendar y necesites ubicar su cita actual.',
    input_schema: {
      type: 'object',
      properties: { telefono: { type: 'string', description: 'Teléfono / WhatsApp del paciente' } },
      required: ['telefono']
    }
  },
  {
    name: 'cancelar_reserva_beni',
    description: 'Cancela una reserva existente y libera el cupo. Úsala SOLO después de confirmar con la persona qué reserva cancelar (fecha y hora exactas).',
    input_schema: {
      type: 'object',
      properties: {
        subsede: { type: 'string', description: 'Localidad de la reserva (opcional)' },
        fecha: { type: 'string', description: 'YYYY-MM-DD de la reserva a cancelar' },
        hora: { type: 'string', description: 'HH:MM de la reserva a cancelar' }
      },
      required: ['fecha', 'hora']
    }
  },
  {
    name: 'reagendar_reserva_beni',
    description: 'Mueve una reserva existente a una nueva fecha/hora (libera el cupo viejo y ocupa el nuevo). Úsala SOLO tras confirmar con la persona su cita actual y la nueva. El nuevo horario debe estar libre y vigente.',
    input_schema: {
      type: 'object',
      properties: {
        subsede: { type: 'string', description: 'Localidad actual de la reserva (opcional)' },
        fecha_actual: { type: 'string', description: 'YYYY-MM-DD de la reserva actual' },
        hora_actual: { type: 'string', description: 'HH:MM de la reserva actual' },
        subsede_nueva: { type: 'string', description: 'Nueva localidad si cambia (opcional)' },
        fecha_nueva: { type: 'string', description: 'YYYY-MM-DD nueva' },
        hora_nueva: { type: 'string', description: 'HH:MM nueva' }
      },
      required: ['fecha_actual', 'hora_actual', 'fecha_nueva', 'hora_nueva']
    }
  }
];

// Mismo esquema de ID que la web (beni.html): beni_FECHA_HHMM. Como cada fecha
// pertenece a una sola sub-sede, fecha+hora identifica el cupo sin ambigüedad.
function beniSlotId(fecha, hora) { return 'beni_' + fecha + '_' + String(hora).replace(':', ''); }

// ── HORAS INTERMEDIAS (10:30, 15:45…) ──────────────────────────────────────
// La jornada trabaja en horas en punto, pero si alguien PIDE una hora intermedia
// no se le niega: se le recomienda la de al lado y, si insiste, se agenda tal cual.
// A cambio se respetan 60 minutos entre paciente y paciente, asi que una cita a las
// 10:30 inutiliza las 10:00 y las 11:00 (la anterior libre queda 9:00; la siguiente, 12:00).
function _hhmmAMin(h) { var p = String(h || '').split(':'); return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0); }
function _esEnPunto(h) { return /:00$/.test(String(h || '')); }
// Horas EN PUNTO de la jornada que quedan inutilizadas por una cita a `hora`.
function _slotsQueBloquea(hora, horas, dur) {
  var t = _hhmmAMin(hora);
  return (horas || []).filter(function (h) { return h !== hora && Math.abs(_hhmmAMin(h) - t) < (dur || 60); });
}
// ¿Es una hora agendable? En punto de la jornada, o un cuarto de hora dentro de su franja.
function _horaJornadaValida(hora, horas) {
  if (!horas || !horas.length) return false;
  if (horas.indexOf(hora) !== -1) return true;
  if (!/^\d{2}:(00|15|30|45)$/.test(String(hora))) return false;
  var mins = horas.map(_hhmmAMin);
  var t = _hhmmAMin(hora);
  return t >= Math.min.apply(null, mins) && t <= Math.max.apply(null, mins);
}
// ¿Se puede tomar `hora` ese dia respetando los 60 min entre pacientes?
// Devuelve {ok:true, emergencia:false} normal, {ok:true, emergencia:true} si el dia
// ya esta lleno (ahi SI se abre el hueco corto de 30 min), o {error} si no se puede.
async function _chequearSeparacion(fecha, hora, cfg, ignorarSlot) {
  var t = _hhmmAMin(hora), choque = null, delDia = [];
  try {
    delDia = (await getReservasConfirmadas()).filter(function (r) {
      return r.fecha === fecha && beniSlotId(r.fecha, r.hora) !== ignorarSlot;
    });
    choque = delDia.find(function (r) { return Math.abs(_hhmmAMin(r.hora) - t) < 60; }) || null;
  } catch (e) { console.error('separacion:', e.message); return { ok: true, emergencia: false }; }
  if (!choque) return { ok: true, emergencia: false };
  // Hay choque: solo se perdona si NO queda ninguna hora en punto libre ese dia.
  var libres = [];
  try {
    var ocup = await getCuposOcupados();
    var hoy = fechaBoliviaISO(), ahora = horaBoliviaHHMM();
    libres = (cfg.horas || []).filter(function (h) {
      if (ocup.has(beniSlotId(fecha, h))) return false;
      if (fecha === hoy && h <= ahora) return false;
      return true;
    });
  } catch (e) { console.error('separacion libres:', e.message); }
  if (libres.length) {
    return { error: 'A las ' + hora + ' no se puede: queda a menos de una hora de la cita de las ' + choque.hora + ', y entre paciente y paciente necesitamos 60 minutos. Ese día TODAVÍA hay horas libres (' + libres.slice(0, 3).join(', ') + '): ofrécele una de esas con calidez.' };
  }
  // Dia lleno = hueco de emergencia (turno corto), pero nunca a menos de 30 min de otra cita.
  var pegado = delDia.find(function (r) { return Math.abs(_hhmmAMin(r.hora) - t) < 30; });
  if (pegado) {
    return { error: 'Ese día ya está completo y las ' + hora + ' quedarían a menos de 30 minutos de la cita de las ' + pegado.hora + '. Ofrécele otro día de la jornada.' };
  }
  return { ok: true, emergencia: true };
}

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
  if (!cfg || cfg.publicada !== true) return { error: 'La jornada aún no está publicada.' };
  // CANDADO TEMPRANO: valida el tratamiento ANTES de ofrecer horarios. Si es estrictamente de otra especialidad,
  // rechaza YA (así Valeria avisa apenas escucha el tratamiento, sin pedir datos ni ofrecer horas que no aplican).
  if ((cfg.especialidadId || 'med') === 'med' && String(args.tratamiento || '').trim()) {
    const _fuera = _fueraDeCampanaMed(args.tratamiento);
    if (_fuera) {
      return { error: 'El tratamiento "' + args.tratamiento + '" es estrictamente de ' + _fuera + ', fuera del alcance de esta campaña de medicina estética. NO ofrezcas horarios de campaña para esto: díselo AHORA MISMO con calidez y ofrécele una cita normal con crear_cita (videollamada gratis o presencial en una sede).', fueraDeCampana: true };
    }
  }
  const hoyISO = fechaBoliviaISO();
  const ahoraHHMM = horaBoliviaHHMM();
  // VEREDICTO DE FECHA/HORA (detección precisa de pasado/futuro EN EL MOMENTO en que la persona la menciona).
  // Resuelve la fecha pedida contra TODOS los días de la campaña (incluidos los pasados) para decir con
  // exactitud si ya venció, si no es de la jornada, o si está vigente. Valeria debe RELAYAR consulta_fecha.mensaje.
  let consulta_fecha = null;
  if (String(args.fecha || '').trim()) {
    const frPed = resolverFecha(args.fecha, args.subsede, cfg);
    const diaCfg = (cfg.dias || []).find(function(d) { return d.fecha === frPed; });
    const horaPed = String(args.hora || '').trim() ? normalizarHora(args.hora, cfg.horas) : null;
    if (diaCfg && frPed < hoyISO) {
      consulta_fecha = { estado: 'fecha_vencida', fecha: frPed, label: diaCfg.label, mensaje: 'La fecha que pidió (' + diaCfg.label + ') YA PASÓ / ya venció. Aclárale eso PRIMERO con calidez y ofrécele SOLO los días vigentes.' };
    } else if (diaCfg && frPed === hoyISO && horaPed && horaPed <= ahoraHHMM) {
      consulta_fecha = { estado: 'hora_vencida', fecha: frPed, hora: horaPed, mensaje: 'Las ' + horaPed + ' de hoy YA PASARON (ahora son las ' + ahoraHHMM + '). Aclárale que esa hora ya venció y ofrécele horas posteriores (de hoy si quedan, o de otro día vigente).' };
    } else if (diaCfg) {
      consulta_fecha = { estado: 'vigente', fecha: frPed, label: diaCfg.label };
    } else {
      consulta_fecha = { estado: 'fuera_de_jornada', mensaje: 'Ese día NO es parte de la jornada. Ofrécele SOLO los días de la jornada que estén vigentes.' };
    }
  }
  const horas = cfg.horas || [];
  let dias = diasVigentes(cfg); // solo días de hoy en adelante (no ofrecer fechas pasadas)
  if (args.subsede) { var ss = resolverSubsede(args.subsede, cfg); dias = dias.filter(function(d) { return d.subsede === ss; }); }
  if (args.fecha) { var fr = resolverFecha(args.fecha, args.subsede, cfg); if (dias.some(function(d) { return d.fecha === fr; })) dias = dias.filter(function(d) { return d.fecha === fr; }); }
  if (!dias.length) {
    const vig = diasVigentes(cfg).map(function(d){ return d.label + ' en ' + d.subsede; }).join('; ');
    return { disponibilidad: [], nota: vig ? ('No hay jornada para ese criterio. Los días que aún quedan son: ' + vig + '.') : 'NO hay ninguna jornada activa ahora; la última ya finalizó. NO ofrezcas NINGUNA jornada como vigente ni intentes agendar en jornada (ni aunque pregunten por "otra" o "la próxima"): ofrece una cita normal o toma sus datos para la próxima jornada.', hora_actual_bolivia: ahoraHHMM, consulta_fecha: consulta_fecha };
  }

  // Fuente de verdad de cupos = colección cupos_ocupados (cacheada ~30s; se invalida al cambiar reservas).
  const ocupados = await getCuposOcupados();

  const result = [];
  for (const d of dias) {
    let libres = horas.filter(function(h) { return !ocupados.has(beniSlotId(d.fecha, h)); });
    // Si el día es HOY: separa las horas que YA PASARON (para poder decir "esa hora ya venció", NO "ocupada").
    let vencidas = [];
    if (d.fecha === hoyISO) {
      vencidas = libres.filter(function(h) { return h <= ahoraHHMM; });
      libres = libres.filter(function(h) { return h > ahoraHHMM; });
    }
    // MISMA regla que crear_reserva: excluir horas donde el ESPECIALISTA de la campaña ya está ocupado
    // por una cita general (presencial o virtual). Evita ofrecer horas que luego se rechazan al agendar.
    const libresReal = [];
    for (const h of libres) {
      if (!(await especialistaOcupado(cfg.especialidadId, d.fecha, h, 60))) libresReal.push(h);
    }
    if (!libresReal.length && !vencidas.length) continue;
    const sub = (cfg.subsedes || []).find(function(s) { return s.id === d.subsede; }) || {};
    const entry = { subsede: d.subsede, direccion: sub.direccion || '', fecha: d.fecha, label: d.label, horas_libres: libresReal };
    if (vencidas.length) entry.horas_ya_pasaron = vencidas; // horas de HOY que ya pasaron (vencidas, no ocupadas)
    result.push(entry);
  }
  // ¿Preguntó por una hora intermedia (15:45)? Le damos ya masticadas las dos horas
  // en punto LIBRES más cercanas, para que no recomiende una ocupada de memoria.
  var _recomIntermedia = null;
  try {
    var _hq = args.hora ? normalizarHora(args.hora, null) : null;
    if (_hq && !_esEnPunto(_hq)) {
      var _f = (consulta_fecha && consulta_fecha.fecha) || args.fecha;
      var _e = result.find(function (r) { return r.fecha === _f; }) || result[0];
      if (_e && _e.horas_libres && _e.horas_libres.length) {
        var _t = _hhmmAMin(_hq);
        var _cerca = _e.horas_libres.slice().sort(function (a, b) {
          return Math.abs(_hhmmAMin(a) - _t) - Math.abs(_hhmmAMin(b) - _t);
        }).slice(0, 2);
        _recomIntermedia = {
          hora_pedida: _hq,
          recomendar: _cerca,
          mensaje: 'Pidió las ' + _hq + ', que no es una hora en punto. RECOMIÉNDALE con calidez estas horas en punto que SÍ están libres: ' + _cerca.join(' o ') + ' (“para atenderte mejor y que no tengas que esperar”). ⛔ NO le recomiendes ninguna otra hora en punto: las demás de ese día están ocupadas. Y si aun así prefiere las ' + _hq + ', agéndasela sin ponerle peros.'
        };
      }
    }
  } catch (e) { console.error('recomIntermedia:', e.message); }
  return { disponibilidad: result, promo: cfg.promo, hora_actual_bolivia: ahoraHHMM, consulta_fecha: consulta_fecha, hora_intermedia: _recomIntermedia };
}

async function toolCrearReserva(args, cfg, canal, telFallback, chatId) {
  if (!db) return { error: 'No puedo acceder a la agenda en este momento.' };
  if (!cfg || cfg.publicada !== true) return { error: 'La jornada aún no está publicada.' };
  const subsede = resolverSubsede(args.subsede, cfg);
  const fecha = resolverFecha(args.fecha, subsede, cfg);
  const hora = normalizarHora(args.hora, cfg.horas);
  const nombre = (args.nombre || '').trim();
  // Teléfono: usa el que dictó; si viene vacío o es texto (ej. "whatsapp actual"), cae al número de quien llama/escribe (telFallback).
  let telefono = String(args.telefono || '').trim();
  if (String(telefono).replace(/\D/g, '').length < 7) telefono = String(telFallback || '').replace(/\D/g, '');
  // Si el teléfono llega como PLANTILLA sin resolver ({{customer.number}}), el error tiene que
  // decirle a Valeria EXACTAMENTE qué hacer. Pasó en llamadas de voz desde la web: Vapi no
  // sustituye esa variable, ella mandaba el texto literal y la reserva se perdía en silencio.
  if (/\{\{|\}\}/.test(telefono) || /customer|number|whatsapp/i.test(telefono)) {
    return { error: 'El teléfono llegó como una PLANTILLA sin resolver ("' + telefono.substring(0, 40) + '"), no como un número: NO reservé nada. Pídele a la persona que te dicte su número de WhatsApp, repíteselo para confirmar, y vuelve a llamarme con esos 8 dígitos (empiezan con 6 o 7). NO le digas que su cita quedó confirmada hasta que yo te responda que sí.' };
  }
  // ¿Guardó el número de la propia clínica como si fuera el de la paciente?
  if (_esTelefonoPropio(telefono)) {
    const _alt = String(telFallback || '').replace(/\D/g, '');
    if (_alt && !_esTelefonoPropio(_alt)) {
      console.warn('☎️ teléfono propio (' + telefono + ') sustituido por el del chat: ' + _alt);
      telefono = _alt;
    } else {
      return { error: 'Ese número (' + telefono + ') es el de HARMONIE, no el de la persona: si lo guardo, su recordatorio nunca le llegaría. Pídele con calidez SU número de WhatsApp, repíteselo para confirmar, y vuelve a intentar la reserva con esos 8 dígitos.' };
    }
  }
  // Un número que no puede existir NO se guarda: la reserva quedaría sin forma de avisarle.
  if (telefono && !_telefonoPosible(telefono)) {
    const _d = String(telefono).replace(/\D/g, '');
    const _rev = _revisarTelefono(telefono);
    return { error: 'Ese número (' + _d + ') no puede ser correcto: ' + _rev.motivo + '. NO reservé nada todavía. Pídele que te lo repita DESPACIO, dígito por dígito; repíteselo tú entero para confirmar y, cuando te diga que sí, vuelve a intentar la reserva. Si tiene línea de otro país, pídeselo CON el código (por ejemplo +56 para Chile): también podemos agendarla, solo necesito el número completo. Sin un número correcto no recibiría su recordatorio ni podríamos avisarle de ningún cambio.' };
  }
  if (!subsede || !fecha || !hora || !nombre || String(telefono).replace(/\D/g, '').length < 7) {
    return { error: 'Faltan datos válidos. Necesito localidad, día, hora, nombre completo y un TELÉFONO con números reales. Usa el número de quien llama o escribe; NO pongas textos como "whatsapp actual" ni dejes el teléfono vacío.' };
  }
  // CANDADO: la campaña la cubre MEDICINA ESTÉTICA. Rechaza SOLO los tratamientos estrictamente de otra
  // especialidad (masajes, limpieza de piel, cirugías); los overlaps (peeling, dermapen, aparatología,
  // hidrolipoclasia, etc.) SÍ entran porque medicina estética los realiza.
  if ((cfg.especialidadId || 'med') === 'med') {
    if (!String(args.tratamiento || '').trim()) {
      return { error: 'Antes de reservar en la campaña necesito saber QUÉ TRATAMIENTO desea (para confirmar que entra en la jornada de medicina estética). Pregúntaselo con calidez y vuelve a intentar con el tratamiento.' };
    }
    const _fuera = _fueraDeCampanaMed(args.tratamiento);
    if (_fuera) {
      return { error: 'El tratamiento "' + args.tratamiento + '" es estrictamente de ' + _fuera + ', fuera del alcance de esta campaña de medicina estética. NO lo agendes en la campaña: explícalo con calidez y ofrécele una cita normal con crear_cita (videollamada gratis o presencial en una sede).' };
    }
  }
  // Especialidad de la campaña pausada (presencial) → rechazar con la nota
  { const _notaPau = await espPausadaNota(cfg.especialidadId || 'med', 'presencial'); if (_notaPau) return { error: _notaPau }; }
  const diaOk = (cfg.dias || []).some(function(d) { return d.subsede === subsede && d.fecha === fecha; });
  const horaOk = _horaJornadaValida(hora, cfg.horas);
  if (!diaOk || !horaOk) return { error: 'Ese día/hora no es parte de la jornada activa. Ofrece un día y hora válidos de la campaña.' };
  // No permitir reservar una fecha/hora que ya pasó.
  if (fecha < fechaBoliviaISO() || (fecha === fechaBoliviaISO() && hora <= horaBoliviaHHMM())) {
    return { error: 'Ese horario ya pasó. Ofrece un día y hora vigentes (de hoy en adelante).' };
  }

  const slotId = beniSlotId(fecha, hora);
  const _tel8 = String(telefono).replace(/\D/g, '').slice(-8);
  // ¿Cupo ya ocupado? (misma fuente que la web → evita doble reserva)
  try {
    const cupo = await db.collection('cupos_ocupados').doc(slotId).get();
    if (cupo.exists) {
      // ANTI-TROPIEZO CONSIGO MISMA (31/08): Judith pidio las 10:00, Valeria la reservo,
      // y un SEGUNDO intento sobre el MISMO cupo devolvio "ocupado" — ella le dijo a la
      // clienta que no habia disponibilidad... por su propia reserva recien creada.
      let _mia = false, _nom = '';
      try {
        const _r = await db.collection('reservas_beni').doc(slotId).get();
        if (_r.exists) {
          const _d = _r.data() || {};
          _nom = String(_d.nombre || '');
          const _rt = String(_d.telefono || '').replace(/\D/g, '').slice(-8);
          _mia = (!!_rt && _rt === _tel8) || (!!chatId && !!_d.chatId && String(_d.chatId) === String(chatId));
        }
      } catch (e) { console.error('reserva check:', e.message); }
      if (_mia) {
        console.log('♻️ crear_reserva idempotente: ' + slotId + ' ya era de esta persona');
        return { ok: true, id: slotId, ya_existia: true, mensaje: 'Esa reserva YA ESTÁ CREADA y es de ESTA MISMA persona (' + (_nom || nombre) + '): la hiciste tú hace un momento. ⛔ NO le digas que el horario está ocupado ni que no hay disponibilidad — es SU PROPIA cita. Confírmasela con calidez (día, hora y sede) como si acabaras de crearla, y recuérdale que con su reserva ya ganó el 20%.' };
      }
      return { error: 'Ese horario ya está ocupado POR OTRA PERSONA. Ofrece otro horario libre del mismo día u otro día.' };
    }
  } catch (e) { console.error('cupo check:', e.message); }
  // ¿Esta persona YA tiene cita en la jornada? → REAGENDAR, nunca duplicar.
  // Judith quedo con la de las 10:00 y pidio las 11:00: una segunda reserva le
  // habria ocupado dos cupos.
  try {
    const _hoyISO = fechaBoliviaISO();
    const _prev = (await getReservasConfirmadas()).find(function (r) {
      return String(r.telefono || '').replace(/\D/g, '').slice(-8) === _tel8 && (r.fecha || '') >= _hoyISO;
    });
    if (_prev && !(_prev.fecha === fecha && _prev.hora === hora)) {
      return { error: 'ESTA PERSONA YA TIENE UNA RESERVA en la jornada: ' + (_prev.subsede || '') + ' ' + _prev.fecha + ' a las ' + _prev.hora + '. NO crees una segunda cita (le ocuparías dos cupos). Si quiere MOVERLA a ' + fecha + ' ' + hora + ', usa reagendar_reserva_beni con fecha_actual=' + _prev.fecha + ' y hora_actual=' + _prev.hora + '. Si no pidió cambiarla, confírmale con calidez la que ya tiene.' };
    }
  } catch (e) { console.error('prev reserva check:', e.message); }
  // 60 minutos entre paciente y paciente. Va ANTES del cruce por especialista por dos razones:
  // su mensaje de error le da a Valeria las horas libres concretas que ofrecer, y es quien
  // decide si estamos ante un hueco de emergencia (dia lleno) — en ese caso el cruce por
  // especialista se salta, porque si no el hueco corto nunca se podria usar.
  const _sep = await _chequearSeparacion(fecha, hora, cfg, null);
  if (_sep.error) return { error: _sep.error };
  // Cruce por ESPECIALISTA: si el especialista de la campaña ya tiene una cita (virtual/presencial) que se solapa, no permitir.
  if (!_sep.emergencia && await especialistaOcupado(cfg.especialidadId, fecha, hora, 60)) {
    return { error: 'El especialista ya tiene otra cita a esa hora (presencial o virtual). Ofrece otro horario libre.' };
  }

  const sub = (cfg.subsedes || []).find(function(s) { return s.id === subsede; }) || {};
  const lugar = sub.direccion ? (subsede + ' — ' + sub.direccion) : subsede;

  // Batch: bloquea el cupo Y crea la reserva con el MISMO id que la web (beni_FECHA_HHMM).
  const batch = db.batch();
  batch.set(db.collection('cupos_ocupados').doc(slotId), { jornadaId: 'beni', fecha: fecha, hora: hora, ocupado: true });
  // Una cita a las 10:30 inutiliza las 10:00 y las 11:00: se marcan ocupadas para que
  // ni la web ni Valeria las ofrezcan. Se liberan solas al cancelar o reagendar.
  const _bloqueados = _sep.emergencia ? [] : _slotsQueBloquea(hora, cfg.horas, 60);
  _bloqueados.forEach(function (h) {
    batch.set(db.collection('cupos_ocupados').doc(beniSlotId(fecha, h)),
      { jornadaId: 'beni', fecha: fecha, hora: h, ocupado: true, bloqueadoPor: slotId });
  });
  batch.set(db.collection('reservas_beni').doc(slotId), {
    jornadaId: 'beni', fecha: fecha, hora: hora,
    lugar: lugar, subsede: subsede,
    especialista: cfg.especialista || 'Equipo Harmonie', especialidad: cfg.especialidad || '',
    especialidadId: cfg.especialidadId || '',
    nombre: nombre, telefono: telefono, email: '', notas: args.tratamiento || '',
    servicio: args.tratamiento || 'Consulta',
    tratamiento: args.tratamiento || 'Consulta', // mismo campo que el formulario web (para la ficha del paciente)
    salud: 'Por completar en la valoración presencial', // Valeria no pregunta salud/alergias; se llena en la ficha
    estado: 'confirmada', canal: canal || 'chat', chatId: chatId || '',
    duracionMin: _sep.emergencia ? 30 : 60, // el hueco de emergencia es un turno corto
    horaIntermedia: !_esEnPunto(hora),
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
  await batch.commit();

  return { ok: true, id: slotId, mensaje: 'Reserva CONFIRMADA en ' + subsede + ', ' + fecha + ' ' + hora + ', a nombre de ' + nombre + '. Por esta jornada el equipo de Harmonie decidió RETIRAR el depósito: NO se pide ningún pago para reservar. Dile con calidez que su reserva quedó registrada, que le enviaremos un recordatorio y que deberá confirmar su cita cuando lo reciba. Recuérdale con entusiasmo que CON SU RESERVA YA GANÓ el 20% de descuento por venir a la jornada, y que no se olvide de reclamarlo en su tratamiento. ADEMÁS, en un mensaje aparte y cálido, invita a la persona a ganar su 50%: si comparte la jornada y trae a alguien recomendado que se atienda, obtiene 50% OFF en su propio tratamiento. Pásale este link para compartir: harmonieinstitute.com/jornada. NUNCA menciones depósito, anticipo ni enlaces de pago. ⚠️ Y CIERRA SIEMPRE ese mensaje (no lo olvides nunca) explicándole en UNA frase qué hacer si necesita CAMBIAR O CANCELAR su cita: primero puede MIRAR los horarios tocando el botón del calendario (agrega al final, en una línea aparte, el marcador [[AGENDAR]]; el sistema lo convierte en botón — NUNCA pegues el enlace en el texto), y después avisarte escribiéndote por aquí o llamándote por voz gratis, y tú se lo resuelves — para eso agrega al final, en una línea aparte, el marcador [[LLAMAR:beni]]. NUNCA le digas que puede cambiarla o cancelarla sola desde el calendario: el calendario es solo para MIRAR; el cambio o la cancelación los haces TÚ.' };
}

// ── REAGENDAR / CANCELAR reservas (Plan B) ──
// Busca las reservas CONFIRMADAS de una persona por su teléfono (compara los últimos 8 dígitos).
async function toolBuscarReserva(args) {
  if (!db) return { error: 'No puedo acceder a la agenda ahora.' };
  const tel = String(args.telefono || '').replace(/\D/g, '').slice(-8);
  if (tel.length < 6) return { error: 'Necesito el teléfono del paciente para buscar su reserva.' };
  try {
    const snap = await db.collection('reservas_beni').where('jornadaId', '==', 'beni').get();
    const out = [];
    snap.forEach(function(doc) {
      const r = doc.data();
      if ((r.estado || 'confirmada') !== 'confirmada') return;
      const rt = String(r.telefono || '').replace(/\D/g, '').slice(-8);
      if (rt && rt === tel) out.push({ subsede: r.subsede, fecha: r.fecha, hora: r.hora, nombre: r.nombre });
    });
    return { reservas: out, nota: out.length ? '' : 'No encontré reservas confirmadas con ese teléfono.' };
  } catch (e) { console.error('buscarReserva:', e.message); return { error: 'No pude buscar la reserva ahora.' }; }
}

// Cancela una reserva: libera el cupo y la marca como cancelada.
// Libera las horas en punto que una cita intermedia (10:30) tenia bloqueadas.
async function _liberarBloqueos(batch, slotId) {
  try {
    const q = await db.collection('cupos_ocupados').where('bloqueadoPor', '==', slotId).get();
    q.forEach(function (d) { batch.delete(d.ref); });
    if (q.size) console.log('🔓 liberadas ' + q.size + ' horas que bloqueaba ' + slotId);
  } catch (e) { console.error('liberarBloqueos:', e.message); }
}

async function toolCancelarReserva(args, cfg) {
  if (!db) return { error: 'No puedo acceder a la agenda ahora.' };
  const fecha = String(args.fecha || '').trim();
  const hora = normalizarHora(args.hora, (cfg && cfg.horas) || null);
  if (!fecha || !hora) return { error: 'Necesito la fecha y la hora exactas de la reserva a cancelar.' };
  const slotId = beniSlotId(fecha, hora);
  try {
    const rdoc = await db.collection('reservas_beni').doc(slotId).get();
    if (!rdoc.exists || (rdoc.data().estado && rdoc.data().estado !== 'confirmada')) {
      return { error: 'No encontré una reserva activa para ' + fecha + ' ' + hora + '. Verifica los datos con la persona.' };
    }
    const r = rdoc.data();
    const batch = db.batch();
    batch.delete(db.collection('cupos_ocupados').doc(slotId));  // libera el cupo (la web lo verá libre)
    await _liberarBloqueos(batch, slotId); // y las horas en punto que esta cita bloqueaba
    batch.delete(db.collection('reservas_beni').doc(slotId));   // BORRA el doc (id determinista): así el horario se puede volver a reservar
    await batch.commit();
    console.log('🗑️ Reserva cancelada: ' + slotId + ' (' + (r.nombre || '?') + ')');
    return { ok: true, mensaje: 'Reserva cancelada: ' + (r.subsede || '') + ' ' + fecha + ' ' + hora + '. El cupo quedó libre.' };
  } catch (e) { console.error('cancelarReserva:', e.message); return { error: 'No pude cancelar la reserva ahora.' }; }
}

// Reagenda una reserva: libera el cupo viejo y ocupa el nuevo (debe estar libre y vigente).
async function toolReagendarReserva(args, cfg) {
  if (!db) return { error: 'No puedo acceder a la agenda ahora.' };
  if (!cfg || cfg.publicada !== true) return { error: 'La jornada no está publicada.' };
  const fechaAct = String(args.fecha_actual || '').trim();
  const horaAct = normalizarHora(args.hora_actual, cfg.horas);
  const fechaNueva = resolverFecha(args.fecha_nueva, args.subsede_nueva, cfg);
  const horaNueva = normalizarHora(args.hora_nueva, cfg.horas);
  if (!fechaAct || !horaAct || !fechaNueva || !horaNueva) return { error: 'Necesito la fecha y hora ACTUALES y las NUEVAS para reagendar.' };
  const oldSlot = beniSlotId(fechaAct, horaAct);
  const newSlot = beniSlotId(fechaNueva, horaNueva);
  if (oldSlot === newSlot) return { error: 'La nueva fecha/hora es igual a la actual.' };
  try {
    const oldDoc = await db.collection('reservas_beni').doc(oldSlot).get();
    if (!oldDoc.exists || (oldDoc.data().estado && oldDoc.data().estado !== 'confirmada')) {
      return { error: 'No encontré la reserva actual (' + fechaAct + ' ' + horaAct + '). Verifica con la persona.' };
    }
    const r = oldDoc.data();
    const subsedeNueva = args.subsede_nueva ? resolverSubsede(args.subsede_nueva, cfg) : r.subsede;
    const diaOk = (cfg.dias || []).some(function(d) { return d.subsede === subsedeNueva && d.fecha === fechaNueva; });
    const horaOk = _horaJornadaValida(horaNueva, cfg.horas);
    if (!diaOk || !horaOk) return { error: 'El nuevo día/hora no es parte de la jornada vigente. Ofrece un día y hora válidos.' };
    if (fechaNueva < fechaBoliviaISO() || (fechaNueva === fechaBoliviaISO() && horaNueva <= horaBoliviaHHMM())) {
      return { error: 'El nuevo horario ya pasó. Ofrece uno de hoy en adelante.' };
    }
    const cupoNuevo = await db.collection('cupos_ocupados').doc(newSlot).get();
    if (cupoNuevo.exists && cupoNuevo.data().bloqueadoPor !== oldSlot) return { error: 'El nuevo horario ya está ocupado. Ofrece otro libre.' };
    // 60 min entre pacientes, ignorando SU PROPIA cita actual (que se va a liberar).
    const _sepN = await _chequearSeparacion(fechaNueva, horaNueva, cfg, oldSlot);
    if (_sepN.error) return { error: _sepN.error };
    const sub = (cfg.subsedes || []).find(function(s) { return s.id === subsedeNueva; }) || {};
    const lugar = sub.direccion ? (subsedeNueva + ' — ' + sub.direccion) : subsedeNueva;
    const batch = db.batch();
    batch.delete(db.collection('cupos_ocupados').doc(oldSlot)); // libera cupo viejo
    await _liberarBloqueos(batch, oldSlot); // y las horas en punto que bloqueaba
    batch.delete(db.collection('reservas_beni').doc(oldSlot));  // BORRA el doc viejo (id determinista): el horario viejo vuelve a estar libre para reservar
    batch.set(db.collection('cupos_ocupados').doc(newSlot), { jornadaId: 'beni', fecha: fechaNueva, hora: horaNueva, ocupado: true });
    (_sepN.emergencia ? [] : _slotsQueBloquea(horaNueva, cfg.horas, 60)).forEach(function (h) {
      batch.set(db.collection('cupos_ocupados').doc(beniSlotId(fechaNueva, h)),
        { jornadaId: 'beni', fecha: fechaNueva, hora: h, ocupado: true, bloqueadoPor: newSlot });
    });
    batch.set(db.collection('reservas_beni').doc(newSlot), {
      jornadaId: 'beni', fecha: fechaNueva, hora: horaNueva, lugar: lugar, subsede: subsedeNueva,
      especialista: cfg.especialista || 'Equipo Harmonie', especialidad: cfg.especialidad || '',
      nombre: r.nombre || '', telefono: r.telefono || '', email: r.email || '', notas: r.notas || '',
      estado: 'confirmada', canal: r.canal || 'chat', reagendadaDe: oldSlot,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    await batch.commit();
    console.log('🔁 Reagendada: ' + oldSlot + ' → ' + newSlot + ' (' + (r.nombre || '?') + ')');
    return { ok: true, mensaje: 'Reserva reagendada a ' + subsedeNueva + ' ' + fechaNueva + ' ' + horaNueva + ' (antes ' + fechaAct + ' ' + horaAct + ').' };
  } catch (e) { console.error('reagendarReserva:', e.message); return { error: 'No pude reagendar la reserva ahora.' }; }
}

// ══════════════════════════════════════════
// FASE 2 — CITAS GENERALES (con o sin campaña): config/sedes + colección 'citas'
// (misma colección que la web). Disponibilidad = días publicados por sede −
// horas ocupadas (Google Calendar para las sedes con calendarId + citas ya tomadas).
// ══════════════════════════════════════════
const SEDES_SEED = {
  version: 'sedes-2026-08b',
  horas: ['09:00','10:00','11:00','12:00','15:00','16:00','17:00','18:00','19:00'],
  sedes: {
    'La Paz':     { calendarId: 'c_6e4a7c796ff4cb0f2e498b240908341bfdcc72c6581c307c162d582d374eaec7@group.calendar.google.com', direccion: 'Av. Arce #2345, Zona Sur', dias: [ { fecha: '2026-08-12', label: 'Miércoles 12 de agosto' }, { fecha: '2026-08-13', label: 'Jueves 13 de agosto' } ] },
    'Oruro':      { calendarId: null, direccion: 'Calle Bolívar #456, Centro', dias: [] },
    'Cochabamba': { calendarId: null, direccion: 'Av. Pando #789, Recoleta', dias: [] },
    'Santa Cruz': { calendarId: null, direccion: 'Av. Monseñor Rivero #890', dias: [] },
    'Sucre':      { calendarId: null, direccion: 'Plaza 25 de Mayo', dias: [] },
    'Potosí':     { calendarId: null, direccion: 'Calle Hoyos #99', dias: [] },
    'Tarija':     { calendarId: null, direccion: 'Av. Las Américas #678', dias: [] },
    'Beni':       { calendarId: null, direccion: 'Rurrenabaque / San Borja', dias: [] }
  }
};
let _sedesCache = null, _sedesCacheTs = 0;
async function seedSedesConfig() {
  if (!db) return;
  try {
    const ref = db.collection('config').doc('sedes');
    const snap = await ref.get();
    if (!snap.exists || snap.data().version !== SEDES_SEED.version) {
      await ref.set(SEDES_SEED);
      console.log('🌱 config/sedes actualizado a ' + SEDES_SEED.version);
    } else {
      console.log('ℹ️ config/sedes ya está en ' + SEDES_SEED.version);
    }
  } catch (e) { console.error('seedSedesConfig:', e.message); }
}
seedSedesConfig();
async function getSedesConfig() {
  const now = Date.now();
  if (_sedesCache && (now - _sedesCacheTs) < 30000) return _sedesCache;
  try {
    const snap = await db.collection('config').doc('sedes').get();
    _sedesCache = (snap.exists ? snap.data() : SEDES_SEED);
  } catch (e) { _sedesCache = SEDES_SEED; }
  _sedesCacheTs = now;
  return _sedesCache;
}
function normSede(x) { return String(x || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim(); }
function resolverSedeGeneral(nombre, cfg) {
  const n = normSede(nombre);
  const keys = Object.keys((cfg && cfg.sedes) || {});
  return keys.find(function(k) { return normSede(k) === n; }) || nombre;
}
function esModalidadVirtual(x) { return /virtual|videollamada|video\s*llamada|telemedicina|zoom|meet|whats/i.test(String(x || '')); }
// Google Calendar → horas ocupadas 'HH:MM' (vía la API local, no la Cloud Function).
async function gcalHorasOcupadas(calendarId, fecha) {
  return await gcalBusyHoras(calendarId, fecha);
}
// Horas ya reservadas en 'citas' (no canceladas) para sede+fecha.
async function citasHorasOcupadas(sede, fecha) {
  if (!db) return [];
  try {
    const snap = await db.collection('citas').where('sede', '==', sede).where('fecha', '==', fecha).get();
    const out = [];
    snap.forEach(function(d) { const c = d.data(); if ((c.estado || 'confirmada') !== 'cancelada' && c.hora) out.push(c.hora); });
    return out;
  } catch (e) { return []; }
}
// Horas ocupadas de una ESPECIALIDAD (= su especialista responsable) cruzando TODA sede y modalidad.
// Campo canónico del id: 'especialidadId' (med/fisio/cir/cosm).
async function citasHorasOcupadasEsp(especialidadId, fecha) {
  if (!db) return [];
  try {
    const snap = await db.collection('citas').where('especialidadId', '==', especialidadId).where('fecha', '==', fecha).get();
    const out = [];
    snap.forEach(function(d) { const c = d.data(); if ((c.estado || 'confirmada') !== 'cancelada' && c.hora) out.push(c.hora); });
    return out;
  } catch (e) { return []; }
}
// Horas ocupadas de una especialidad en las reservas de CAMPAÑA (reservas_beni).
async function reservasBeniHorasEsp(especialidadId, fecha) {
  if (!db) return [];
  try {
    const snap = await db.collection('reservas_beni').where('especialidadId', '==', especialidadId).where('fecha', '==', fecha).get();
    const out = [];
    snap.forEach(function(d) { const c = d.data(); if ((c.estado || 'confirmada') !== 'cancelada' && c.hora) out.push(c.hora); });
    return out;
  } catch (e) { return []; }
}
// Deriva la especialidad (med/fisio/cir/cos) de un texto de tratamiento/servicio. Por defecto med.
function _espKeyFromText(s) {
  s = String(s || '').toLowerCase();
  if (/cirug|plasti|quirurg|rinoplast|liposu|lipoescul|mamoplast|blefaro|abdominoplast|senos|nariz|oper/.test(s)) return 'cir';
  if (/fisio|corporal|modelad|celuli|drenaj|medidas|grasa localiz|tonific|varic|piernas/.test(s)) return 'fisio';
  if (/cosm|limpiez|peeling|microderm|acn|mancha|hidrataci|rutina.*piel|facial b/.test(s)) return 'cos';
  if (/medic|botox|toxina|rellen|hialur|rinomodel|bioestim|hilos|mesoterap|skinboost|arruga|labios|ojera/.test(s)) return 'med';
  return 'med';
}
// ¿El tratamiento está ESTRICTAMENTE fuera del alcance de Medicina Estética (→ fuera de campaña)?
// Devuelve el nombre de la especialidad si está fuera, o null si Medicina Estética PUEDE hacerlo (entra en campaña).
// Medicina estética SÍ realiza overlaps: peeling, dermapen, aparatología, hidrolipoclasia no aspirativa, etc. → esos ENTRAN.
// Solo quedan fuera los inequívocamente de otra especialidad: masajes/drenaje (fisio), limpieza de piel (cosmet.), cirugías.
function _fueraDeCampanaMed(tratamiento) {
  const s = String(tratamiento || '').toLowerCase();
  if (/cirug|quir[uú]rg|operaci|rinoplast|mamoplast|mastopex|liposucci|lipoescul|abdominoplast|blefaroplast|otoplast|mentoplast|braquioplast|bichectom|aumento de (senos|mama|pecho)|implante/.test(s)) return 'cirugía estética';
  if (/masaj|drenaje\s*(linf|l)|presoterap/.test(s)) return 'fisio-estética';
  if (/limpiez|hidra\s?facial|hydra\s?facial|microdermoabra|dermaplan/.test(s)) return 'cosmetología';
  return null; // Medicina Estética puede manejarlo → ENTRA en campaña
}
// ── Ocupación como INTERVALOS {i:'HH:MM', m:minutos} — presencial 60 min, virtual 15 min ──
function _durCita(c) { return (String(c && c.modalidad || '').toLowerCase() === 'virtual') ? 20 : 60; }
async function citasOcupEsp(especialidadId, fecha) {
  if (!db) return [];
  try {
    const snap = await db.collection('citas').where('especialidadId', '==', especialidadId).where('fecha', '==', fecha).get();
    const out = [];
    snap.forEach(function(d) { const c = d.data(); if ((c.estado || 'confirmada') !== 'cancelada' && c.hora) out.push({ i: _hora24(c.hora), m: _durCita(c) }); });
    return out;
  } catch (e) { return []; }
}
async function citasOcupSede(sede, fecha) {
  if (!db) return [];
  try {
    const snap = await db.collection('citas').where('sede', '==', sede).where('fecha', '==', fecha).get();
    const out = [];
    snap.forEach(function(d) { const c = d.data(); if ((c.estado || 'confirmada') !== 'cancelada' && c.hora) out.push({ i: _hora24(c.hora), m: _durCita(c) }); });
    return out;
  } catch (e) { return []; }
}
async function reservasBeniOcupEsp(especialidadId, fecha) {
  if (!db) return [];
  try {
    const snap = await db.collection('reservas_beni').where('especialidadId', '==', especialidadId).where('fecha', '==', fecha).get();
    const out = [];
    snap.forEach(function(d) { const c = d.data(); if ((c.estado || 'confirmada') !== 'cancelada' && c.hora) out.push({ i: _hora24(c.hora), m: 60 }); });
    return out;
  } catch (e) { return []; }
}
function _minHHMM(hhmm) { var p = String(hhmm || '0:0').split(':'); return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0); }
// Memo por (especialidad|fecha) de la ocupación: especialistaOcupado se llama POR CADA HORA en la
// disponibilidad y releía el MISMO día cada vez. Con esto, cada (especialidad,fecha) se lee 1 vez cada ~30s.
const _ocupMemo = new Map();
async function _ocupCitasEsp(espId, fecha) {
  const key = 'c|' + espId + '|' + fecha, now = Date.now();
  const c = _ocupMemo.get(key); if (c && (now - c.ts) < 30000) return c.rows;
  const rows = await citasOcupEsp(espId, fecha); _ocupMemo.set(key, { rows: rows, ts: now }); return rows;
}
async function _ocupReservasEsp(espId, fecha) {
  const key = 'r|' + espId + '|' + fecha, now = Date.now();
  const c = _ocupMemo.get(key); if (c && (now - c.ts) < 30000) return c.rows;
  const rows = await reservasBeniOcupEsp(espId, fecha); _ocupMemo.set(key, { rows: rows, ts: now }); return rows;
}
// ¿El especialista de esa especialidad ya está ocupado en [hora, hora+durMin)? Cruza citas (presencial+virtual) + campaña.
async function especialistaOcupado(especialidadId, fecha, hora, durMin) {
  if (!especialidadId || !db) return false;
  const intervals = (await _ocupCitasEsp(especialidadId, fecha)).concat(await _ocupReservasEsp(especialidadId, fecha));
  const s = _minHHMM(_hora24(hora)), e = s + (durMin || 60);
  for (var k = 0; k < intervals.length; k++) { var i = _minHHMM(intervals[k].i), j = i + (intervals[k].m || 60); if (s < j && i < e) return true; }
  return false;
}
async function _buscarCitaDoc(telefono, fecha, hora) {
  const tel = String(telefono || '').replace(/\D/g, '').slice(-8);
  const h = String(hora || '').trim();
  const snap = await db.collection('citas').where('fecha', '==', String(fecha || '').trim()).get();
  let found = null;
  snap.forEach(function(doc) {
    const c = doc.data();
    if ((c.estado || 'confirmada') === 'cancelada') return;
    const ct = String(c.telefono || '').replace(/\D/g, '').slice(-8);
    if ((!tel || ct === tel) && (!h || c.hora === h)) found = { id: doc.id, data: c };
  });
  return found;
}
function notificarNuevaCita(c) {
  if (!c) return;
  const txt = '🗓️ NUEVA CITA — ' + (c.modalidad === 'virtual' ? 'Videollamada' : (c.sede || 'Presencial')) + '\n'
    + '👤 ' + (c.nombre || '(sin nombre)') + '\n'
    + '📞 ' + (c.telefono || '-') + '\n'
    + '📅 ' + (c.fecha || '-') + ' · ' + (c.hora || '-') + '\n'
    + (c.servicio ? ('💬 ' + c.servicio + '\n') : '')
    + '🔗 Por: ' + (c.canal === 'voz' ? 'llamada de voz' : (c.canal || 'chat'));
  try { waSend(ADMIN_WHATSAPP, txt).catch(function(){}); } catch (e) {}
  try { getAdminTelegram().then(function(adm){ if (adm) bot.sendMessage(adm, txt).catch(function(){}); }).catch(function(){}); } catch (e) {}
  console.log('🗓️ Notificada nueva cita: ' + (c.nombre || '?') + ' ' + (c.fecha || '') + ' ' + (c.hora || ''));
}

async function toolConsultarDisponibilidadSede(args) {
  args = args || {};
  if (!db) return { error: 'No puedo acceder a la agenda ahora.' };
  const cfg = await getSedesConfig();
  const hoy = fechaBoliviaISO();
  if (esModalidadVirtual(args.modalidad) || esModalidadVirtual(args.sede)) {
    // La videollamada NO está habilitada para CIRUGÍAS (valoración de cirugía = SIEMPRE presencial),
    // ni para una especialidad pausada en virtual (config/especialidades, editado desde el panel).
    const espId = _espKeyFromText(args.especialidad || args.tratamiento || args.servicio || '');
    const _notaPau = await espPausadaNota(espId, 'virtual');
    if (espId === 'cir' || _notaPau) {
      return { modalidad: 'virtual', disponible: false, nota: _notaPau || 'La videollamada NO está habilitada para cirugías estéticas: la valoración de una cirugía es SIEMPRE presencial. Ofrece con calidez una valoración PRESENCIAL en sede (o en la jornada si es una cirugía menor). NO ofrezcas ni agendes videollamada para una cirugía.' };
    }
    return { modalidad: 'virtual', nota: 'La videollamada está disponible TODOS los días, de 09:00 a 21:00 (WhatsApp, Zoom o Google Meet). Pregunta qué día y hora prefiere y crea la cita con crear_cita.', horas_referencia: cfg.horas };
  }
  const sede = resolverSedeGeneral(args.sede, cfg);
  const sc = cfg.sedes && cfg.sedes[sede];
  if (!args.sede || !sc) return { error: 'Dime en qué sede: ' + Object.keys(cfg.sedes || {}).join(', ') + '. O si prefiere, la videollamada está disponible todos los días.' };
  let dias = (sc.dias || []).filter(function(d) { return d.fecha >= hoy; });
  if (args.fecha) dias = dias.filter(function(d) { return d.fecha === args.fecha; });
  if (!dias.length) {
    return { sede: sede, direccion: sc.direccion, disponibilidad: [], nota: 'Por ahora no hay fechas presenciales publicadas para ' + sede + '. Ofrece la videollamada (todos los días de 9 a 21) o toma sus datos para avisarle cuando se habiliten fechas.' };
  }
  const ahoraHHMM = horaBoliviaHHMM();
  const out = [];
  for (const d of dias) {
    const ocup = (await gcalHorasOcupadas(sc.calendarId, d.fecha)).concat(await citasHorasOcupadas(sede, d.fecha));
    let libres = (cfg.horas || []).filter(function(h) { return ocup.indexOf(h) === -1; });
    let vencidas = [];
    if (d.fecha === hoy) { vencidas = libres.filter(function(h) { return h <= ahoraHHMM; }); libres = libres.filter(function(h) { return h > ahoraHHMM; }); }
    const entry = { fecha: d.fecha, label: d.label, horas_libres: libres };
    if (vencidas.length) entry.horas_ya_pasaron = vencidas;
    out.push(entry);
  }
  return { sede: sede, direccion: sc.direccion, disponibilidad: out, hora_actual_bolivia: ahoraHHMM };
}

// Enlace directo a la pasarela de pago del SITIO + mensaje al cliente por WhatsApp (reserva presencial → depósito Bs 50).
const PAGO_URL = process.env.PAGO_URL || 'https://harmonieinstitute.com/?pagar=1';
function enviarLinkPago(telefono, c) {
  const tel = String(telefono || '').replace(/\D/g, '');
  if (!tel) { console.warn('💳 enviarLinkPago: sin teléfono'); return; }
  const nombre = String((c && c.nombre) || '').split(/\s+/)[0] || '';
  const msg = 'Hola ' + nombre + ' 💛 Para CONFIRMAR tu reserva en HARMONIE'
    + (c && c.fecha ? (' (' + c.fecha + (c.hora ? ' ' + c.hora : '') + (c.sede ? ' · ' + c.sede : '') + ')') : '')
    + ' haz el depósito de Bs 50 que asegura tu reserva y se DESCUENTA dentro de tu tratamiento.\n\nAbre el enlace y paga aquí 👉 ' + PAGO_URL + '\n\nMantenemos tu cupo apartado 1 hora esperando el pago; si no se completa, se libera automáticamente. Apenas pagues, tu reserva queda confirmada. ¡Te esperamos!';
  try {
    waSend(tel, msg).then(function (data) {
      if (data && data.error) console.error('💳 enlace de pago NO enviado a ' + tel + ':', (data.error.message || JSON.stringify(data.error)));
      else console.log('💳 enlace de pago enviado por WhatsApp a ' + tel);
    });
  } catch (e) { console.error('💳 enviarLinkPago:', e.message); }
}

// ── EXPIRACIÓN DE RESERVAS SIN PAGO ─────────────────────────────────────────
// La reserva presencial queda APARTADA esperando el depósito: 2 horas de HORARIO ACTIVO (8-22h Bolivia; de
// noche PAUSA, no libera ni mensajea). Recordatorios a los 60 y 100 min activos; a los 120 min activos se ELIMINA y libera.
const HOLD_MIN = 120, REM1_MIN = 60, REM2_MIN = 100;
// Ventana de horario activo (Bolivia UTC-4): SOLO se liberan cupos y se mandan recordatorios entre 8:00 y 22:00.
// El "reloj" de expiración cuenta únicamente minutos DENTRO de esa ventana (de noche se pausa), así todos
// reciben 2 horas reales de día para pagar y quien reserva de madrugada tiene hasta la mañana.
function _minutosActivos(startMs, nowMs) {
  if (!startMs || nowMs <= startMs) return 0;
  const OFF = 4 * 3600 * 1000, DAY = 24 * 3600 * 1000, H1 = 8 * 3600 * 1000, H2 = 22 * 3600 * 1000;
  const s = startMs - OFF, n = nowMs - OFF; // pasar a hora local Bolivia
  let active = 0;
  for (let d = Math.floor(s / DAY) * DAY; d < n; d += DAY) {
    const a = Math.max(s, d + H1), b = Math.min(n, d + H2);
    if (b > a) active += (b - a);
  }
  return active / 60000;
}
function _tsMs(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (ts._seconds) return ts._seconds * 1000;
  if (ts.seconds) return ts.seconds * 1000;
  return 0;
}
async function revisarExpiraciones() {
  if (!db) return;
  const ahora = Date.now();
  for (const col of ['citas', 'reservas_beni']) {
    let snap;
    try { snap = await db.collection(col).where('estado', '==', 'pendiente_pago').get(); }
    catch (e) { console.error('⏳ query ' + col + ':', e.message); continue; }
    for (const d of snap.docs) {
      const c = d.data();
      const t = _tsMs(c.timestamp || c.createdAt || c.creadoAt);
      if (!t) continue;
      const edadMin = _minutosActivos(t, ahora); // minutos SOLO de horario activo (8-22h); de noche pausa
      const tel = String(c.telefono || '').replace(/\D/g, '');
      const nom = String(c.nombre || '').split(/\s+/)[0] || '';
      const cuando = (c.fecha || '') + (c.hora ? (' a las ' + c.hora) : '') + ((c.sede || c.subsede) ? (' · ' + (c.sede || c.subsede)) : '');
      const ref = (cuando ? (' (' + cuando.trim() + ')') : '');
      try {
        if (edadMin >= HOLD_MIN) {
          const batch = db.batch();
          batch.delete(d.ref);
          if (col === 'reservas_beni') batch.delete(db.collection('cupos_ocupados').doc(d.id));
          await batch.commit();
          if (tel) waSend(tel, 'Hola ' + nom + ' 💛 Liberamos tu reserva' + ref + ' porque no recibimos el pago del depósito a tiempo. Si aún la deseas, con gusto la agendamos de nuevo. ¡Escríbenos!').catch(function () {});
          console.log('⏳ reserva ' + col + '/' + d.id + ' EXPIRADA (sin pago) y liberada');
        } else if (edadMin >= REM2_MIN && !c.recordatorio2At) {
          await d.ref.update({ recordatorio2At: new Date() });
          if (tel) waSend(tel, 'Hola ' + nom + ' ⏳ Te quedan los últimos minutos para asegurar tu reserva' + ref + '. Completa tu depósito de Bs 50 aquí 👉 ' + PAGO_URL + ' o se liberará automáticamente.').catch(function () {});
          console.log('⏳ recordatorio 2 (' + REM2_MIN + 'min activos) → ' + col + '/' + d.id);
        } else if (edadMin >= REM1_MIN && !c.recordatorio1At) {
          await d.ref.update({ recordatorio1At: new Date() });
          if (tel) waSend(tel, 'Hola ' + nom + ' 💛 Tu reserva' + ref + ' está apartada esperando tu depósito de Bs 50. Complétalo aquí 👉 ' + PAGO_URL + '. La mantenemos un rato más.').catch(function () {});
          console.log('⏳ recordatorio 1 (' + REM1_MIN + 'min activos) → ' + col + '/' + d.id);
        }
      } catch (e) { console.error('⏳ exp ' + d.id + ':', e.message); }
    }
  }
}
function iniciarWatcherExpiraciones() {
  console.log('⏳ Watcher de expiración activo (aparta ' + HOLD_MIN + 'min ACTIVOS 8-22h; recordatorios ' + REM1_MIN + '/' + REM2_MIN + 'min; pausa 22-8h)');
  revisarExpiraciones().catch(function () {});
  setInterval(function () { revisarExpiraciones().catch(function () {}); }, 60 * 60 * 1000);
}

// Fecha "2026-08-13" -> "jueves 13 de agosto" (sin depender de locale del server)
function _fechaEs(fecha) {
  const dias = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const meses = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const dt = new Date(String(fecha) + 'T12:00:00-04:00');
  if (isNaN(dt.getTime())) return fecha;
  return dias[dt.getUTCDay()] + ' ' + dt.getUTCDate() + ' de ' + meses[dt.getUTCMonth()];
}

// ── RECORDATORIO DE CONFIRMACIÓN ──
// Como ya NO hay depósito, cada reserva CONFIRMADA (presencial) recibe recordatorios ~8h y ~2h antes de la cita
// pidiéndole que confirme su asistencia (reduce ausencias). Solo se envía en horario activo (8-22h Bolivia).
// Envía el recordatorio y SOLO lo marca como enviado si WhatsApp lo aceptó. Antes se
// marcaba primero y el error se tragaba: con la ventana de 24h cerrada el aviso se
// perdía en silencio, no se reintentaba nunca y nadie se enteraba.
async function _enviarRecordatorio(d, c, tel, campo, etiqueta, texto) {
  if (!tel) { console.warn('🔔 recordatorio ' + etiqueta + ' sin teléfono → ' + d.id); return; }
  const r = await waSend(tel, texto);
  if (r && !r.error) {
    const u = {}; u[campo] = new Date();
    await d.ref.update(u);
    console.log('🔔 recordatorio ' + etiqueta + ' ENTREGADO → ' + d.id);
    return;
  }
  const motivo = (r && r.error && (r.error.message || r.error.code)) || 'desconocido';
  const intentos = (c.recordatorioIntentos || 0) + 1;
  // NO se marca el campo: al no marcarlo, el siguiente ciclo (30 min) lo reintenta solo.
  await d.ref.update({ recordatorioIntentos: intentos, recordatorioUltimoError: String(motivo).substring(0, 200) });
  console.error('🔔 recordatorio ' + etiqueta + ' NO entregado (intento ' + intentos + ') → ' + d.id + ': ' + motivo);
  // Al segundo intento fallido avisamos al equipo UNA vez: alguien tiene que llamarla.
  if (intentos >= 2 && !c.recordatorioAvisoEquipoAt) {
    await d.ref.update({ recordatorioAvisoEquipoAt: new Date() });
    const aviso = '⚠️ No pude entregar el recordatorio (' + etiqueta + ') de ' + (c.nombre || '?') + '\n'
      + ' Cita: ' + _fechaEs(c.fecha) + ' a las ' + c.hora + (c.subsede ? (' — ' + c.subsede) : '') + '\n'
      + ' Tel: ' + tel + '\n'
      + ' Motivo: ' + String(motivo).substring(0, 140) + '\n'
      + 'Probablemente la ventana de 24h de WhatsApp está cerrada. Conviene llamarla o escribirle a mano.';
    waSend(ADMIN_WHATSAPP, aviso).catch(function () {});
    getAdminTelegram().then(function (adm) { if (adm) bot.sendMessage(adm, aviso).catch(function () {}); }).catch(function () {});
  }
}

async function revisarRecordatoriosConfirmar() {
  if (!db) return;
  const hBol = new Date(Date.now() - 4 * 3600 * 1000).getUTCHours();
  if (hBol < 7 || hBol >= 23) return; // horario de silencio 23:00–07:00 (no molestar el sueño)
  const ahora = Date.now();
  for (const col of ['reservas_beni', 'citas']) {
    let snap;
    try { snap = await db.collection(col).where('estado', '==', 'confirmada').get(); }
    catch (e) { console.error('🔔 query ' + col + ':', e.message); continue; }
    for (const d of snap.docs) {
      const c = d.data();
      if (c.modalidad === 'virtual') continue;      // solo presencial
      const fecha = c.fecha, hora = c.hora;
      if (!fecha || !hora) continue;
      const citaMs = Date.parse(fecha + 'T' + (String(hora).length === 5 ? hora : ('0' + hora)) + ':00-04:00');
      if (isNaN(citaMs)) continue;
      const horasFalta = (citaMs - ahora) / 3600000;
      if (horasFalta <= 0) continue; // la cita ya pasó
      const tel = String(c.telefono || '').replace(/\D/g, '');
      const nom = String(c.nombre || '').split(/\s+/)[0] || '';
      const sede = c.sede || c.subsede || c.lugar || '';
      const sedeTxt = sede ? (' — ' + sede) : '';
      try {
        if (horasFalta <= 2 && !c.recordatorio2hAt) {
          // Recordatorio SIMPLE, ~2h antes
          await _enviarRecordatorio(d, c, tel, 'recordatorio2hAt', '2h',
            'Hola ' + nom + ' 💛 Tu cita en Harmonie' + sedeTxt + ' es hoy a las ' + hora + ' (en aproximadamente 2 horas). ¡Te esperamos! 🌸');
        } else if (horasFalta <= 8 && !c.recordatorioConfirmarAt) {
          // Recordatorio de CONFIRMACIÓN, ~8h antes
          await _enviarRecordatorio(d, c, tel, 'recordatorioConfirmarAt', '8h',
            'Hola ' + nom + ' 💛 Te recordamos tu cita en Harmonie' + sedeTxt + ' el ' + _fechaEs(fecha) + ' a las ' + hora + '. Por favor respóndeme *SÍ* para CONFIRMAR tu asistencia, o escríbeme si necesitas reprogramar. ¡Te esperamos! 🌸');
        } else if (horasFalta <= 20 && !c.recordatorio20hAt) {
          // Recordatorio ~20h antes (víspera): primer aviso + pedir confirmación
          await _enviarRecordatorio(d, c, tel, 'recordatorio20hAt', '20h',
            'Hola ' + nom + ' 💛 Te recordamos tu cita en Harmonie' + sedeTxt + ' el ' + _fechaEs(fecha) + ' a las ' + hora + '. Responde *SÍ* para confirmar tu asistencia. ¡Te esperamos! 🌸');
        }
      } catch (e) { console.error('🔔 recordatorio ' + d.id + ':', e.message); }
    }
  }
}
function iniciarWatcherRecordatorios() {
  console.log('🔔 Watcher de recordatorios activo (~20h + ~8h confirmar + ~2h simple antes de la cita, 7-23h)');
  revisarRecordatoriosConfirmar().catch(function () {});
  setInterval(function () { revisarRecordatoriosConfirmar().catch(function () {}); }, 30 * 60 * 1000);
}

async function toolCrearCita(args, canal) {
  args = args || {};
  if (!db) return { error: 'No puedo acceder a la agenda ahora.' };
  const cfg = await getSedesConfig();
  const nombre = (args.nombre || '').trim(), telefono = (args.telefono || '').trim();
  const fecha = (args.fecha || '').trim(), hora = normalizarHora(args.hora, cfg.horas);
  if (!nombre || !telefono || !fecha || !hora) return { error: 'Necesito nombre completo, teléfono, fecha y hora.' };
  if (fecha < fechaBoliviaISO() || (fecha === fechaBoliviaISO() && hora <= horaBoliviaHHMM())) {
    return { error: 'Ese horario ya pasó. Ofrece uno de hoy en adelante.' };
  }
  const virtual = esModalidadVirtual(args.modalidad) || esModalidadVirtual(args.sede) || esModalidadVirtual(args.plataforma);
  let sede, modalidad;
  if (virtual) {
    modalidad = 'virtual';
    sede = args.plataforma || (esModalidadVirtual(args.sede) ? args.sede : 'Videollamada');
  } else {
    modalidad = 'presencial';
    sede = resolverSedeGeneral(args.sede, cfg);
    const sc = cfg.sedes && cfg.sedes[sede];
    if (!sc) return { error: 'No reconozco esa sede. Las sedes son: ' + Object.keys(cfg.sedes || {}).join(', ') + '.' };
    const diaOk = (sc.dias || []).some(function(d) { return d.fecha === fecha && d.fecha >= fechaBoliviaISO(); });
    if (!diaOk) return { error: 'Ese día no está disponible en ' + sede + '. Consulta con consultar_disponibilidad_sede y ofrece un día publicado.' };
  }
  // La disponibilidad se decide por ESPECIALISTA (abajo, con especialistaOcupado), no por plataforma/sede:
  // así dos especialistas distintos pueden atender a la misma hora, pero el mismo no se dobla.
  const servicio = args.servicio || args.tratamiento || 'Consulta';
  const espId = _espKeyFromText(args.especialidad || servicio);
  // Cirugías: la valoración es SIEMPRE presencial → nunca por videollamada.
  if (virtual && espId === 'cir') return { error: 'La videollamada no está habilitada para cirugías estéticas: la valoración de una cirugía es SIEMPRE presencial. Ofrece una valoración PRESENCIAL en sede (o la jornada si es una cirugía menor). NO agendes videollamada para una cirugía.' };
  // Especialidad pausada para esta modalidad → rechazar con la nota (config/especialidades)
  { const _notaPau = await espPausadaNota(espId, modalidad); if (_notaPau) return { error: _notaPau }; }
  // Cruce por ESPECIALISTA (presencial+virtual+campaña) con solapamiento: no doble-agendar al mismo especialista.
  if (await especialistaOcupado(espId, fecha, hora, virtual ? 20 : 60)) {
    return { error: 'El especialista ya tiene otra cita a esa hora (presencial o virtual). Ofrece otra hora libre.' };
  }
  // Presencial pide depósito de Bs 50 (queda pendiente_pago hasta pagar); virtual es gratis.
  const esPresencial = (modalidad !== 'virtual');
  const cita = {
    nombre: nombre, telefono: telefono, email: args.email || '',
    servicio: servicio,
    especialidadId: espId, especialidadNombre: (_ESPS[espId] || ''),
    fecha: fecha, hora: hora, sede: sede, modalidad: modalidad,
    estado: 'confirmada', canal: canal || 'voz',
    timestamp: admin.firestore.FieldValue.serverTimestamp()
  };
  const ref = await db.collection('citas').add(cita);
  try { notificarNuevaCita({ id: ref.id, nombre: nombre, telefono: telefono, sede: sede, fecha: fecha, hora: hora, modalidad: modalidad, servicio: cita.servicio, canal: cita.canal }); } catch (e) {}
  if (esPresencial) {
    return { ok: true, id: ref.id, mensaje: 'Reserva CONFIRMADA en ' + sede + ', ' + fecha + ' ' + hora + ', a nombre de ' + nombre + '. NO se pide depósito ni pago. Dile con calidez que su reserva quedó registrada, que le enviaremos un recordatorio y que deberá confirmar su cita cuando lo reciba. NUNCA menciones depósito ni enlaces de pago.' };
  }
  return { ok: true, id: ref.id, mensaje: 'Cita confirmada: videollamada (gratis), ' + fecha + ' ' + hora + ', a nombre de ' + nombre + '.' };
}

async function toolBuscarCita(args) {
  if (!db) return { error: 'No puedo acceder a la agenda ahora.' };
  const tel = String((args && args.telefono) || '').replace(/\D/g, '').slice(-8);
  if (tel.length < 6) return { error: 'Necesito el teléfono del paciente para buscar su cita.' };
  try {
    const snap = await db.collection('citas').get();
    const out = [];
    snap.forEach(function(doc) {
      const c = doc.data();
      if ((c.estado || 'confirmada') === 'cancelada') return;
      const ct = String(c.telefono || '').replace(/\D/g, '').slice(-8);
      if (ct && ct === tel && c.fecha >= fechaBoliviaISO()) out.push({ sede: c.sede, fecha: c.fecha, hora: c.hora, modalidad: c.modalidad, nombre: c.nombre });
    });
    return { citas: out, nota: out.length ? '' : 'No encontré citas activas con ese teléfono.' };
  } catch (e) { return { error: 'No pude buscar la cita ahora.' }; }
}

async function toolCancelarCita(args) {
  args = args || {};
  if (!db) return { error: 'No puedo acceder a la agenda ahora.' };
  const cfg = await getSedesConfig();
  const fecha = String(args.fecha || '').trim();
  const hora = normalizarHora(args.hora, cfg.horas);
  if (!fecha || !hora) return { error: 'Necesito la fecha y hora exactas de la cita a cancelar.' };
  try {
    const found = await _buscarCitaDoc(args.telefono, fecha, hora);
    if (!found) return { error: 'No encontré una cita activa para ' + fecha + ' ' + hora + '. Verifica los datos con la persona.' };
    await db.collection('citas').doc(found.id).set({ estado: 'cancelada', canceladaAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    return { ok: true, mensaje: 'Cita cancelada: ' + (found.data.sede || '') + ' ' + fecha + ' ' + hora + '. El horario quedó libre.' };
  } catch (e) { return { error: 'No pude cancelar la cita ahora.' }; }
}

async function toolReagendarCita(args) {
  args = args || {};
  if (!db) return { error: 'No puedo acceder a la agenda ahora.' };
  const cfg = await getSedesConfig();
  const fechaAct = String(args.fecha_actual || '').trim();
  const horaAct = normalizarHora(args.hora_actual, cfg.horas);
  const fechaNueva = String(args.fecha_nueva || '').trim();
  const horaNueva = normalizarHora(args.hora_nueva, cfg.horas);
  if (!fechaAct || !horaAct || !fechaNueva || !horaNueva) return { error: 'Necesito la fecha y hora ACTUALES y las NUEVAS.' };
  try {
    const found = await _buscarCitaDoc(args.telefono, fechaAct, horaAct);
    if (!found) return { error: 'No encontré la cita actual (' + fechaAct + ' ' + horaAct + '). Verifica con la persona.' };
    const c = found.data;
    if (fechaNueva < fechaBoliviaISO() || (fechaNueva === fechaBoliviaISO() && horaNueva <= horaBoliviaHHMM())) return { error: 'El nuevo horario ya pasó. Ofrece uno de hoy en adelante.' };
    const sede = args.sede_nueva ? resolverSedeGeneral(args.sede_nueva, cfg) : c.sede;
    if ((c.modalidad || 'presencial') !== 'virtual') {
      const sc = cfg.sedes && cfg.sedes[sede];
      if (sc) {
        const diaOk = (sc.dias || []).some(function(d) { return d.fecha === fechaNueva; });
        if (!diaOk) return { error: 'El nuevo día no está disponible en ' + sede + '. Ofrece un día publicado.' };
        const ocup = (await gcalHorasOcupadas(sc.calendarId, fechaNueva)).concat(await citasHorasOcupadas(sede, fechaNueva));
        if (ocup.indexOf(horaNueva) !== -1) return { error: 'El nuevo horario ya está ocupado. Ofrece otro libre.' };
      }
    }
    await db.collection('citas').doc(found.id).set({ fecha: fechaNueva, hora: horaNueva, sede: sede, estado: 'confirmada', reagendadaAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    return { ok: true, mensaje: 'Cita reagendada a ' + (c.modalidad === 'virtual' ? 'videollamada' : sede) + ' ' + fechaNueva + ' ' + horaNueva + ' (antes ' + fechaAct + ' ' + horaAct + ').' };
  } catch (e) { return { error: 'No pude reagendar la cita ahora.' }; }
}

// ── AVISO A HUMANO (handoff proactivo): Telegram + WhatsApp ──
const ADMIN_WHATSAPP = process.env.ADMIN_WHATSAPP || '59178922666';
const ADMIN_PIN = process.env.ADMIN_PIN || 'armonniza591';

// Números de la propia clínica. Si uno de estos queda guardado como teléfono de un
// paciente, su recordatorio NUNCA llega: WhatsApp rechaza enviarse un mensaje a sí
// mismo con "(#100) Invalid parameter". Paso dos veces (Judith 30/08, Glenda 31/08),
// asi que se valida al crear la reserva en vez de descubrirlo el dia de la cita.
const TELS_PROPIOS = ['76951552', '78922666'];
// ¿Puede existir este número? Un celular boliviano tiene 8 dígitos y empieza en 6 o 7.
// Valeria transcribe mal los números que le dictan por teléfono: a Reina Cuentas le
// guardó 7016910 (7 dígitos) cuando ella dictó 70166910 dos veces, y quedó inalcanzable
// hasta que se leyó la transcripción de la llamada. Esto lo detecta en el momento,
// mientras la persona sigue al teléfono y puede repetirlo.
// Códigos de país frecuentes entre nuestras pacientes, con los dígitos que lleva el
// número DESPUÉS del código. Hay gente que vive en la sede pero conserva su línea de
// origen: negarle la reserva por eso sería perder una paciente que sí viene.
var PAISES = [
  { cod: '591', pais: 'Bolivia',   min: 8,  max: 8  },
  { cod: '595', pais: 'Paraguay',  min: 9,  max: 9  },
  { cod: '598', pais: 'Uruguay',   min: 8,  max: 9  },
  { cod: '593', pais: 'Ecuador',   min: 9,  max: 9  },
  { cod: '507', pais: 'Panamá',    min: 8,  max: 8  },
  { cod: '506', pais: 'Costa Rica',min: 8,  max: 8  },
  { cod: '54',  pais: 'Argentina', min: 10, max: 11 },
  { cod: '55',  pais: 'Brasil',    min: 10, max: 11 },
  { cod: '56',  pais: 'Chile',     min: 9,  max: 9  },
  { cod: '57',  pais: 'Colombia',  min: 10, max: 10 },
  { cod: '58',  pais: 'Venezuela', min: 10, max: 10 },
  { cod: '51',  pais: 'Perú',      min: 9,  max: 9  },
  { cod: '52',  pais: 'México',    min: 10, max: 11 },
  { cod: '34',  pais: 'España',    min: 9,  max: 9  },
  { cod: '39',  pais: 'Italia',    min: 9,  max: 10 },
  { cod: '1',   pais: 'EE.UU./Canadá', min: 10, max: 10 }
];

// Devuelve { ok, pais, motivo }. Ante la duda ACEPTA: es peor perder una reserva
// real que guardar un número raro. Solo rechaza lo que con certeza no puede existir.
function _revisarTelefono(tel) {
  var d = String(tel || '').replace(/\D/g, '');
  if (!d) return { ok: false, pais: '', motivo: 'no me llegó ningún número' };
  // Boliviano sin código: 8 dígitos que empiezan en 6 o 7.
  if (d.length === 8) {
    return /^[67]\d{7}$/.test(d)
      ? { ok: true, pais: 'Bolivia' }
      : { ok: false, pais: 'Bolivia', motivo: 'tiene 8 dígitos pero empieza en ' + d[0] + ', y los celulares bolivianos empiezan con 6 o 7' };
  }
  // Boliviano al que le falta (o le sobra) un dígito: el caso más común al dictarlo.
  if ((d.length === 7 || d.length === 9) && /^[67]/.test(d)) {
    return { ok: false, pais: 'Bolivia', motivo: 'parece un celular boliviano pero me llegaron ' + d.length + ' dígitos y son 8 — te falta uno o te sobra uno' };
  }
  // Con código de país.
  for (var i = 0; i < PAISES.length; i++) {
    var p = PAISES[i];
    if (d.slice(0, p.cod.length) !== p.cod) continue;
    var resto = d.slice(p.cod.length);
    if (p.cod === '591') {
      return /^[67]\d{7}$/.test(resto)
        ? { ok: true, pais: 'Bolivia' }
        : { ok: false, pais: 'Bolivia', motivo: 'después del 591 me llegaron ' + resto.length + ' dígitos, y un celular boliviano tiene 8 y empieza con 6 o 7' };
    }
    if (resto.length >= p.min && resto.length <= p.max) return { ok: true, pais: p.pais };
    return { ok: false, pais: p.pais, motivo: 'parece un número de ' + p.pais + ', pero después del +' + p.cod + ' me llegaron ' + resto.length + ' dígitos y ahí son ' + (p.min === p.max ? p.min : (p.min + ' o ' + p.max)) };
  }
  // Un número extranjero SIN código de país no sirve: no podríamos escribirle por
  // WhatsApp. Con 11 dígitos o más asumimos que ya trae el código de algún país que no
  // está en la lista; con 9 o 10 es un número local suelto y hay que pedir el código.
  if (d.length >= 11 && d.length <= 15) return { ok: true, pais: 'del exterior' };
  if (d.length === 9 || d.length === 10) {
    return { ok: false, pais: '', motivo: 'me llegaron ' + d.length + ' dígitos sin código de país: si es un número del exterior necesito el código delante (por ejemplo +56 para Chile o +54 para Argentina), porque sin él no podríamos escribirle por WhatsApp' };
  }
  return { ok: false, pais: '', motivo: 'me llegaron ' + d.length + ' dígitos, y ningún teléfono del mundo tiene esa cantidad' };
}
function _telefonoPosible(tel) { return _revisarTelefono(tel).ok; }

function _esTelefonoPropio(tel) {
  const t = String(tel || '').replace(/\D/g, '').slice(-8);
  return !!t && TELS_PROPIOS.indexOf(t) !== -1;
}

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
    + 'Abrí el chat: https://harmonieinstitute.com/valeria-seguimiento?chat=' + encodeURIComponent(userId);
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
    if (block.name === 'crear_reserva_beni') return await toolCrearReserva(block.input || {}, cfg, canal, String(userId || '').split('_').slice(1).join('_'), userId);
    if (block.name === 'buscar_reserva_beni') return await toolBuscarReserva(block.input || {});
    if (block.name === 'cancelar_reserva_beni') return await toolCancelarReserva(block.input || {}, cfg);
    if (block.name === 'reagendar_reserva_beni') return await toolReagendarReserva(block.input || {}, cfg);
    if (block.name === 'avisar_a_humano') return await notificarHumano(userId, (block.input && block.input.motivo) || '');
    return { error: 'herramienta desconocida' };
  } catch (e) {
    console.error('Tool error (' + block.name + '):', e.message);
    return { error: 'No pude completar esa acción ahora mismo.' };
  }
}

// ══════════════════════════════════════════
// Detecta señales de cierre/aplazamiento del cliente → marca "no seguir" para NO insistir con el seguimiento.
const _NO_SEGUIR_RE = /(no,?\s*gracias|no\s*por\s*ahora|no\s*ahora|m[aá]s\s*tarde|luego\s*(te|le)|despu[eé]s\s*(te|le|hablamos|vemos|paso|escribo|aviso|coordin|converso|me\s*comunico)|otro\s*d[ií]a|lo\s*pienso|lo\s*voy\s*a\s*pensar|d[eé]jame\s*pensar|te\s*aviso|yo\s*(te|le)\s*(escribo|aviso)|ya\s*agend|ya\s*reserv|ya\s*tengo\s*(cita|mi\s*cita)|no\s*me\s*escrib|no\s*insist|no\s*quiero|no\s*me\s*interesa)/i;
function _detectarNoSeguir(texto) { return _NO_SEGUIR_RE.test(String(texto || '')); }

// FUNCIÓN PRINCIPAL CLAUDE AI
// ══════════════════════════════════════════
// Detecta que Valeria haya dicho "cita confirmada" sin que crear_reserva_beni se haya
// ejecutado con exito en ese turno. NO bloquea el mensaje (podria ser legitimo: el cliente
// ya reservo antes y ella se lo recuerda), pero AVISA al equipo con el chat y el texto para
// revisarlo el mismo dia, no el dia de la jornada.
const RE_CONFIRMA = /(qued[oó]|est[aá]|ya est[aá])\s+(confirmad|agendad|reservad)|te agend[eé]|felicidades[^.!]{0,30}reserva|tu (cita|reserva)[^.!]{0,25}confirmad/i;
// GUARDIÁN DE HORAS. El modelo ofrece horas ocupadas aunque tenga la lista de libres
// delante: el 1 sep le ofreció a Ana las 15:00 y 17:00 del miércoles (ocupadas desde el
// día anterior), ella aceptó, dio sus datos, la reserva falló y se fue sin cita. Pedirlo
// por prompt ya falló dos veces, así que se corrige el texto antes de enviarlo.
// ¿De qué día de la jornada habla la conversación? Se mira primero la respuesta y luego
// hacia atrás en el hilo: cuando ofrece horas ("¿13:00, 15:00 o 17:00?") ya no repite el
// día, viene de turnos antes.
function _diaDelContexto(textos, cfg) {
  var dias = (cfg && cfg.dias) || [];
  if (!dias.length) return null;
  var hoy = fechaBoliviaISO();
  var manana = new Date(Date.parse(hoy) + 86400000).toISOString().slice(0, 10);
  for (var i = 0; i < textos.length; i++) {
    var t = String(textos[i] || '').toLowerCase();
    if (!t) continue;
    // Primero lo explícito: el nombre del día con su número ("miércoles 2").
    for (var j = 0; j < dias.length; j++) {
      var lbl = String(dias[j].label || '').toLowerCase();       // "miércoles 2 de septiembre"
      var partes = lbl.split(/\s+/);
      var nombre = partes[0] || '';                              // "miércoles"
      var num = partes[1] || '';                                 // "2"
      if (nombre && num && t.indexOf(nombre) !== -1 && new RegExp('\\b' + num + '\\b').test(t)) return dias[j].fecha;
    }
    // Después lo relativo.
    if (/\bma(ñ|n)ana\b/.test(t) && dias.some(function (d) { return d.fecha === manana; })) return manana;
    if (/\bhoy\b/.test(t) && dias.some(function (d) { return d.fecha === hoy; })) return hoy;
    // Por último, el nombre del día suelto ("el miércoles").
    for (var k = 0; k < dias.length; k++) {
      var nom = String(dias[k].label || '').toLowerCase().split(/\s+/)[0];
      if (nom && t.indexOf(nom) !== -1) return dias[k].fecha;
    }
  }
  return null;
}

function _sanearHorasOfrecidas(texto, dispo, cfg, contexto) {
  var t = String(texto || '');
  if (!dispo || !Array.isArray(dispo.disponibilidad)) return { texto: t, corregidas: [] };
  // Las horas válidas son las del DÍA del que se habla. Unir todos los días dejaba pasar
  // el error de Ana: las 17:00 estaban ocupadas el miércoles pero libres el martes.
  var dia = _diaDelContexto([texto].concat(contexto || []), cfg);
  var fuentes = dia
    ? dispo.disponibilidad.filter(function (r) { return r.fecha === dia; })
    : [];
  if (!fuentes.length) return { texto: t, corregidas: [] };  // sin día claro, no tocamos nada
  var libres = [];
  fuentes.forEach(function (r) {
    (r.horas_libres || []).forEach(function (h) { if (libres.indexOf(h) === -1) libres.push(h); });
  });
  if (!libres.length) return { texto: t, corregidas: [] };
  // Solo intervenimos cuando el mensaje está OFRECIENDO horas.
  if (!/(tengo|libre|disponible|te viene|te vendr|cu[aá]l|prefieres|puedo ofrecer)/i.test(t)) return { texto: t, corregidas: [] };
  // Los rangos ("de 9:00 a 20:00") describen el horario de atención, no son oferta.
  var marcado = t.replace(/\b(de|desde|entre)\s*\d{1,2}:\d{2}\s*(a|hasta|y)\s*\d{1,2}:\d{2}/gi, function (m) { return m.replace(/:/g, '§'); });
  var corregidas = [];
  var usadas = [];
  var nuevo = marcado.replace(/\b([01]?\d|2[0-3]):[0-5]\d\b/g, function (h) {
    var norm = (h.length === 4 ? '0' + h : h);
    if (libres.indexOf(norm) !== -1) { usadas.push(norm); return h; }
    // Hora ocupada: la sustituimos por la libre más cercana que no hayamos usado ya.
    var cand = libres.filter(function (x) { return usadas.indexOf(x) === -1; })
      .sort(function (a, b) { return Math.abs(_hhmmAMin(a) - _hhmmAMin(norm)) - Math.abs(_hhmmAMin(b) - _hhmmAMin(norm)); })[0];
    if (!cand) return h;
    usadas.push(cand);
    corregidas.push(norm + '→' + cand);
    return cand;
  });
  nuevo = nuevo.replace(/§/g, ':');
  return { texto: nuevo, corregidas: corregidas };
}

async function _vigilarConfirmacionFalsa(userId, texto, reservoEnEsteTurno) {
  if (reservoEnEsteTurno) return;                  // creo la reserva de verdad: todo bien
  if (!texto || !RE_CONFIRMA.test(texto)) return;  // no dijo nada parecido a "confirmada"
  if (!db) return;
  // ¿la persona YA tenia una reserva vigente? entonces es legitimo que se lo recuerde
  const tel = String(userId || '').split('_').slice(1).join('_').replace(/\D/g, '').slice(-8);
  if (tel) {
    try {
      const rs = await getReservasConfirmadas();
      const hoyISO = fechaBoliviaISO();
      const tiene = (rs || []).some(function (r) {
        return String(r.telefono || '').replace(/\D/g, '').slice(-8) === tel && String(r.fecha || '') >= hoyISO;
      });
      if (tiene) return;
    } catch (e) { /* si falla la consulta, mejor avisar de mas que de menos */ }
  }
  const aviso = [
    '⚠️ POSIBLE CITA FANTASMA',
    '',
    'Valeria dijo que la cita quedo confirmada pero NO se creo la reserva.',
    '',
    'Chat: ' + userId,
    '',
    'Le escribio:',
    String(texto).substring(0, 300),
    '',
    'Revisa el chat y crea la reserva a mano si corresponde.'
  ].join(String.fromCharCode(10));
  console.error('🚨 CITA FANTASMA en ' + userId + ': ' + String(texto).substring(0, 140));
  try { await waSend(ADMIN_WHATSAPP, aviso); } catch (e) { console.error('aviso WA:', e.message); }
  try { const adm = await getAdminTelegram(); if (adm) await bot.sendMessage(adm, aviso); } catch (e) {}
}

// ── COLA POR USUARIO ────────────────────────────────────────────────────────
// Dos mensajes seguidos de la misma persona (comunisimo en WhatsApp: "10:00" y
// enseguida "Judith Tapia") se procesaban EN PARALELO: dos loops peleando por el
// MISMO cupo — uno lo creaba y al otro le salia "ocupado". Ahora van en orden.
const _colaPorUsuario = new Map();
function askValeria(userId, userMessage, origenDirecto) {
  const k = String(userId);
  const corre = function () { return _askValeriaRaw(userId, userMessage, origenDirecto); };
  const prev = _colaPorUsuario.get(k) || Promise.resolve();
  const next = prev.then(corre, corre);
  const guard = next.then(function () {}, function () {});
  _colaPorUsuario.set(k, guard);
  guard.then(function () { if (_colaPorUsuario.get(k) === guard) _colaPorUsuario.delete(k); });
  return next;
}

async function _askValeriaRaw(userId, userMessage, origenDirecto) {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

  await cargarHistorialSiVacio(userId);
  const esPrimerMensaje = getHistory(userId).length === 0;
  addToHistory(userId, 'user', userMessage);
  logMensaje(userId, 'user', userMessage);
  // Auto-marca "no seguir" si el cliente da señales de cierre/aplazamiento (para NO insistir con el seguimiento automático).
  if (db && _detectarNoSeguir(userMessage)) {
    db.collection('valeria_chats').doc(String(userId)).set({ noSeguir: true }, { merge: true }).catch(function(){});
  }

  // Handoff: si un humano tomó este chat (pausada), el bot no responde.
  const _est = await estadoChat(userId);
  if (_est.pausada) {
    _estuvoPausado.add(String(userId));
    console.log('⏸️ Valeria pausada (humano atendiendo): ' + userId);
    return null;
  }
  // Se reanudó: releemos el hilo COMPLETO (incluida la intervención humana) antes de responder.
  if (_estuvoPausado.has(String(userId))) {
    _estuvoPausado.delete(String(userId));
    await recargarHistorial(userId);
    const _h = getHistory(userId);
    if (!_h.length || _h[_h.length - 1].content !== userMessage) addToHistory(userId, 'user', userMessage);
    console.log('▶️ Valeria retoma tras el handoff (' + getHistory(userId).length + ' mensajes releídos): ' + userId);
  }

  const beniCfg = await getBeniConfig();
  const origenFresco = !!origenDirecto; // el referral del anuncio llegó EN ESTE mensaje (clic reciente)
  const origen = origenDirecto || await getChatOrigen(userId);
  const instruccionEspecial = await getInstruccionEspecial(userId); // directiva del equipo SOLO para este chat
  // Si una persona del equipo intervino en este chat, Valeria tiene que retomar SIN pisarla.
  const notaHandoff = _est.huboHumano ? '⚠️ EN ESTE CHAT INTERVINO UNA PERSONA DEL EQUIPO DE HARMONIE. Sus mensajes aparecen en el historial como si fueran tuyos, así que LEE EL HILO COMPLETO antes de responder: continúa desde donde quedó la conversación, NO repitas lo que ya se dijo, NO vuelvas a preguntar datos que la persona ya dio, y NUNCA contradigas ni desmientas nada que el equipo le haya prometido o confirmado (un precio, un horario, una excepción). Si el equipo dejó algo a medias, retómalo con naturalidad, sin mencionar que hubo un cambio de interlocutor ni disculparte por ello.\n\n' : '';
  // Enganchar fuerte con la Jornada si es el primer mensaje O si acaba de hacer clic en el anuncio (aunque ya haya historial)
  const enganchaFuerte = origen && (esPrimerMensaje || origenFresco);
  console.log('🧠 ' + userId + ' hist=' + getHistory(userId).length + ' primerMsg=' + esPrimerMensaje + ' origen=' + (origen ? 'SI' : 'no') + ' fresco=' + origenFresco);
  // Detecta la SEDE (ciudad) del origen del anuncio para no mezclar sedes.
  const _oTxt = String(origen || '').toLowerCase();
  // Datos de la campaña VIGENTE (dinámicos desde la config). Si no hay campaña activa, las reglas cambian.
  const _campActiva = !!(beniCfg && beniCfg.publicada === true && (beniCfg.dias || []).some(function(d){ return d.fecha >= fechaBoliviaISO(); }));
  const _campCiudades = ((beniCfg && beniCfg.subsedes) || []).map(function(x){ return x.nombre; }).filter(Boolean).join(' y ') || 'la sede de la jornada';
  const _campTitulo = (beniCfg && beniCfg.titulo) || 'la jornada';
  const sedeOrigen = (_campActiva && origen) ? _campCiudades : ''; // ciudad de la campaña vigente (si viene de su anuncio)
  const reglasCriticas = 'REGLAS CRITICAS (cumplelas SIEMPRE, por encima de todo lo demas):\n'
    + '1) BREVEDAD COMO HUMANO: responde como en un chat real de WhatsApp: MUY breve y calida, 1-2 frases (idealmente una). NUNCA parrafos tipo folleto ni listas. Responde SOLO lo que te preguntaron. Si el tema da para mas, NO sueltes todo: ofrece ampliar con una pregunta corta (ej. "¿Quieres que te cuente mas?"). Da respuestas largas SOLO si la persona lo pide expresamente o claramente capta que lo necesita. Si tu mensaje supera 2 frases, recortalo. Si preguntan algo general (precios, tratamientos), pregunta primero que les interesa en lugar de listar todo.\n'
    + (_campActiva
        ? ('2) JORNADA VIGENTE: hay una campaña activa: ' + _campTitulo + ' (en ' + _campCiudades + '). Ofrece unicamente sus dias, que veras mas abajo. (Distintas subsedes/puntos dentro de la MISMA ciudad si pueden mencionarse juntos; ciudades distintas NO se mezclan.)\n')
        : ('2) SIN JORNADA ACTIVA: ahora no hay ninguna jornada/campaña vigente. ⚠️ NO lo anuncies tu de entrada NI lo metas en el saludo. SOLO si la persona PREGUNTA por una jornada/campaña/fechas, aclara con calidez que la ultima ya finalizo y ofrece una cita normal (presencial en sede o videollamada gratis) o tomar sus datos para la proxima. Mientras tanto, atiende sus preguntas con naturalidad. NUNCA ofrezcas fechas ni cupos de campaña.\n'))
    + (esPrimerMensaje
        ? ('3) ESTADO (PRIMER mensaje) — REGLA DURA DE LONGITUD (la mas importante): tu PRIMER mensaje es UNA SOLA frase corta y NADA mas: saludo humano + (si sabes el origen) reconocimiento BREVE + "¿en que te ayudo?". EJEMPLO EXACTO: "¡Hola! Soy Valeria, de Harmonie 😊 Veo que me escribes por [X], ¿en que te ayudo?". ⛔ PROHIBIDO en ese primer mensaje: explicar que una jornada/campaña ya termino o finalizo, ofrecer alternativas o "cita normal/videollamada", dar precios, listar tratamientos, o cualquier parrafo. **AUNQUE EL ORIGEN SEA DE UNA CAMPAÑA PASADA/FINALIZADA, NO lo expliques ni lo menciones en el primer mensaje** — solo saluda + reconoce breve el tema/ciudad + pregunta. Lo de que finalizo o las alternativas SOLO si DESPUES te preguntan expresamente. Corto, humano, una frase, jamas como bot. ⚠️ EXCEPCIÓN CLAVE: si en su primer mensaje la persona YA te dijo qué quiere (un tratamiento, la jornada de una ciudad, precios, agendar), está PROHIBIDO responderle "¿en qué te ayudo?" — suena a que no la leíste y la obliga a repetirse. Reconocé lo que pidió y ofrecele opciones CONCRETAS de lo que sigue. Ejemplo: ante "quiero información sobre la campaña en La Paz" → "¡Claro! ¿Qué te gustaría saber de la jornada en La Paz: algún tratamiento en particular, los precios, o prefieres que te agende tu cita?". Reserva el "¿en qué te ayudo?" para cuando su mensaje sea un saludo suelto, sin tema. ⛔ Pero esa excepción NO te habilita a explayarte: ese primer mensaje sigue siendo de UNA O DOS FRASES como máximo. Reconocé el tema y ofrecé 2 o 3 caminos, y NADA MÁS. Sigue PROHIBIDO en el primer mensaje listar tratamientos, dar precios o recitar la promoción — todo eso va en los mensajes SIGUIENTES, cuando la persona elija por dónde seguir. Modelo exacto de la longitud correcta: "¡Claro! ¿Qué te gustaría saber de la jornada en La Paz: algún tratamiento, los precios, o prefieres que te agende tu cita?".\n')
        : '3) ESTADO: YA venian conversando en este mismo chat (NO es el primer mensaje). PROHIBIDO volver a saludar, presentarte o decir "Hola" otra vez. CONTINUA el hilo recordando lo ya hablado (su nombre, lo que le interesa, su localidad y dia si los dio). Si te escriben solo "hola", retoma el tema sin re-presentarte, ej: "¡Aqui sigo! ¿Avanzamos con tu reserva?".\n')
    + (origen
        ? ('4) ORIGEN: esta persona te escribe por: "' + origen + '". Reconócelo con NATURALIDAD y en TUS palabras (NO pegues ese texto crudo tal cual): si menciona un tratamiento, algo como "veo que te interesa [tratamiento]"; si es una ciudad/jornada, "veo que me escribes por [ciudad]". Adapta la charla a ese interés y responde sus preguntas.' + (_campActiva && sedeOrigen ? (' Ademas hay jornada activa en ' + _campCiudades + ': engánchala con calidez y ofrécele sus fechas.') : '') + '\n')
        : (_campActiva
            ? ('4) SIN ORIGEN: no sabes de donde viene. Saluda normal y pregunta en que la ayudas. Si pregunta por la jornada o por reservar, cuentale que la jornada vigente es ' + _campTitulo + ' en ' + _campCiudades + ' y ofrecele sus fechas.\n')
            : '4) SIN ORIGEN: no sabes de donde viene. Saluda normal y pregunta en que la ayudas.\n'))
    + '5) AGENDA — REGLA DE ORO (NUNCA la rompas): para fechas, horas y reservas usas SIEMPRE tus herramientas, JAMAS tu memoria ni la lista de dias de abajo para inventar horas. '
      + '(a) Cuando la persona acepte o pida agendar, NO le tires horas de una vez: PRIMERO dile en una frase corta que vas a revisar la agenda (ej. "Permiteme revisar la disponibilidad un momento 😊") y recien ahi LLAMA a consultar_disponibilidad_beni; SOLO despues ofrece las horas que ESA herramienta devuelva como libres en esta misma conversacion. NUNCA ofrezcas horas adivinando, suponiendo ni de memoria. '
      + '(b) Para reservar, LLAMA a crear_reserva_beni. SOLO puedes decir que la cita quedo agendada/confirmada si esa herramienta te respondio ok:true. Si respondio error (ocupado, ya paso, faltan datos), NO confirmes: disculpate en una frase y ofrece otra hora libre que la herramienta SI devuelva. '
      + 'Si el sistema te responde que la reserva YA ESTA CREADA y es de ESTA MISMA persona, eso es un EXITO: confirmasela con calidez, NUNCA le digas que ese horario no esta disponible (te lo estarias negando a vos misma). Y si te avisa que la persona YA TIENE cita en otra hora, no crees una segunda: usa reagendar_reserva_beni. (c) PROHIBIDO decir "te agende", "quedo reservado", "listo, confirmada" o parecido sin un ok:true real de crear_reserva_beni. Si tienes cualquier duda sobre disponibilidad, vuelve a consultar_disponibilidad_beni antes de responder.\n'
    + '7) RESERVA YA HECHA (evita duplicar y confusiones): si la persona dice que ya reservó/agendó o menciona una cita ya hecha y NO ves arriba (⚠️) una reserva suya, ubicala ANTES de ofrecer agendar: usa buscar_reserva_beni con su numero; si no aparece, preguntale con que numero o a que nombre hizo la reserva (pudo reservar con OTRO numero, ej. el de un familiar) y buscala con ESE dato. Solo si de verdad no existe ninguna, ofrecele agendar. NUNCA digas que un horario "no esta libre" si es SU propia reserva.\n'
    + (_campActiva ? '6) PROMO POR RECOMENDADO (REGLA EXACTA, sigue lo que diga "Promo" mas abajo; nunca la interpretes distinto): venir sola/solo da 20% de descuento. El 50% es SOLO para QUIEN TRAE a un recomendado que se atienda. Es decir: la persona trae a un invitado que se atiende y ELLA (la que invita) gana 50% en SU propio tratamiento. El invitado NO gana 50% por el simple hecho de venir; el invitado gana su propio 50% UNICAMENTE si a su vez trae a OTRO recomendado que se atienda (asi en cadena, cada quien por su propio invitado). PROHIBIDO decir "los dos ganan", "ambos ganan el 50%", "traes a un amigo y los dos tienen 50%" o similar. El beneficio del 50% es de quien invita, uno por uno.\n' : '');
  const bloqueInstruccion = instruccionEspecial
    ? 'INSTRUCCION ESPECIAL DEL EQUIPO PARA ESTE CLIENTE (PRIORIDAD MAXIMA, por encima de TODO lo demas): '
      + instruccionEspecial
      + '. Cumplela en esta conversacion de forma natural y calida, sin mencionar nunca que es una instruccion interna ni que te la dio el equipo. Si choca con otras reglas, ESTA manda.\n\n'
    : '';
  // Disponibilidad REAL en vivo (horas libres por dia) para inyectar en el prompt:
  // asi Valeria ve las horas verdaderamente libres y no las adivina de la lista completa.
  let dispoBeni = null;
  try { dispoBeni = await toolConsultarDisponibilidad(sedeOrigen ? { subsede: sedeOrigen } : {}, beniCfg); } catch (e) { console.error('dispo prompt:', e.message); }
  // ¿Esta persona YA tiene una reserva activa de la jornada? Se la informamos a Valeria para que la RECONOZCA
  // (y no trate "ya agendé / mi cita del sábado 11" como un pedido nuevo ni diga que ese horario no está libre).
  let bloqueReserva = '';
  try {
    const _contacto = String(userId || '').split('_').slice(1).join('_');
    const _tel8 = String(_contacto).replace(/\D/g, '').slice(-8);
    if (db && _tel8 && _tel8.length >= 7) {
      const _hoy = fechaBoliviaISO();
      let _rsv = null;
      const _rows = await getReservasConfirmadas();
      _rows.forEach(function (r) { const rt = String(r.telefono || '').replace(/\D/g, '').slice(-8); if (rt === _tel8 && (r.fecha || '') >= _hoy && !_rsv) _rsv = r; });
      if (_rsv) {
        const _dia = ((beniCfg && beniCfg.dias) || []).find(function (x) { return x.fecha === _rsv.fecha; });
        const _lbl = (_dia && _dia.label) || _rsv.fecha;
        bloqueReserva = '⚠️ ESTA PERSONA YA TIENE UNA RESERVA CONFIRMADA en la jornada: ' + (_rsv.subsede || _campCiudades) + ', ' + _lbl + ' a las ' + _rsv.hora + (_rsv.nombre ? (' (a nombre de ' + String(_rsv.nombre).split(/\s+/)[0] + ')') : '') + '. Si menciona su cita, o su día u hora, o dice que "ya agendó/reservó", RECONÓCELA y CONFÍRMASELA con calidez (ej. "¡Sí! Veo tu reserva para el ' + _lbl + ' a las ' + _rsv.hora + ' en ' + (_rsv.subsede || _campCiudades) + '. ¡Te esperamos! 💛"). NO la trates como un pedido nuevo: NO consultes disponibilidad ni digas que ese horario "no está libre" (está ocupado por SU PROPIA reserva). SOLO si pide EXPLÍCITAMENTE cambiar/reagendar o cancelar su cita, usa reagendar_reserva_beni o cancelar_reserva_beni.\n\n';
      }
    }
  } catch (e) { console.error('reserva activa prompt:', e.message); }
  let espPauSection = '';
  try { espPauSection = await buildEspPausadasSection(); } catch (e) { console.error('askValeria espPau:', e.message); }
  const systemPrompt = notaHandoff + bloqueReserva + bloqueInstruccion + reglasCriticas
    + '\n' + SYSTEM_PROMPT
    + '\n\nFecha actual (Bolivia): ' + fechaBoliviaTexto() + '.'
    + buildBeniSection(beniCfg, dispoBeni)
    + espPauSection;
  if (instruccionEspecial) console.log('📝 Instrucción especial activa para ' + userId + ': ' + instruccionEspecial.substring(0, 80));

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
        return 'Hola! Soy Valeria de HARMONIE 💆‍♀️ Tengo un problema técnico en este momento. Por favor escríbenos al WhatsApp +591 76951552 y te atendemos de inmediato 😊';
      }

      // ¿Claude pide usar una herramienta? Ejecutarla y volver a llamar.
      if (data.stop_reason === 'tool_use') {
        messages.push({ role: 'assistant', content: data.content });
        const toolResults = [];
        for (const block of data.content) {
          if (block.type === 'tool_use') {
            const result = await ejecutarTool(block, beniCfg, canal, userId);
            console.log('🛠️ ' + block.name + ' →', JSON.stringify(result).substring(0, 160));
            // Si agendó en este chat, márcalo para NO mandarle seguimientos de "te quedó pendiente".
            if (block.name === 'crear_reserva_beni' && result && result.ok && db) {
              db.collection('valeria_chats').doc(String(userId)).set({ reservoOk: true, reservoCampaign: (beniCfg && beniCfg.campaignVersion) || '' }, { merge: true }).catch(function(){});
            }
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
        .join('\n')
        .replace(/<function_calls>[\s\S]*?<\/function_calls>/gi, '')
        .replace(/<\/?(?:invoke|parameter|function_calls)\b[^>]*>/gi, '')
        .trim() || 'Con gusto te ayudo 😊';
      // RED DE SEGURIDAD: ¿dijo "confirmada" sin haber creado la reserva? (30/08: dos clientas
      // quedaron con una cita inexistente porque Valeria la redacto de memoria).
      // Ninguna hora ofrecida puede estar ocupada: se corrige antes de que la lea nadie.
      try {
        var _ctx = getHistory(userId).slice(-6).map(function (m) { return m.content; }).reverse();
        var _san = _sanearHorasOfrecidas(reply, dispoBeni, beniCfg, _ctx);
        if (_san.corregidas.length) {
          console.warn('🕐 horas ocupadas corregidas para ' + userId + ': ' + _san.corregidas.join(', '));
          reply = _san.texto;
        }
      } catch (e) { console.error('saneo horas:', e.message); }
      try { _vigilarConfirmacionFalsa(userId, reply, _reservoEnEsteTurno); } catch (e) { console.error('vigilante:', e.message); }
      addToHistory(userId, 'assistant', reply);
      logMensaje(userId, 'valeria', reply);
      console.log(`🤖 Valeria → ${userId}: ${reply.substring(0, 100)}...`);
      return reply;
    }

    // Si se agotó el bucle sin respuesta final.
    return 'Con gusto te ayudo 😊 ¿En qué te puedo apoyar? Si quieres, te ayudo a agendar una cita o a ver la jornada vigente en el calendario.';

  } catch (err) {
    console.error('Error Claude AI:', err);
    return 'Hola! Soy Valeria de HARMONIE 💆‍♀️ Tengo un problema técnico. Por favor escríbenos al WhatsApp +591 76951552 😊';
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

  // Comando de prueba: "/reset" borra el historial para probar la presentación fresca.
  if (text.trim().toLowerCase() === '/reset') {
    await resetHistorial(`tg_${chatId}`);
    bot.sendMessage(chatId, '🧹 Listo, borré nuestra conversación. Escribime de nuevo y empezamos de cero 😊');
    return;
  }

  setChatNombre(`tg_${chatId}`, [msg.from && msg.from.first_name, msg.from && msg.from.last_name].filter(Boolean).join(' '));

  console.log(`📱 Telegram de ${chatId}: ${text}`);
  const t0 = Date.now();
  bot.sendChatAction(chatId, 'typing');
  const reply = await askValeria(`tg_${chatId}`, text);
  if (reply) {
    const { texto, url } = extraerMarcadorLlamada(reply);
    const msg = url ? (texto + '\n👉 ' + url) : texto;
    const espera = typingDelay(msg) - (Date.now() - t0);
    if (espera > 0) { bot.sendChatAction(chatId, 'typing'); await sleep(espera); }
    bot.sendMessage(chatId, msg);
  }
});

bot.on('callback_query', (query) => {
  bot.answerCallbackQuery(query.id);
});

// ══════════════════════════════════════════
// WHATSAPP — ENVÍO
// ══════════════════════════════════════════
// -- FORMATO DE SALIDA (determinista, no depende de que el modelo se acuerde) --
// El modelo escribe la negrita como **texto**, pero NINGUN canal de mensajeria lo entiende:
// WhatsApp usa *simple*; Messenger, Instagram, Telegram y el chat web no tienen negrita.
// Sin esta limpieza el cliente ve los asteriscos literales (paso en produccion, justo en la
// direccion de la sede y en la promo del 50%). Se aplica dentro de cada funcion de envio.
function _fmtSalida(texto, canal) {
  let t = String(texto == null ? '' : texto);
  t = t.replace(/\*\*\*(.+?)\*\*\*/gs, '$1');
  t = t.replace(/\*\*(.+?)\*\*/gs, canal === 'wa' ? '*$1*' : '$1');
  if (canal !== 'wa') t = t.replace(/\*([^*\n]+)\*/g, '$1');
  t = t.replace(/__(.+?)__/gs, '$1');
  t = t.replace(/^#{1,6}\s+/gm, '');
  return t;
}

async function waSend(to, text) {
  text = _fmtSalida(text, 'wa');
  const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
  const PHONE_ID = process.env.WHATSAPP_PHONE_ID;
  try {
    const r = await fetch(`https://graph.facebook.com/v25.0/${PHONE_ID}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } })
    });
    const data = await r.json().catch(function () { return {}; });
    if (data && data.error) console.error('❌ WA a ' + to + ':', JSON.stringify(data.error).slice(0, 400));
    return data;
  } catch (err) { console.error('Error WA a ' + to + ':', err.message); return { error: { message: err.message } }; }
}

// Botón "Llamar a Valeria" (WhatsApp interactive cta_url): abre la página correcta donde
// están el botón Llamar, el calendario para agendar y el botón de WhatsApp para volver.
async function waSendCallButton(to, url, bodyText, label) {
  const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
  const PHONE_ID = process.env.WHATSAPP_PHONE_ID;
  try {
    const r = await fetch(`https://graph.facebook.com/v25.0/${PHONE_ID}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', to, type: 'interactive',
        interactive: {
          type: 'cta_url',
          body: { text: bodyText || 'Toca para hablar conmigo por voz, gratis 👇' },
          action: { name: 'cta_url', parameters: { display_text: (label || 'Llamar a Valeria 📞'), url: url } }
        }
      })
    });
    const data = await r.json().catch(function(){ return {}; });
    if (data && data.error) {
      // Fallback: si la API rechaza el botón, manda el enlace como texto para no perder la acción.
      console.error('waSendCallButton error:', JSON.stringify(data.error).substring(0, 200));
      await waSend(to, (label && /agendar/i.test(label)) ? ('Mira el calendario y elige tu hora aquí: ' + url) : ('📞 Para hablar conmigo por voz (gratis), entra aquí y toca "Llamar": ' + url));
    }
  } catch (err) {
    console.error('Error waSendCallButton:', err);
    await waSend(to, '📞 Para hablar conmigo por voz (gratis), entra aquí y toca "Llamar": ' + url);
  }
}

// Extrae el marcador [[LLAMAR:beni|web]] del texto de Valeria. Devuelve el texto ya limpio
// y la URL destino (o null si no hay marcador).
// Extrae el marcador [[AGENDAR]] y devuelve la URL del CALENDARIO de la jornada vigente
// (con ?agendar=1, que lo abre directo). Se manda como BOTON, no como link pelado.
function extraerMarcadorAgendar(text) {
  if (!text) return { texto: text, url: null };
  var re = new RegExp("\\[\\[\\s*AGENDAR\\s*\\]\\]", "ig");
  var url = null;
  if (re.test(text)) {
    var _c = (typeof _beniCache !== 'undefined' && _beniCache) ? _beniCache.data : null;
    var _r = (_c && (_c.rutaMinisitio || _c.slug)) || 'jornada';
    url = 'https://harmonieinstitute.com/' + _r + '?agendar=1';
  }
  re.lastIndex = 0;
  var texto = String(text).replace(re, '').trim();
  return { texto: texto, url: url };
}

function extraerMarcadorLlamada(text) {
  if (!text) return { texto: text, url: null };
  const m = text.match(/\[\[\s*LLAMAR\s*:\s*(beni|web)\s*\]\]/i);
  // La ruta de la jornada sale de la config vigente (antes estaba fija en /cochabamba y
  // mandaba a todos al minisitio de una campana terminada). Si no hay config a mano cae
  // en /jornada, la ruta universal que siempre redirige a la campana activa.
  let url = null;
  if (m) {
    if (m[1].toLowerCase() === 'beni') {
      const _c = (typeof _beniCache !== 'undefined' && _beniCache) ? _beniCache.data : null;
      const _r = (_c && (_c.rutaMinisitio || _c.slug)) || 'jornada';
      url = 'https://harmonieinstitute.com/' + _r + '?llamar=1';   // arranca la llamada sola al abrir
    } else url = 'https://harmonieinstitute.com?llamar=1';
  }
  const texto = text.replace(/\[\[\s*LLAMAR\s*:\s*(beni|web)\s*\]\]/ig, '').trim();
  return { texto: texto, url: url };
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
  text = _fmtSalida(text, 'fb');
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
  text = _fmtSalida(text, 'ig');
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
            // Un mensaje de WhatsApp no siempre es texto: puede ser el toque de un BOTON o el
            // envio de un FORMULARIO (Flow) de Meta. Antes solo se leia .text.body, asi que esos
            // mensajes llegaban VACIOS y Valeria respondia 'tengo una falla tecnica'.
            let text = message.text?.body || '';
            if (!text && message.interactive) {
              const it = message.interactive;
              if (it.button_reply) text = it.button_reply.title || '';
              else if (it.list_reply) text = it.list_reply.title || '';
              else if (it.nfm_reply) {
                // Respuesta de un formulario: aprovechamos los datos que la persona ya escribio
                let datos = '';
                try {
                  const j = JSON.parse(it.nfm_reply.response_json || '{}');
                  datos = Object.keys(j)
                    .filter(function (k) { return !/flow_token|^screen/i.test(k); })
                    .map(function (k) { return k + ': ' + j[k]; })
                    .join(', ');
                } catch (e) {}
                text = datos ? ('Te envio mis datos por el formulario — ' + datos) : 'Hola, quiero informacion';
              }
            }
            if (!text && message.button) text = message.button.text || '';
            if (!text) text = 'Hola';   // nunca dejar el mensaje vacio

            console.log(`📱 WhatsApp de ${from}: ${text}`);
            setChatNombre(`wa_${from}`, nombreWa);
            // Comando de prueba: "/reset" borra el historial de este número para probar la presentación fresca.
            if (text.trim().toLowerCase() === '/reset') {
              await resetHistorial(`wa_${from}`);
              await waSend(from, '🧹 Listo, borré nuestra conversación. Escríbeme de nuevo y empezamos de cero 😊');
              return;
            }
            let origenDesc = null;
            const refz = message.referral;
            if (refz && (refz.source_type === 'ad' || refz.headline || refz.body)) {
              origenDesc = 'anuncio en Facebook/Instagram/WhatsApp'
                + (refz.headline ? ' titulado "' + refz.headline + '"' : '')
                + (refz.body ? ' — ' + String(refz.body).substring(0, 200) : '');
              setChatOrigen(`wa_${from}`, origenDesc);
              console.log(`📢 WhatsApp referral (anuncio): ${origenDesc.substring(0, 140)}`);
            }
            const t0 = Date.now();
            await waTyping(message.id);
            const reply = await askValeria(`wa_${from}`, text, origenDesc);
            if (reply) {
              const _ag = extraerMarcadorAgendar(reply);
              const { texto, url } = extraerMarcadorLlamada(_ag.texto);
              const espera = typingDelay(texto || reply) - (Date.now() - t0);
              if (espera > 0) await sleep(espera);
              if (texto) await waSend(from, texto);
              if (_ag.url) await waSendCallButton(from, _ag.url, 'Mira el calendario y elige tu hora 👇', 'Agendar mi cita 📅');
              if (url) await waSendCallButton(from, url); // botón "Llamar a Valeria"
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
            const { texto, url } = extraerMarcadorLlamada(reply);
            const msg = url ? (texto + '\n👉 ' + url) : texto;
            const espera = typingDelay(msg) - (Date.now() - t0);
            if (espera > 0) await sleep(espera);
            await fbSend(userId, msg);
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
            const { texto, url } = extraerMarcadorLlamada(reply);
            const msg = url ? (texto + '\n👉 ' + url) : texto;
            const espera = typingDelay(msg) - (Date.now() - t0);
            if (espera > 0) await sleep(espera);
            await igSend(userId, msg);
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

app.get('/', (req, res) => res.send('🤖 Valeria Bot — HARMONIE Bolivia — Activo ✅'));

// ══════════════════════════════════════════
// CHAT WEB — endpoint para el chat de Valeria en el sitio (tarjeta de la sección "Valeria").
// Sin herramientas de reserva: informa y deriva a Reservas del sitio / WhatsApp. Stateless (el navegador manda el historial).
// ══════════════════════════════════════════
function _setChatCors(req, res) {
  const origin = req.headers.origin || '';
  const permitido =
    /^https:\/\/(www\.)?(harmonieinstitute\.com|armonniza\.com)$/.test(origin) ||
    /^https:\/\/armonniza-prod(--[a-z0-9-]+)?\.web\.app$/.test(origin) ||
    /^https:\/\/armonniza-prod\.firebaseapp\.com$/.test(origin);
  if (permitido) res.set('Access-Control-Allow-Origin', origin);
  res.set('Vary', 'Origin');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
}
app.options('/chat', (req, res) => { _setChatCors(req, res); res.status(204).end(); });
app.post('/chat', async (req, res) => {
  _setChatCors(req, res);
  const WA = '+591 76951552';
  try {
    const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    if (!ANTHROPIC_API_KEY) return res.json({ answer: 'El chat no está disponible ahora mismo. Escríbenos por WhatsApp ' + WA + '.' });

    const raw = (req.body && req.body.messages) || [];
    let msgs = raw
      .slice(-12)
      .map(function (m) { return { role: m && m.role === 'assistant' ? 'assistant' : 'user', content: String((m && (m.content || m.text)) || '').slice(0, 2000) }; })
      .filter(function (m) { return m.content; });
    // Colapsa turnos del mismo rol y garantiza que empiece en "user" (requisito del modelo).
    const norm = [];
    msgs.forEach(function (m) {
      if (norm.length && norm[norm.length - 1].role === m.role) norm[norm.length - 1].content += '\n' + m.content;
      else norm.push({ role: m.role, content: m.content });
    });
    while (norm.length && norm[0].role !== 'user') norm.shift();
    if (!norm.length) return res.json({ answer: '¡Hola! Soy Valeria de HARMONIE 💆‍♀️ ¿En qué puedo ayudarte?' });

    const webNote = '\n\n---\n[CANAL: CHAT WEB de harmonieinstitute.com — REGLAS DE ESTE CANAL (PRIORIDAD MÁXIMA, por encima de todo lo de arriba):\n'
      + '1) Preséntate y refiérete a ti misma como "asistente de Harmonie". NUNCA digas "asistente virtual".\n'
      + '2) CAMPAÑAS EN EL CHAT WEB: este canal es general y nacional, así que NO promociones la jornada de forma proactiva. Habla de los tratamientos y las 8 sedes de forma general. Si la persona pregunta EXPRESAMENTE si hay una campaña/jornada activa, guíate por la sección "JORNADA ACTIVA" de arriba: si la hay, cuéntale con calidez que puede ver las fechas y reservar en el calendario (usa el botón [[AGENDAR]]); si no hay ninguna activa, ofrécele dejar sus datos para la próxima. Tú NO des fechas concretas ni los descuentos en este chat; que lo vea en el calendario.\n'
      + '3) AYUDA AQUÍ MISMO, en este chat: responde sus dudas con calidez y resuélvelas tú directamente. NO derives a WhatsApp de forma proactiva ni repitas "escríbenos por WhatsApp". SOLO menciona el WhatsApp (' + WA + ') si la persona pide EXPRESAMENTE hablar con alguien del equipo.\n'
      + '4) AGENDAR (MUY IMPORTANTE): NUNCA digas que "no tienes acceso al calendario" ni te disculpes por no poder agendar. Cuando la persona quiera reservar/agendar (o sea el momento natural para invitarla), hazlo con calidez y al FINAL de tu mensaje, en una línea aparte y sola, escribe EXACTAMENTE el marcador [[AGENDAR]] (nada más en esa línea; NUNCA lo expliques, menciones ni lo pongas en cada mensaje). El sistema convierte ese marcador en un botón "Agendar" que abre el calendario del sitio, donde la persona elige AGENDA VIRTUAL (consulta/valoración ONLINE por videollamada, sin salir de casa) o PRESENCIAL en las sedes. Ofrece ambas y destaca la virtual. En este canal NO uses los marcadores [[LLAMAR:...]].\n'
      + '5) Respuestas MUY breves (1 a 2 frases), cálidas, en español latino neutro (sin voseo). No inventes fechas ni horas concretas.\n'
      + '6) MANTÉN EL HILO: recuerda lo que la persona ya te dijo en esta conversación y continúa desde ahí; si ya venían hablando, NO te vuelvas a presentar ni reinicies.\n'
      + '7) NUNCA INVENTES UNA CAMPAÑA VIGENTE (REGLA DURA): si la sección "JORNADA ACTIVA" de arriba dice que NO hay ninguna activa, está PROHIBIDO decir "nuestra jornada actual", "la campaña de ahora" o cualquier frase que dé a entender que hay una en curso, y está PROHIBIDO prometer sus beneficios (20%, 50% por recomendado, valoración gratis) como si se pudieran reclamar hoy. Si preguntan por esos descuentos y NO hay jornada activa, explica con calidez que son beneficios de nuestras jornadas, que en este momento no hay una en curso, y ofrece agendar su valoración o dejar sus datos para avisarle de la próxima. Nunca le prometas a alguien un descuento que hoy no puede reclamar.]';
    // La JORNADA ACTIVA tambien va en el chat web: sin esta seccion, las reglas de este
    // canal (que dicen "guiate por la seccion JORNADA ACTIVA de arriba") no encontraban
    // nada y Valeria respondia que NO habia campana aunque estuviera publicada.
    let _bCfg = null, _bDispo = null, _espPau = '';
    try { _espPau = await buildEspPausadasSection(); } catch (e) { console.error('chat web espPau:', e.message); }
    try { _bCfg = await getBeniConfig(); } catch (e) { console.error('chat web beniCfg:', e.message); }
    try { if (_bCfg && _bCfg.publicada === true) _bDispo = await toolConsultarDisponibilidad({}, _bCfg); } catch (e) { console.error('chat web dispo:', e.message); }
    const systemPrompt = SYSTEM_PROMPT + '\n\nFecha actual (Bolivia): ' + fechaBoliviaTexto() + '.' + buildBeniSection(_bCfg, _bDispo) + webNote + _espPau;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 400, system: systemPrompt, messages: norm })
    });
    const data = await response.json();
    if (data.error) {
      console.error('Chat web Claude error:', data.error);
      return res.json({ answer: 'Ahora mismo tengo mucha demanda. Escríbeme por WhatsApp ' + WA + ' y te atiendo enseguida. 💬' });
    }
    const answer = (data.content && data.content[0] && data.content[0].text) || ('Disculpa, no pude procesar tu consulta. Escríbenos por WhatsApp ' + WA + '.');
    res.json({ answer: _fmtSalida(answer, 'web') });
  } catch (e) {
    console.error('/chat:', e);
    res.json({ answer: 'Estamos con mucha demanda ahora. Escríbenos por WhatsApp ' + WA + ' y te atendemos enseguida. 💬' });
  }
});

// ── ENLAZAR CHAT WEB → hilo de WhatsApp por teléfono (Fase 2: continuidad del historial) ──
// La web, al reservar, manda el historial del chat web + el teléfono; lo guardamos bajo wa_<tel>
// SOLO si ese hilo aún no existe, para que la conversación previa aparezca en el panel y el WhatsApp.
app.options('/link-chat-web', (req, res) => { _setChatCors(req, res); res.status(204).end(); });
app.post('/link-chat-web', async (req, res) => {
  _setChatCors(req, res);
  try {
    if (!db) return res.json({ ok: false });
    const b = req.body || {};
    let tel = String(b.tel || '').replace(/\D/g, '');
    if (tel.length === 8) tel = '591' + tel; // local boliviano → internacional
    if (tel.length < 10) return res.json({ ok: false, reason: 'tel' });
    const msgs = (Array.isArray(b.mensajes) ? b.mensajes : []).slice(-20)
      .map(function (m) { return { rol: (m && (m.rol || m.role) === 'user') ? 'user' : 'valeria', texto: String((m && (m.texto || m.content)) || '').slice(0, 2000) }; })
      .filter(function (m) { return m.texto; });
    if (!msgs.length) return res.json({ ok: false, reason: 'vacio' });
    const chatId = 'wa_' + tel;
    const chatRef = db.collection('valeria_chats').doc(chatId);
    const prev = await chatRef.collection('mensajes').limit(1).get();
    if (!prev.empty) return res.json({ ok: false, reason: 'ya_existe' }); // NO pisar una conversación real ya existente
    const base = Date.now() - msgs.length * 1000;
    const batch = db.batch();
    msgs.forEach(function (m, i) {
      const ref = chatRef.collection('mensajes').doc();
      batch.set(ref, { rol: m.rol, texto: m.texto, ts: admin.firestore.Timestamp.fromMillis(base + i * 1000), origenLink: 'web' });
    });
    const meta = { canal: 'wa', contacto: tel, origen: 'chat web (previo a reservar)', ultimaActividad: admin.firestore.FieldValue.serverTimestamp() };
    if (b.nombre) meta.nombre = String(b.nombre).slice(0, 80);
    batch.set(chatRef, meta, { merge: true });
    await batch.commit();
    console.log('🔗 Chat web enlazado a ' + chatId + ' (' + msgs.length + ' msgs)');
    res.json({ ok: true, linked: msgs.length });
  } catch (e) { console.error('/link-chat-web:', e.message); res.json({ ok: false, error: e.message }); }
});

// ── CLASIFICADOR DE TRATAMIENTO → ESPECIALIDAD (para la Agenda Virtual del sitio) ──
// Recibe el texto libre del paciente y devuelve med/fisio/cir/cosm. Si es vago o "no sé" → med.
const _ESPS = {
  med: 'Medicina Estética', fisio: 'Fisio-Estética', cir: 'Cirugías Estéticas', cos: 'Cosmetología'
};
app.options('/clasificar-tratamiento', (req, res) => { _setChatCors(req, res); res.status(204).end(); });
app.post('/clasificar-tratamiento', async (req, res) => {
  _setChatCors(req, res);
  const texto = String((req.body && req.body.texto) || '').trim().slice(0, 500);
  if (!texto || /^\s*(no\s*s[eé]|no\s*lo\s*s[eé]|ninguno|nada|no)\s*$/i.test(texto)) {
    return res.json({ especialidad: 'med', nombre: _ESPS.med, tratamiento: 'Consulta de valoración', motivo: 'default' });
  }
  try {
    const KEY = process.env.ANTHROPIC_API_KEY;
    if (!KEY) return res.json({ especialidad: 'med', nombre: _ESPS.med, tratamiento: texto, motivo: 'sin-ia' });
    const sys = 'Sos el asistente de una clínica médico-estética. Interpretá y CORREGÍ lo que escribe el paciente (aunque tenga errores de ortografía o esté incompleto) y clasificá la especialidad + una descripción bien escrita.\n'
      + 'REGLA DE PRIORIDAD: la PUERTA DE ENTRADA es MEDICINA ESTÉTICA (med). Ante la duda, o si el problema tiene una opción NO quirúrgica, elegí med. Tras la valoración en Medicina Estética el especialista deriva a cirugía si amerita.\n'
      + '- med = Medicina Estética (la MAYORÍA de las consultas): botox, arrugas, rellenos, labios, ojeras, RINOMODELACIÓN (CUALQUIER consulta de la NARIZ que NO diga explícitamente operar/cirugía/rinoplastia), armonización, bioestimuladores, hilos, mesoterapia, MICROPIGMENTACIÓN (cejas, labios, ojos, capilar, paramédica); y TODA reducción de grasa, de medidas o moldeo corporal SIN cirugía (hidrolipoclasia, cavitación, HIFU) y papada.\n'
      + '- cir = Cirugías: SOLO cuando el paciente pide EXPLÍCITAMENTE cirugía o nombra un procedimiento quirúrgico (dice literalmente "operar", "cirugía", "rinoplastia", "liposucción", "lipoescultura", "aumento/implantes de senos", "abdominoplastia", "blefaroplastia"). Si solo menciona la zona o la molestia (ej. "mi nariz", "me molesta la nariz", "bajar la panza"), NO es cirugía: va a med.\n'
      + '- fisio = Fisio-Estética: SOLO celulitis, drenaje linfático, tonificación/flacidez muscular, várices, piernas cansadas, post-operatorio. La reducción de grasa/medidas NO es fisio (es med).\n'
      + '- cos = Cosmetología: SOLO piel/cosmiatría: limpieza facial, peeling, microdermoabrasión, manchas, acné, hidratación.\n'
      + 'Formato EXACTO, sin nada más: codigo|Descripcion (Descripcion = lo que pidió el paciente pero CORREGIDO, interpretado, primera letra en mayúscula; mantené su sentido).\n'
      + 'Ejemplos: "nariz"→med|Rinomodelación ; "me molesta mi nariz"→med|Rinomodelación ; "operarme la nariz"→cir|Rinoplastia ; "grasa en la panza"→med|Reducción de grasa localizada ; "bajar de medidas"→med|Reducción de medidas ; "arrgas"→med|Arrugas ; "celultes"→fisio|Celulitis ; "btox"→med|Botox ; "limpieza de cutis"→cos|Limpieza facial profunda ; "micropigmentacion de cejas"→med|Micropigmentación de cejas ; "aumento de senos"→cir|Aumento de senos.\n'
      + 'SOLO si el texto es completamente incomprensible (letras al azar) o dice "no sé", devolvé: med|Consulta de valoración.';
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 30, system: sys, messages: [{ role: 'user', content: texto }] })
    });
    const data = await r.json();
    const outRaw = String(data.content && data.content[0] && data.content[0].text || '').trim();
    const parts = outRaw.split('|');
    let esp = String(parts[0] || '').toLowerCase().replace(/[^a-z]/g, '');
    if (!_ESPS[esp]) esp = 'med';
    let trat = String(parts[1] || '').trim() || texto;
    res.json({ especialidad: esp, nombre: _ESPS[esp], tratamiento: trat, motivo: 'ia' });
  } catch (e) { res.status(200).json({ especialidad: 'med', nombre: _ESPS.med, tratamiento: texto, motivo: 'error' }); }
});

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

// Lectura de la config de la Jornada Cochabamba (datos públicos de campaña)
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
  res.send('<h1>Política de Privacidad - HARMONIE</h1><p>HARMONIE recopila datos de contacto únicamente para gestionar citas y consultas médico-estéticas. No compartimos información con terceros.</p>');
});

app.get('/terms', (req, res) => {
  res.send('<h1>Términos de Servicio - HARMONIE</h1><p>Al usar nuestros servicios digitales aceptas que tus datos serán usados exclusivamente para gestión de citas en HARMONIE.</p>');
});

// ══════════════════════════════════════════
// RECORDATORIOS AUTOMÁTICOS — Jornada Cochabamba (plantilla WhatsApp aprobada por Meta)
// 24h antes de la cita + el mismo día a partir de las 8:00 AM (hora Bolivia, UTC-4).
// Lee reservas_beni, envía la plantilla y marca el doc para no duplicar.
// ══════════════════════════════════════════
const WA_TEMPLATE_RECORDATORIO = process.env.WA_TEMPLATE_RECORDATORIO || 'recordatorio_jornada_beni';
const WA_TEMPLATE_CONFIRMACION = process.env.WA_TEMPLATE_CONFIRMACION || 'confirmacion_jornada';
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
  const lugar = r.lugar || r.subsede || 'nuestra sede';
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

// Confirmación de reserva al CLIENTE por WhatsApp (plantilla) — impresión profesional inmediata,
// abre el hilo de chat (visible en el panel) y comunica el referido (20%/50%). La plantilla incluye
// el botón "Compartir la jornada". NO se auto-gatea aquí: el watcher decide cuándo llamarla (env CONFIRMACION_ACTIVA).
async function enviarConfirmacionReserva(r) {
  const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
  const PHONE_ID = process.env.WHATSAPP_PHONE_ID;
  if (!WHATSAPP_TOKEN || !PHONE_ID || !r) return false;
  const to = normalizarTelefono(r.telefono);
  if (!to || to.length < 8) return false;
  const cfg = (await getBeniConfig()) || {};
  const dia = ((cfg.dias) || []).find(function (x) { return x.fecha === r.fecha; });
  const diaLabel = (dia && dia.label) || r.fecha || '';
  const sub = ((cfg.subsedes) || []).find(function (s) { return s.id === r.subsede; }) || ((cfg.subsedes) || [])[0] || {};
  const lugar = sub.direccion || r.lugar || r.subsede || 'nuestra sede';
  const nombre = (r.nombre || 'paciente').trim().split(/\s+/)[0];
  const campania = cfg.titulo || 'Jornada Harmonie';
  const slug = cfg.slug || 'cbba';
  const rutaCompartir = 'jornada'; // ruta UNIVERSAL permanente → siempre redirige a la campaña activa (no cambia por campaña)
  // La ZONA del minisitio segun donde se atiende (La Paz vs. las sedes del Beni), para que el
  // enlace del calendario le muestre SUS fechas y no las de la otra punta del pais.
  const _sub = String(r.subsede || r.sede || '').toLowerCase();
  const rutaZona = /san borja|rurrenabaque|reyes|santa rosa/.test(_sub) ? 'beni'
                 : /la paz/.test(_sub) ? 'lapaz'
                 : (cfg.rutaMinisitio || cfg.slug || 'jornada');
  // Antes aqui iba el enlace para COMPARTIR la jornada. Julio (30/08): en este mensaje es mas util
  // el calendario para cambiar la cita — compartir ya tiene su propio boton en la plantilla.
  // El '?agendar=1' abre el calendario directo, sin pasar por la portada.
  const oferta = (cfg.ofertaConfirmacion || 'Con tu reserva ya ganaste 20% de descuento; y si traes a un recomendado que se atienda, obtienes 50% OFF en tu tratamiento.')
    + ' Si necesitas cambiar la fecha u hora, mira el calendario en vivo aqui: https://harmonieinstitute.com/' + rutaZona + '?agendar=1';
  const bodyComp = { type: 'body', parameters: [
    { type: 'text', text: nombre },
    { type: 'text', text: campania },
    { type: 'text', text: diaLabel },
    { type: 'text', text: String(r.hora || '') },
    { type: 'text', text: lugar },
    { type: 'text', text: oferta }
  ] };
  const btnComp = { type: 'button', sub_type: 'url', index: '0', parameters: [ { type: 'text', text: rutaCompartir } ] };
  async function _sendTpl(components) {
    const resp = await fetch(`https://graph.facebook.com/v25.0/${PHONE_ID}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: to, type: 'template', template: { name: WA_TEMPLATE_CONFIRMACION, language: { code: WA_TEMPLATE_LANG }, components: components } })
    });
    return resp.json();
  }
  try {
    // El botón "Compartir la jornada" es ESTÁTICO (URL fija): NO lleva parámetro → enviamos solo el body.
    // Si en el futuro el botón vuelve a ser dinámico, Meta pedirá el parámetro → reintenta CON el botón.
    let data = await _sendTpl([bodyComp]);
    if (data && data.error) {
      console.warn('Confirmacion sin boton fallo, reintento con boton dinamico:', (data.error && data.error.message));
      data = await _sendTpl([bodyComp, btnComp]);
    }
    if (data && data.error) { console.error('Confirmacion API error:', JSON.stringify(data.error)); return false; }
    logMensaje('wa_' + to, 'valeria', '✅ Confirmación de reserva enviada: ' + diaLabel + ' ' + (r.hora || '') + ' · ' + lugar + '.');
    console.log('✅ Confirmación enviada a ' + to + ' (' + nombre + ')');
    return true;
  } catch (e) { console.error('Confirmacion fetch error:', e.message); return false; }
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

// ── SEGUIMIENTO AUTOMÁTICO: re-engancha conversaciones que el cliente dejó SIN agendar ──
// Máx 2 mensajes (a la 1h y a las 8h de silencio), nunca más. Solo dentro de la ventana de 24h en WhatsApp.
// Se ACTIVA con la variable de entorno SEGUIMIENTO_ACTIVO='true' en Railway (apagado por defecto).
function _seguimientoSede(chat, cfg) {
  const o = String((chat && chat.origen) || '').toLowerCase();
  let sede = o.indexOf('cochabamba') !== -1 ? 'Cochabamba' : (o.indexOf('sucre') !== -1 ? 'Sucre' : (o.indexOf('oruro') !== -1 ? 'Oruro' : ''));
  if (sede) { // solo menciona la sede si su jornada aún tiene días vigentes; si ya terminó, mensaje general
    const hoy = fechaBoliviaISO();
    const vig = ((cfg && cfg.dias) || []).some(function (d) { return d.subsede === sede && d.fecha >= hoy; });
    if (!vig) sede = '';
  }
  return sede;
}
function _seguimientoMsg(n, chat, cfg) {
  const sede = _seguimientoSede(chat, cfg);
  const enSede = sede ? (' en ' + sede) : '';
  const nombre = (chat && chat.nombre) ? (' ' + String(chat.nombre).split(' ')[0]) : '';
  return n === 0
    ? '¡Hola' + nombre + '! 😊 Quedé pendiente de ayudarte con tu cita' + enSede + '. ¿Retomamos? Tengo cupos disponibles. ¿Te muestro los horarios?'
    : '¡Hola de nuevo! Solo para avisarte que la promo por traer un recomendado sigue disponible' + enSede + '. Si quieres, te aparto un cupo hoy. 💛';
}
async function _enviarPorCanal(chatId, msg) {
  const canal = chatId.split('_')[0];
  const contacto = chatId.split('_').slice(1).join('_');
  if (canal === 'wa') await waSend(contacto, msg);
  else if (canal === 'fb') await fbSend(contacto, msg);
  else if (canal === 'ig') await igSend(contacto, msg);
  else if (canal === 'tg') await bot.sendMessage(contacto, _fmtSalida(msg, 'tg'));
  else throw new Error('canal no soportado: ' + canal);
}
async function correrSeguimientos(dryRun, ignoraTiempo) {
  if (!db) return [];
  if (!dryRun && process.env.SEGUIMIENTO_ACTIVO !== 'true') return []; // envío real solo si está activo; el dry-run corre igual
  if (!dryRun) { const _hBol = new Date(Date.now() - 4 * 3600 * 1000).getUTCHours(); if (_hBol < 7 || _hBol >= 23) return []; } // horario de silencio 23:00–07:00
  const candidatos = [];
  try {
    const cfg = await getBeniConfig();
    if (!cfg || cfg.publicada !== true) return candidatos; // solo durante campaña activa
    const ahora = Date.now();
    const H1 = 60 * 60 * 1000, H8 = 8 * 60 * 60 * 1000, H24 = 24 * 60 * 60 * 1000;
    // Teléfonos con reserva CONFIRMADA en ESTA campaña (por fecha) — NO se cuentan reservas de campañas pasadas/otras sedes.
    const fechasCampana = new Set(((cfg.dias) || []).map(function (d) { return d.fecha; }));
    const telsReservados = new Set();
    try {
      const rs = await db.collection('reservas_beni').where('jornadaId', '==', 'beni').get();
      rs.forEach(function (doc) {
        const r = doc.data() || {};
        if ((r.estado || 'confirmada') !== 'confirmada') return;
        if (!fechasCampana.has(r.fecha)) return; // solo reservas de la campaña vigente (independiente de las pasadas)
        const rt = String(r.telefono || '').replace(/\D/g, '').slice(-8);
        if (rt) telsReservados.add(rt);
      });
    } catch (e) { console.error('seguimiento reservas read:', e.message); }
    const snap = await db.collection('valeria_chats').where('ultimoRol', '==', 'valeria').get();
    for (const doc of snap.docs) {
      const c = doc.data() || {};
      const userId = doc.id;
      try {
        // Salvaguardas: ya agendó por chat EN ESTA campaña, marcado "no seguir", lo atiende un humano/pausado.
        if ((c.reservoOk && c.reservoCampaign === cfg.campaignVersion) || c.noSeguir === true || c.pausada === true || c.necesitaHumano === true) continue;
        const count = c.seguimientoCount || 0;
        if (count >= 2) continue;                                       // ya se enviaron los 2
        if ((c.totalMensajes || 0) < 4) continue;                       // solo conversaciones con interés real (no un "hola" suelto)
        const lastUser = (c.lastUserMsgAt && c.lastUserMsgAt.toMillis) ? c.lastUserMsgAt.toMillis() : null;
        if (!lastUser) continue;
        const silencio = ahora - lastUser;
        const canal = (userId.split('_')[0]) || 'chat';
        const contacto = userId.split('_').slice(1).join('_');
        // Cruce contra reservas reales por teléfono (sirve para WhatsApp): si ya agendó por CUALQUIER vía, no lo molestes.
        const tel8 = String(contacto).replace(/\D/g, '').slice(-8);
        if (tel8 && tel8.length >= 6 && telsReservados.has(tel8)) continue;
        if (canal === 'wa' && silencio >= H24) continue;                // fuera de la ventana de 24h de WhatsApp
        if (!ignoraTiempo && !((count === 0 && silencio >= H1) || (count === 1 && silencio >= H8))) continue;
        if (dryRun) { candidatos.push({ chat: userId, nombre: c.nombre || '', seguimientoNro: count + 1, silencioHrs: Math.round(silencio / 3600000 * 10) / 10, msgs: c.totalMensajes || 0, sede: _seguimientoSede(c, cfg) || '-' }); continue; }
        const msg = _seguimientoMsg(count, c, cfg);
        await _enviarPorCanal(userId, msg);
        logMensaje(userId, 'valeria', msg);
        await doc.ref.update({ seguimientoCount: count + 1, seguimientoLastAt: admin.firestore.FieldValue.serverTimestamp() });
        console.log('🔁 Seguimiento ' + (count + 1) + ' → ' + userId);
      } catch (e) { console.error('seguimiento ' + userId + ':', e.message); }
    }
  } catch (e) { console.error('correrSeguimientos:', e.message); }
  return candidatos;
}

// Arranca a los 30s y luego cada 20 minutos
if (db) {
  // ⛔ DESACTIVADO: recordatorio por PLANTILLA de Meta 'recordatorio_jornada_beni' — su texto fijo
  // dice "Jornada Beni de ARMONNIZA" (marca vieja + campaña equivocada) y confunde. Lo reemplaza el
  // watcher de recordatorios de texto libre (revisarRecordatoriosConfirmar: 8h + 2h antes, marca "Harmonie").
  // Para reactivarlo hace falta una PLANTILLA nueva aprobada en Meta y setear WA_TEMPLATE_RECORDATORIO.
  // setTimeout(correrRecordatorios, 30000);
  // setInterval(correrRecordatorios, 20 * 60 * 1000);
  setTimeout(correrSeguimientos, 60000);
  setInterval(correrSeguimientos, 60 * 60 * 1000);
}

// Disparo manual para probar (no reenvía los ya marcados)
app.get('/run-recordatorios', async (req, res) => {
  await correrRecordatorios();
  res.json({ ok: true, ts: new Date().toISOString() });
});

// PRUEBA de la plantilla de confirmación (envía UNA, sin importar el flag CONFIRMACION_ACTIVA):
// /debug/test-confirmacion?key=diag-9x&tel=76xxxxxx&nombre=Maria&fecha=2026-08-20&hora=15:00
app.get('/debug/test-confirmacion', async (req, res) => {
  if (req.query.key !== 'diag-9x') return res.status(403).json({ error: 'no' });
  const r = { telefono: req.query.tel || '', nombre: req.query.nombre || 'María', fecha: req.query.fecha || '', hora: req.query.hora || '15:00', subsede: req.query.lugar || 'Cochabamba' };
  const ok = await enviarConfirmacionReserva(r);
  res.json({ ok: ok, template: WA_TEMPLATE_CONFIRMACION, lang: WA_TEMPLATE_LANG, to: normalizarTelefono(r.telefono) });
});

// INSPECCIÓN de una plantilla (para diagnosticar el botón): /debug/tpl?key=diag-9x[&name=confirmacion_jornada]
app.get('/debug/tpl', async (req, res) => {
  if (req.query.key !== 'diag-9x') return res.status(403).json({ error: 'no' });
  const TOKEN = process.env.WHATSAPP_TOKEN, WABA = process.env.WHATSAPP_WABA_ID;
  if (!TOKEN || !WABA) return res.json({ error: 'faltan WHATSAPP_TOKEN/WHATSAPP_WABA_ID' });
  const name = req.query.name || 'confirmacion_jornada';
  try {
    const r = await fetch(`https://graph.facebook.com/v25.0/${WABA}/message_templates?name=${encodeURIComponent(name)}&fields=name,status,components`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    res.json(await r.json());
  } catch (e) { res.json({ error: e.message }); }
});

// SIMULACIÓN (dry-run) del seguimiento: muestra a QUIÉNES les escribiría AHORA, SIN enviar nada. Para revisar antes de activar.
app.get('/dry-seguimiento', async (req, res) => {
  try {
    const list = await correrSeguimientos(true, req.query.ignoraTiempo === '1');
    res.json({ total: list.length, activo: process.env.SEGUIMIENTO_ACTIVO === 'true', ignoraTiempo: req.query.ignoraTiempo === '1', candidatos: list });
  } catch (e) { res.status(200).json({ error: e.message }); }
});

// PRUEBA del seguimiento: GET /test-seguimiento?chat=wa_59176XXXXXXX&n=1  (n=1 primer mensaje, n=2 segundo)
// Envía el mensaje de seguimiento a ese chat AHORA (ignora tiempos y el flag), para verificar entrega/texto.
app.get('/test-seguimiento', async (req, res) => {
  const chatId = String(req.query.chat || '').trim();
  const n = req.query.n === '2' ? 1 : 0;
  if (!chatId || chatId.indexOf('_') === -1) return res.status(400).json({ error: 'falta ?chat=CANAL_CONTACTO (ej: wa_59176951552 o tg_123456789)' });
  try {
    const cfg = await getBeniConfig();
    let c = {};
    try { const s = await db.collection('valeria_chats').doc(chatId).get(); if (s.exists) c = s.data() || {}; } catch (e) {}
    const msg = _seguimientoMsg(n, c, cfg);
    await _enviarPorCanal(chatId, msg);
    res.json({ ok: true, chat: chatId, n: n + 1, enviado: msg });
  } catch (e) { res.status(200).json({ error: e.message }); }
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
            { type: 'text', text: 'sábado 27 de junio' },
            { type: 'text', text: '10:00' },
            { type: 'text', text: 'Cochabamba — Beauty Clinic' }
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
      else if (name === 'buscar_reserva_beni') result = await toolBuscarReserva(args);
      else if (name === 'cancelar_reserva_beni') result = await toolCancelarReserva(args, cfg);
      else if (name === 'reagendar_reserva_beni') result = await toolReagendarReserva(args, cfg);
      else if (name === 'consultar_disponibilidad_sede') result = await toolConsultarDisponibilidadSede(args);
      else if (name === 'crear_cita') result = await toolCrearCita(args, 'voz');
      else if (name === 'buscar_cita') result = await toolBuscarCita(args);
      else if (name === 'cancelar_cita') result = await toolCancelarCita(args);
      else if (name === 'reagendar_cita') result = await toolReagendarCita(args);
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
    const r = await toolCrearReserva(req.body || {}, cfg, 'voz', (req.body && (req.body.telefono_origen || req.body.numero_llamada)) || '');
    console.log('📞 [Vapi reservar] resp:', JSON.stringify(r).substring(0, 200));
    res.json(r);
  } catch (e) { console.error('/beni/reservar:', e.message); res.status(200).json({ error: 'No pude crear la reserva ahora.' }); }
});
app.post('/beni/buscar', async (req, res) => {
  console.log('📞 [Vapi buscar] body:', JSON.stringify(req.body || {}));
  try {
    const r = await toolBuscarReserva(req.body || {});
    res.json(r);
  } catch (e) { console.error('/beni/buscar:', e.message); res.status(200).json({ error: 'No pude buscar la reserva ahora.' }); }
});
app.post('/beni/cancelar', async (req, res) => {
  console.log('📞 [Vapi cancelar] body:', JSON.stringify(req.body || {}));
  try {
    const cfg = await getBeniConfig();
    const r = await toolCancelarReserva(req.body || {}, cfg);
    console.log('📞 [Vapi cancelar] resp:', JSON.stringify(r).substring(0, 200));
    res.json(r);
  } catch (e) { console.error('/beni/cancelar:', e.message); res.status(200).json({ error: 'No pude cancelar la reserva ahora.' }); }
});
app.post('/beni/reagendar', async (req, res) => {
  console.log('📞 [Vapi reagendar] body:', JSON.stringify(req.body || {}));
  try {
    const cfg = await getBeniConfig();
    const r = await toolReagendarReserva(req.body || {}, cfg);
    console.log('📞 [Vapi reagendar] resp:', JSON.stringify(r).substring(0, 200));
    res.json(r);
  } catch (e) { console.error('/beni/reagendar:', e.message); res.status(200).json({ error: 'No pude reagendar la reserva ahora.' }); }
});

// ── CITAS GENERALES (Fase 2) — endpoints REST para Vapi (tipo "Solicitud de API") ──
app.post('/cita/disponibilidad', async (req, res) => {
  console.log('📞 [Vapi cita/disponibilidad] body:', JSON.stringify(req.body || {}));
  try { const r = await toolConsultarDisponibilidadSede(req.body || {}); console.log('📞 resp:', JSON.stringify(r).substring(0,200)); res.json(r); }
  catch (e) { console.error('/cita/disponibilidad:', e.message); res.status(200).json({ error: 'No pude consultar la agenda ahora.' }); }
});
app.post('/cita/crear', async (req, res) => {
  console.log('📞 [Vapi cita/crear] body:', JSON.stringify(req.body || {}));
  try { const r = await toolCrearCita(req.body || {}, 'voz'); console.log('📞 resp:', JSON.stringify(r).substring(0,200)); res.json(r); }
  catch (e) { console.error('/cita/crear:', e.message); res.status(200).json({ error: 'No pude crear la cita ahora.' }); }
});
app.post('/cita/buscar', async (req, res) => {
  try { res.json(await toolBuscarCita(req.body || {})); }
  catch (e) { console.error('/cita/buscar:', e.message); res.status(200).json({ error: 'No pude buscar la cita ahora.' }); }
});
app.post('/cita/cancelar', async (req, res) => {
  console.log('📞 [Vapi cita/cancelar] body:', JSON.stringify(req.body || {}));
  try { res.json(await toolCancelarCita(req.body || {})); }
  catch (e) { console.error('/cita/cancelar:', e.message); res.status(200).json({ error: 'No pude cancelar la cita ahora.' }); }
});
app.post('/cita/reagendar', async (req, res) => {
  console.log('📞 [Vapi cita/reagendar] body:', JSON.stringify(req.body || {}));
  try { res.json(await toolReagendarCita(req.body || {})); }
  catch (e) { console.error('/cita/reagendar:', e.message); res.status(200).json({ error: 'No pude reagendar la cita ahora.' }); }
});

// ── Google Calendar: estado (email para compartir el calendario) + disponibilidad ──
app.get('/gcal/status', async (req, res) => {
  res.json({ ok: !!gcalAuth, compartirCalendarioCon: gcalEmail || '(sin cuenta de servicio)', citasCalendarId: await getCitasCalendarId() });
});
app.get('/gcal/busy', async (req, res) => {
  try {
    const { calendarId, date } = req.query;
    if (!calendarId || !date) return res.status(400).json({ error: 'calendarId y date requeridos' });
    res.json({ date: date, calendarId: calendarId, busyHoras: await gcalBusyHoras(calendarId, date) });
  } catch (e) { res.status(200).json({ busyHoras: [] }); }
});
// Disponibilidad para el SITIO (navegador): horarios ocupados reales (24h) de una sede/plataforma + fecha.
// Fuente única de verdad = la colección 'citas'. Se normaliza a 24h para que el sitio compare sin ambigüedad.
app.options('/disponibilidad', (req, res) => { _setChatCors(req, res); res.status(204).end(); });
app.get('/disponibilidad', async (req, res) => {
  _setChatCors(req, res);
  try {
    const especialidad = String(req.query.especialidad || '').trim();
    const sede = String(req.query.sede || '').trim();
    const fecha = String(req.query.fecha || '').trim();
    if (!fecha || (!especialidad && !sede)) return res.status(400).json({ error: 'especialidad (o sede) + fecha requeridos' });
    // Intervalos ocupados {i:'HH:MM', m:min}. Por especialidad cruza citas (presencial+virtual) + campaña; si no, por-sede.
    const ocupados = especialidad
      ? (await citasOcupEsp(especialidad, fecha)).concat(await reservasBeniOcupEsp(especialidad, fecha))
      : await citasOcupSede(sede, fecha);
    // Compat: lista de horas de inicio (por si algún cliente viejo la usa).
    const ocupadas = ocupados.map(function (o) { return o.i; }).filter(function (h, i, a) { return h && a.indexOf(h) === i; });
    res.json({ especialidad: especialidad || null, sede: sede || null, fecha: fecha, ocupados: ocupados, ocupadas: ocupadas });
  } catch (e) { res.status(200).json({ ocupadas: [] }); }
});
// ── NOTIFICACIÓN DE NUEVAS RESERVAS (web + Valeria) al equipo ──
// reservas_beni la usan TANTO la web como Valeria (chat/voz), así que un solo watcher las capta todas.
function notificarNuevaReserva(r) {
  if (!r) return;
  const txt = '🗓️ NUEVA RESERVA (jornada)\n'
    + '👤 ' + (r.nombre || '(sin nombre)') + '\n'
    + '📞 ' + (r.telefono || '-') + '\n'
    + '📍 ' + (r.subsede || r.lugar || '-') + '\n'
    + '📅 ' + (r.fecha || '-') + ' · ' + (r.hora || '-') + '\n'
    + (r.notas ? ('💬 ' + r.notas + '\n') : '')
    + '🔗 Por: ' + (r.canal === 'voz' ? 'llamada de voz' : (r.canal && r.canal !== 'chat' ? r.canal : 'web/chat'));
  // WhatsApp al equipo (78922666). Nota: si no hay ventana de 24h, Meta puede rechazarlo.
  waSend(ADMIN_WHATSAPP, txt).catch(function(e){ console.error('notif reserva WA:', e.message); });
  // Telegram (respaldo confiable si el admin está registrado con /admin)
  getAdminTelegram().then(function(adm){ if (adm) bot.sendMessage(adm, txt).catch(function(){}); }).catch(function(){});
  console.log('🗓️ Notificada nueva reserva: ' + (r.nombre || '?') + ' ' + (r.fecha || '') + ' ' + (r.hora || ''));
}

// Marca reservoOk en el/los chat(s) de quien reservó (por chatId y por wa_<tel>), venga la reserva
// de la web, chat o voz → el SEGUIMIENTO automático deja de insistirle (ya reservó; solo le tocan recordatorios).
async function _marcarReservoOk(r) {
  if (!db || !r) return;
  try {
    const cfg = await getBeniConfig();
    const ver = (cfg && cfg.campaignVersion) || '';
    const ids = [];
    if (r.chatId) ids.push(String(r.chatId));
    let tel = String(r.telefono || '').replace(/\D/g, '');
    if (tel.length === 8) tel = '591' + tel; // local boliviano → internacional
    if (tel.length >= 10) ids.push('wa_' + tel);
    ids.forEach(function (id) {
      // update (no set): solo marca chats que YA existen; no crea docs vacíos para reservas web sin chat.
      db.collection('valeria_chats').doc(id).update({ reservoOk: true, reservoCampaign: ver }).catch(function () {});
    });
  } catch (e) { console.error('_marcarReservoOk:', e.message); }
}

function iniciarWatcherReservas() {
  if (!db) { console.warn('⚠️ Watcher de reservas inactivo (sin Firestore)'); return; }
  let init = false;
  db.collection('reservas_beni').onSnapshot(function(snap) {
    if (init && snap.docChanges().length) _invalidarCachesReservas(); // cualquier cambio (bot o web) refresca cachés de reservas/cupos
    snap.docChanges().forEach(function(ch) {
      if (ch.type !== 'added') return;
      const r = ch.doc.data();
      _marcarReservoOk(r); // marca "ya reservó" en su chat → el seguimiento no le insiste (backfill + nuevas)
      if (!init) return; // las que ya existían al arrancar: solo backfill, sin re-notificar al equipo
      notificarNuevaReserva(r);
      // Confirmación al cliente por WhatsApp (solo web/voz; los de chat ya recibieron el saludo+referido de Valeria).
      if (process.env.CONFIRMACION_ACTIVA === 'true' && (!r.canal || r.canal === 'voz')) enviarConfirmacionReserva(r).catch(function () {});
    });
    init = true;
  }, function(err) { console.error('watcher reservas_beni:', err.message); });
  console.log('👀 Watcher de reservas activo → avisa a WhatsApp ' + ADMIN_WHATSAPP + ' + Telegram');
}

// CATCH-UP: responde a los chats que quedaron SIN RESPUESTA dentro de las últimas 24h
// (por defecto DRY: solo lista; con &send=1 envía). GET /debug/catchup?key=diag-9x[&send=1][&horas=24]
app.get('/debug/catchup', async (req, res) => {
  if (req.query.key !== 'diag-9x') return res.status(403).json({ error: 'no' });
  if (!db) return res.json({ error: 'no db' });
  const dry = req.query.send !== '1';
  const horas = Math.min(parseInt(req.query.horas || '24', 10) || 24, 24); // nunca más de 24h (regla WhatsApp)
  const desde = admin.firestore.Timestamp.fromMillis(Date.now() - horas * 60 * 60 * 1000);
  const MSG = '¡Hola! 😊 Disculpá la demora en responderte, ya estoy acá para ayudarte 💛 ¿En qué te ayudo? Contame qué tratamiento te interesa y te ayudo a agendar tu cita.';
  try {
    const EXCLUIR = ['wa_59178922666', 'wa_59176951552']; // números internos (notificaciones/reservas), NO son leads
    const snap = await db.collection('valeria_chats').where('lastUserMsgAt', '>=', desde).get();
    const items = [];
    for (const d of snap.docs) {
      const c = d.data() || {};
      if (c.ultimoRol !== 'user') continue; // solo los SIN respuesta (el último que habló fue el cliente)
      if (EXCLUIR.includes(d.id)) continue; // saltar números internos
      const item = { userId: d.id, canal: c.canal || null, nombre: c.nombre || null, origen: c.origen || null, ultimoTexto: String(c.ultimoTexto || '').slice(0, 80) };
      if (!dry) {
        try { await _enviarPorCanal(d.id, MSG); logMensaje(d.id, 'valeria', MSG); item.enviado = true; }
        catch (e) { item.enviado = false; item.error = String((e && e.message) || e); }
      }
      items.push(item);
    }
    res.json({ dry: dry, horas: horas, total: items.length, items: items });
  } catch (e) { res.json({ error: String((e && e.message) || e) }); }
});

// DIAGNÓSTICO (solo lectura): cuenta los estados de las reservas para saber a quién alcanzamos.
// GET /debug/estados-reservas?key=diag-9x
// Diagnostico de RECORDATORIOS: por cada cita vigente, cuantas horas faltan y que
// avisos se enviaron ya. Sirve para ver de un vistazo cual quedo sin recordatorio.
// GET /debug/recordatorios?key=diag-9x
// REENGANCHE de leads calientes: escribe SOLO a quien nos escribió hace menos de 24h
// (ventana de WhatsApp abierta, sin necesidad de plantilla), no reservó, no pidió que
// no le insistan y NO recibió ya un reenganche. Ofrece horas REALES del día indicado.
// DRY por defecto: sin &send=1 solo dice a quién le escribiría y con qué texto.
// GET /debug/reenganche?key=diag-9x&fecha=2026-09-01[&send=1]
// Envía una PLANTILLA de Meta a los leads de una zona cuya ventana de 24h ya cerró
// (los de una jornada anterior). Es la única forma de alcanzarlos: el texto libre lo
// rechaza WhatsApp pasadas las 24h desde su último mensaje.
// GET /debug/plantilla-zona?key=diag-9x&plantilla=jornada_beni_septiembre&zona=beni[&send=1]
app.get('/debug/plantilla-zona', async (req, res) => {
  if (req.query.key !== 'diag-9x') return res.status(403).json({ error: 'no' });
  if (!db) return res.status(200).json({ error: 'sin db' });
  const enviar = req.query.send === '1';
  const plantilla = String(req.query.plantilla || '').trim();
  if (!plantilla) return res.status(200).json({ error: 'falta ?plantilla=nombre_de_la_plantilla' });
  const zona = String(req.query.zona || 'beni').toLowerCase();
  const cfg = await getBeniConfig();

  // Las sedes de esa zona y sus días vigentes → el texto de la variable {{2}}.
  const SEDES = zona === 'beni' ? ['San Borja', 'Rurrenabaque']
            : zona === 'lapaz' ? ['La Paz']
            : ((cfg.subsedes || []).map(function (x) { return x.id; }));
  const hoyISO = fechaBoliviaISO();
  const dias = (cfg.dias || []).filter(function (d) { return SEDES.indexOf(d.subsede) !== -1 && d.fecha >= hoyISO; });
  if (!dias.length) return res.status(200).json({ error: 'esa zona no tiene días vigentes en la jornada' });
  const porSede = {};
  dias.forEach(function (d) { (porSede[d.subsede] = porSede[d.subsede] || []).push(d.label || d.fecha); });
  const partes = Object.keys(porSede).map(function (sede) {
    const ls = porSede[sede].map(function (l) { return String(l).toLowerCase(); });
    return sede + ' el ' + (ls.length === 1 ? ls[0] : (ls.slice(0, -1).join(', ') + ' y ' + ls[ls.length - 1]));
  });
  const cuando = req.query.texto ? String(req.query.texto) : partes.join(', y ');

  // A quién: conversó sobre esa zona, no reservó, no pidió que no le insistan.
  const PISTAS = zona === 'beni' ? ['rurrenabaque', 'rurre', 'san borja', 'sanborja', 'yucumo', 'reyes', 'santa ana', 'trinidad'] : SEDES.map(function (x) { return x.toLowerCase(); });
  const conReserva = new Set();
  (await getReservasConfirmadas()).forEach(function (r) {
    if ((r.fecha || '') >= hoyISO) { const t = String(r.telefono || '').replace(/\D/g, '').slice(-8); if (t) conReserva.add(t); }
  });

  const elegidos = [], descartados = { ya_reservo: 0, no_seguir: 0, sin_pista: 0, ventana_abierta: 0, ya_enviado: 0 };
  const ahora = Date.now();
  const chats = await db.collection('valeria_chats').get();
  for (const d of chats.docs) {
    const c = d.data() || {};
    if (String(c.canal || '') !== 'wa') continue;
    const tel8 = String(c.contacto || '').replace(/\D/g, '').slice(-8);
    if (!tel8 || tel8 === '78922666' || tel8 === '76951552') continue;
    if (c.noSeguir === true) { descartados.no_seguir++; continue; }
    if (conReserva.has(tel8)) { descartados.ya_reservo++; continue; }
    if (c.plantillaZonaAt) { descartados.ya_enviado++; continue; }
    const lu = c.lastUserMsgAt && c.lastUserMsgAt.toDate ? c.lastUserMsgAt.toDate() : null;
    const horas = lu ? (ahora - lu.getTime()) / 3600000 : 9999;
    // Si la ventana sigue abierta no hace falta plantilla: para esos está /debug/reenganche.
    if (horas < 22) { descartados.ventana_abierta++; continue; }
    let blob = String(c.origen || '') + ' ' + String(c.ultimoTexto || '');
    try {
      const ms = await d.ref.collection('mensajes').orderBy('ts', 'desc').limit(25).get();
      ms.forEach(function (m) { blob += ' ' + String((m.data() || {}).texto || ''); });
    } catch (e) {}
    blob = blob.toLowerCase();
    if (!PISTAS.some(function (p) { return blob.indexOf(p) !== -1; })) { descartados.sin_pista++; continue; }
    // ⚠️ Ojo: a la gente de la campaña ACTUAL Valeria le nombra las tres sedes, así que su
    // chat contiene "Rurrenabaque" sin ser del Beni. Se distingue por el ORIGEN del anuncio.
    const _org = String(c.origen || '').toLowerCase();
    const _esDeLaZona = PISTAS.some(function (p) { return _org.indexOf(p) !== -1; });
    const _esDeOtraCiudad = /la paz|cochabamba|oruro|sucre|santa cruz|potos/.test(_org);
    if (_esDeOtraCiudad && !_esDeLaZona) { descartados.otra_ciudad = (descartados.otra_ciudad || 0) + 1; continue; }
    // Y los de la jornada anterior son los ANTIGUOS: si escribió hace pocos días es de la actual.
    if (horas < 24 * 30 && !_esDeLaZona) { descartados.reciente_otra_campana = (descartados.reciente_otra_campana || 0) + 1; continue; }
    const nom = String(c.nombre || '').trim().split(/\s+/)[0].replace(/[^A-Za-zÁÉÍÓÚáéíóúÑñ]/g, '');
    // Los nombres de perfil de WhatsApp a veces no son nombres ("la", "yo", "vr"):
    // con menos de 3 letras saldría "Hola yo 💛", que queda peor que no nombrarla.
    const nomOk = (nom.length >= 3) ? (nom[0].toUpperCase() + nom.slice(1).toLowerCase()) : '';
    elegidos.push({ chatId: d.id, tel: c.contacto, nombre: nomOk, dias: Math.round(horas / 24) });
  }

  const TOKEN = process.env.WHATSAPP_TOKEN, PHONE = process.env.WHATSAPP_PHONE_ID;
  let enviados = 0, fallidos = 0;
  for (const e of elegidos) {
    e.saludo = e.nombre || '¿cómo estás?';
    if (!enviar) continue;
    try {
      const resp = await fetch('https://graph.facebook.com/v25.0/' + PHONE + '/messages', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp', to: normalizarTelefono(e.tel), type: 'template',
          template: {
            name: plantilla, language: { code: WA_TEMPLATE_LANG },
            components: [{ type: 'body', parameters: [
              { type: 'text', text: e.saludo },
              { type: 'text', text: cuando }
            ] }]
          }
        })
      });
      const data = await resp.json();
      if (data && data.error) {
        fallidos++;
        e.error = data.error.message || data.error.code || 'desconocido';
      } else {
        enviados++;
        db.collection('valeria_chats').doc(e.chatId).set({ plantillaZonaAt: new Date() }, { merge: true }).catch(function () {});
      }
    } catch (err) { fallidos++; e.error = err.message; }
  }

  res.json({
    modo: enviar ? 'ENVIADO' : 'SIMULACRO (agrega &send=1 para enviar de verdad)',
    plantilla: plantilla, zona: zona, variable_2: cuando,
    a_quienes: elegidos.length, enviados: enviados, fallidos: fallidos,
    descartados: descartados, detalle: elegidos
  });
});

app.get('/debug/reenganche', async (req, res) => {
  if (req.query.key !== 'diag-9x') return res.status(403).json({ error: 'no' });
  if (!db) return res.status(200).json({ error: 'sin db' });
  const enviar = req.query.send === '1';
  const fecha = String(req.query.fecha || '').trim();
  if (!fecha) return res.status(200).json({ error: 'falta ?fecha=AAAA-MM-DD' });
  const cfg = await getBeniConfig();
  const dia = ((cfg && cfg.dias) || []).find(function (x) { return x.fecha === fecha; });
  if (!dia) return res.status(200).json({ error: 'esa fecha no es un día de la jornada' });

  // Horas REALMENTE libres de ese día (las mismas que ve Valeria).
  const dispo = await toolConsultarDisponibilidad({ fecha: fecha }, cfg);
  const entry = ((dispo && dispo.disponibilidad) || []).find(function (r) { return r.fecha === fecha; });
  const libres = (entry && entry.horas_libres) || [];
  if (!libres.length) return res.status(200).json({ error: 'ese día ya no tiene horas libres' });
  const tres = libres.slice(0, 3).join(', ');

  // Ya recibieron un reenganche antes: no se les insiste otra vez.
  const YA_INSISTIDO = ['quedé pendiente de ayudarte', 'hola de nuevo', 'solo para avisarte'];
  const hoyISO = fechaBoliviaISO();
  const conReserva = new Set();
  (await getReservasConfirmadas()).forEach(function (r) {
    if ((r.fecha || '') >= hoyISO) { const t = String(r.telefono || '').replace(/\D/g, '').slice(-8); if (t) conReserva.add(t); }
  });

  const ahora = Date.now();
  const elegidos = [], descartados = { fuera_ventana: 0, ya_reservo: 0, no_seguir: 0, ya_insistido: 0, pausado: 0 };
  const chats = await db.collection('valeria_chats').get();
  for (const d of chats.docs) {
    const c = d.data() || {};
    if (String(c.canal || '') !== 'wa') continue;              // solo WhatsApp: su ventana es la que sabemos leer
    const tel8 = String(c.contacto || '').replace(/\D/g, '').slice(-8);
    if (!tel8 || tel8 === '78922666' || tel8 === '76951552') continue;
    if (c.noSeguir === true) { descartados.no_seguir++; continue; }
    if (c.pausada === true) { descartados.pausado++; continue; }
    if (conReserva.has(tel8)) { descartados.ya_reservo++; continue; }
    const lu = c.lastUserMsgAt && c.lastUserMsgAt.toDate ? c.lastUserMsgAt.toDate() : null;
    const horas = lu ? (ahora - lu.getTime()) / 3600000 : 999;
    if (horas >= 22) { descartados.fuera_ventana++; continue; }  // margen: a las 24h se cierra
    if (c.reenganchadoAt) { descartados.ya_insistido++; continue; }
    const ult = String(c.ultimoTexto || '').toLowerCase();
    if (YA_INSISTIDO.some(function (p) { return ult.indexOf(p) !== -1; })) { descartados.ya_insistido++; continue; }
    elegidos.push({ chatId: d.id, tel: c.contacto, nombre: String(c.nombre || '').split(/\s+/)[0], horas: Math.round(horas) });
  }

  const _lbl = (dia.label || fecha);
  let enviados = 0, fallidos = 0;
  for (const e of elegidos) {
    const saludo = (e.nombre && !/^[\d\W]+$/.test(e.nombre)) ? ('Hola ' + e.nombre + ' 💛') : 'Hola 💛';
    const texto = saludo + ' Te escribo de Harmonie. Para ' + _lbl.toLowerCase() + ' todavía me quedan horas libres en la jornada de ' + (dia.subsede || '') + ': ' + tres + '. La valoración es gratis y con tu reserva ya ganas el 20% de descuento. ¿Te agendo una?';
    e.mensaje = texto;
    if (!enviar) continue;
    const r = await waSend(e.tel, texto);
    if (r && !r.error) {
      enviados++;
      logMensaje(e.chatId, 'valeria', texto);
      try { await cargarHistorialSiVacio(e.chatId); addToHistory(e.chatId, 'assistant', texto); } catch (_) {}
      db.collection('valeria_chats').doc(e.chatId).set({ reenganchadoAt: new Date() }, { merge: true }).catch(function () {});
    } else {
      fallidos++;
      e.error = (r && r.error && (r.error.message || r.error.code)) || 'desconocido';
    }
  }

  res.json({
    modo: enviar ? 'ENVIADO' : 'SIMULACRO (agrega &send=1 para enviar de verdad)',
    dia: _lbl, sede: dia.subsede, horas_ofrecidas: tres,
    a_quienes: elegidos.length, enviados: enviados, fallidos: fallidos,
    descartados: descartados, detalle: elegidos
  });
});

app.get('/debug/recordatorios', async (req, res) => {
  if (req.query.key !== 'diag-9x') return res.status(403).json({ error: 'no' });
  if (!db) return res.status(200).json({ error: 'sin db' });
  const ahora = Date.now();
  const hBol = new Date(ahora - 4 * 3600 * 1000).getUTCHours();
  const filas = [];
  try {
    for (const col of ['reservas_beni', 'citas']) {
      const snap = await db.collection(col).where('estado', '==', 'confirmada').get();
      snap.docs.forEach(function (d) {
        const c = d.data() || {};
        if (!c.fecha || !c.hora) return;
        const ms = Date.parse(c.fecha + 'T' + (String(c.hora).length === 5 ? c.hora : ('0' + c.hora)) + ':00-04:00');
        if (isNaN(ms)) return;
        const hf = (ms - ahora) / 3600000;
        if (hf <= -6) return; // ya muy pasadas
        filas.push({
          id: d.id, col: col,
          nombre: String(c.nombre || '').split(/\s+/)[0],
          tel: String(c.telefono || '').replace(/\D/g, ''),
          cuando: c.fecha + ' ' + c.hora,
          horas_falta: Math.round(hf * 10) / 10,
          virtual: c.modalidad === 'virtual',
          av20h: !!c.recordatorio20hAt, av8h: !!c.recordatorioConfirmarAt, av2h: !!c.recordatorio2hAt,
          canal: c.canal || '',
          intentos: c.recordatorioIntentos || 0,
          ultimoError: c.recordatorioUltimoError || '',
          equipoAvisado: !!c.recordatorioAvisoEquipoAt,
          chatId: c.chatId || '',
          telPropio: _esTelefonoPropio(c.telefono)
        });
      });
    }
  } catch (e) { return res.status(200).json({ error: e.message }); }
  filas.sort(function (a, b) { return a.horas_falta - b.horas_falta; });
  const faltantes = filas.filter(function (f) {
    return !f.virtual && f.horas_falta > 0 && (
      (f.horas_falta <= 20 && !f.av20h) || (f.horas_falta <= 8 && !f.av8h) || (f.horas_falta <= 2 && !f.av2h));
  });
  res.json({
    hora_bolivia: hBol + 'h', ventana_activa: (hBol >= 7 && hBol < 23),
    total: filas.length, sin_recordatorio_debido: faltantes.length,
    faltantes: faltantes, todas: filas
  });
});

app.get('/debug/estados-reservas', async (req, res) => {
  if (req.query.key !== 'diag-9x') return res.status(403).json({ error: 'no' });
  if (!db) return res.status(200).json({ error: 'sin db' });
  const out = {};
  try {
    for (const col of ['reservas_beni', 'citas']) {
      const snap = await db.collection(col).get();
      const by = {}; const sample = [];
      snap.docs.forEach(function (d) {
        const c = d.data() || {};
        const e = c.estado || '(sin estado)';
        by[e] = (by[e] || 0) + 1;
        if (sample.length < 15) sample.push({ id: d.id, estado: e, fecha: c.fecha || '', hora: c.hora || '', tel: String(c.telefono || '').slice(-4), avisado: !!c.aviso_confirmada_at });
      });
      out[col] = { total: snap.size, estados: by, sample: sample };
    }
  } catch (e) { return res.status(200).json({ error: e.message }); }
  res.json(out);
});

// AVISO ESPECIAL a quien YA tiene reserva (confirmada) o cuya reserva seguía pendiente:
// depósito retirado → su reserva queda CONFIRMADA para su hora; si desea, puede cancelar/reprogramar ahora.
// (Las reservas expiradas por las 2h ya fueron BORRADAS por el sistema; si sobrevive alguna 'pendiente_pago', se re-confirma.)
// GET /debug/aviso-reservados?key=aviso-res-9x[&dry=1]
// TEMPORAL (una vez): rellena el chatId de reservas viejas (sin chatId) buscando el NOMBRE de la reserva
// en los mensajes de cada chat. Sirve para enlazar reservas hechas por Messenger/Instagram antes del fix.
// GET /debug/backfill-chatid?key=backfill-8x[&dry=1]
app.get('/debug/backfill-chatid', async (req, res) => {
  if (req.query.key !== 'backfill-8x') return res.status(403).json({ error: 'no' });
  if (!db) return res.status(200).json({ error: 'sin db' });
  const dry = req.query.dry === '1';
  const r = { candidatas: 0, matcheadas: 0, actualizadas: 0, dry: dry, detalle: [] };
  try {
    // Reservas sin chatId, con canal de chat (no web/voz), con nombre
    const rs = await db.collection('reservas_beni').get();
    const pend = [];
    rs.forEach(function (d) {
      const c = d.data() || {};
      const nom = String(c.nombre || '').trim();
      if (!c.chatId && c.canal && c.canal !== 'voz' && nom.length >= 4) pend.push({ id: d.id, nombre: nom.toLowerCase() });
    });
    r.candidatas = pend.length;
    if (!pend.length) return res.json(r);
    // Recorre chats una vez; para cada uno arma el texto de sus últimos mensajes y busca los nombres pendientes
    const chatsSnap = await db.collection('valeria_chats').get();
    for (const cd of chatsSnap.docs) {
      if (!pend.some(function (p) { return !p._chatId; })) break; // ya se asignaron todas
      let blob = '';
      try {
        const ms = await db.collection('valeria_chats').doc(cd.id).collection('mensajes').orderBy('ts', 'desc').limit(40).get();
        ms.forEach(function (mm) { blob += ' ' + String((mm.data() || {}).texto || '').toLowerCase(); });
      } catch (e) { continue; }
      for (const p of pend) {
        if (!p._chatId && blob.indexOf(p.nombre) !== -1) { p._chatId = cd.id; }
      }
    }
    for (const p of pend) {
      if (p._chatId) {
        r.matcheadas++;
        if (r.detalle.length < 40) r.detalle.push({ reserva: p.id, chatId: p._chatId });
        if (!dry) { try { await db.collection('reservas_beni').doc(p.id).update({ chatId: p._chatId }); r.actualizadas++; } catch (e) {} }
      }
    }
  } catch (e) { return res.status(200).json({ error: e.message, parcial: r }); }
  res.json(r);
});

// TEMPORAL: encuentra el chat de una persona por nombre y (opcional) corrige el teléfono de su reserva.
// GET /debug/fix-tel?key=fixtel-8x&nombre=eva[&slot=beni_2026-08-15_1500&telefono=59171234567]
app.get('/debug/fix-tel', async (req, res) => {
  if (req.query.key !== 'fixtel-8x') return res.status(403).json({ error: 'no' });
  if (!db) return res.status(200).json({ error: 'sin db' });
  const q = String(req.query.nombre || '').toLowerCase().trim();
  const modo = String(req.query.modo || '').trim();
  const msgq = String(req.query.msg || '').toLowerCase().trim(); // buscar en los MENSAJES de los chats
  const out = { chats: [], reserva: null, actualizado: false };
  try {
    const snap = await db.collection('valeria_chats').get();
    if (msgq) {
      // Recorre los últimos mensajes de cada chat y busca el texto
      for (const d of snap.docs) {
        const contacto = String(d.id).split('_').slice(1).join('_');
        try {
          const ms = await db.collection('valeria_chats').doc(d.id).collection('mensajes').orderBy('ts', 'desc').limit(20).get();
          let hit = false;
          ms.forEach(function (mm) { if (String((mm.data() || {}).texto || '').toLowerCase().indexOf(msgq) !== -1) hit = true; });
          if (hit) out.chats.push({ id: d.id, nombre: (d.data() || {}).nombre || '', telefono: contacto });
        } catch (e) {}
      }
    } else {
      snap.forEach(function (d) {
        const c = d.data() || {};
        const contacto = String(d.id).split('_').slice(1).join('_');
        const ua = (c.ultimaActividad && c.ultimaActividad.toDate) ? c.ultimaActividad.toDate().toISOString().slice(0, 16) : '';
        if (modo === 'reservo') {
          if (c.reservoOk === true) out.chats.push({ id: d.id, nombre: c.nombre || '', telefono: contacto, ult: ua });
        } else if (q && String(c.nombre || '').toLowerCase().indexOf(q) !== -1) {
          out.chats.push({ id: d.id, nombre: c.nombre || '', telefono: contacto, ult: ua });
        }
      });
    }
    // Estado actual de la reserva (si se pasó slot)
    const slot = String(req.query.slot || '').trim();
    if (slot) {
      const rd = await db.collection('reservas_beni').doc(slot).get();
      if (rd.exists) out.reserva = { id: slot, nombre: rd.data().nombre, telefono: rd.data().telefono };
      // Si además se pasó un teléfono, lo corrige
      const tel = String(req.query.telefono || '').replace(/\D/g, '');
      if (tel.length >= 8 && rd.exists) {
        await db.collection('reservas_beni').doc(slot).update({ telefono: tel });
        out.actualizado = true; out.reserva.telefono_nuevo = tel;
      }
    }
  } catch (e) { return res.status(200).json({ error: e.message, parcial: out }); }
  res.json(out);
});

app.get('/debug/aviso-reservados', async (req, res) => {
  if (req.query.key !== 'aviso-res-9x') return res.status(403).json({ error: 'no' });
  if (!db) return res.status(200).json({ error: 'sin db' });
  const dry = req.query.dry === '1';
  const r = { confirmadas: 0, reconfirmadas: 0, enviados: 0, ya_avisados: 0, pasadas: 0, sin_tel: 0, errores: 0, dry: dry, muestra: [] };
  const ESTADOS = ['confirmada', 'pendiente_pago', 'expirada', 'liberada'];
  const ahora = Date.now();
  try {
    for (const col of ['reservas_beni', 'citas']) {
      let snap;
      try { snap = await db.collection(col).where('estado', 'in', ESTADOS).get(); }
      catch (e) { console.error('aviso-res query ' + col + ':', e.message); continue; }
      for (const d of snap.docs) {
        const c = d.data() || {};
        if (c.aviso_confirmada_at) { r.ya_avisados++; continue; }
        const tel = String(c.telefono || '').replace(/\D/g, '');
        const nom = String(c.nombre || '').split(/\s+/)[0] || '';
        const fecha = c.fecha || '', hora = c.hora || '', sede = c.sede || c.subsede || c.lugar || '';
        // No avisar de reservas que ya pasaron (no tiene sentido "confirmar" una cita vencida)
        if (fecha) {
          const citaMs = Date.parse(fecha + 'T' + (hora ? (String(hora).length === 5 ? hora : ('0' + hora)) : '23:59') + ':00-04:00');
          if (!isNaN(citaMs) && citaMs < ahora - 60 * 60 * 1000) { r.pasadas++; continue; }
        }
        const eraConfirmada = c.estado === 'confirmada';
        if (eraConfirmada) r.confirmadas++; else r.reconfirmadas++;
        const msg = '¡Hola ' + nom + '! 💛 Te escribo del equipo de *Harmonie*. Decidimos *retirar el depósito de Bs 50*: tu reserva quedó *CONFIRMADA*' + (fecha ? (' para el ' + fecha + (hora ? (' a las ' + hora) : '')) : '') + (sede ? (' en ' + sede) : '') + '. No necesitas pagar nada por adelantado. Si deseas cancelar o reprogramar, puedes hacerlo ahora respondiéndome a este mensaje. ¡Te esperamos! 🌸';
        if (r.muestra.length < 20) r.muestra.push({ col: col, id: d.id, estado: c.estado, tel: tel.slice(-4) });
        if (dry) continue;
        try {
          const upd = { aviso_confirmada_at: admin.firestore.FieldValue.serverTimestamp() };
          if (!eraConfirmada) { upd.estado = 'confirmada'; } // depósito retirado → se re-confirma
          await d.ref.update(upd);
          if (tel) { await waSend(tel, msg); r.enviados++; } else r.sin_tel++;
          await new Promise(function (rs) { setTimeout(rs, 300); });
        } catch (e) { r.errores++; console.error('aviso-res ' + d.id + ':', e.message); }
      }
    }
  } catch (e) { return res.status(200).json({ error: e.message, parcial: r }); }
  res.json(r);
});

// LIMPIEZA (una vez): borra reservas_beni huérfanas con estado 'cancelada'/'reagendada' que bloquean
// re-reservar su horario (id determinista). También borra su cupo por si quedó. GET /debug/limpiar-canceladas?key=limpia-canc-8x[&dry=1]
app.get('/debug/limpiar-canceladas', async (req, res) => {
  if (req.query.key !== 'limpia-canc-8x') return res.status(403).json({ error: 'no' });
  if (!db) return res.status(200).json({ error: 'sin db' });
  const dry = req.query.dry === '1';
  const r = { encontradas: 0, borradas: 0, dry: dry, ids: [] };
  try {
    const snap = await db.collection('reservas_beni').where('estado', 'in', ['cancelada', 'reagendada']).get();
    for (const d of snap.docs) {
      r.encontradas++; if (r.ids.length < 50) r.ids.push(d.id);
      if (dry) continue;
      const batch = db.batch();
      batch.delete(d.ref);
      batch.delete(db.collection('cupos_ocupados').doc(d.id)); // por si quedó un cupo suelto
      await batch.commit();
      r.borradas++;
    }
  } catch (e) { return res.status(200).json({ error: e.message, parcial: r }); }
  res.json(r);
});

// DIAGNÓSTICO (solo lectura): lista los cupos_ocupados (bloqueos + reservas) para ver el id exacto.
// GET /debug/cupos?key=cupos-ver-8x
app.get('/debug/cupos', async (req, res) => {
  if (req.query.key !== 'cupos-ver-8x') return res.status(403).json({ error: 'no' });
  if (!db) return res.status(200).json({ error: 'sin db' });
  try {
    const snap = await db.collection('cupos_ocupados').get();
    const out = [];
    snap.forEach(function (d) { const c = d.data() || {}; out.push({ id: d.id, jornadaId: c.jornadaId, fecha: c.fecha, hora: c.hora, ocupado: c.ocupado }); });
    out.sort(function (a, b) { return (a.id > b.id) ? 1 : -1; });
    res.json({ total: snap.size, cupos: out });
  } catch (e) { res.status(200).json({ error: e.message }); }
});

// AVISO MASIVO (una sola vez): informa a los chats que se RETIRÓ el depósito para reservar.
// GET /debug/aviso-sin-deposito?key=aviso-nodep-9x[&dry=1]
// - dry=1 → NO envía, solo cuenta a quiénes llegaría (revisar antes).
// - Respeta la ventana de 24h de Meta (wa/fb/ig) para NO arriesgar el número: fuera de 24h se omite.
// - Telegram no tiene ventana. Marca aviso_nodep_at para no reenviar dos veces.
app.get('/debug/aviso-sin-deposito', async (req, res) => {
  if (req.query.key !== 'aviso-nodep-9x') return res.status(403).json({ error: 'no' });
  if (!db) return res.status(200).json({ error: 'sin db' });
  const dry = req.query.dry === '1';
  const H24 = 24 * 60 * 60 * 1000;
  const ahora = Date.now();
  const MSG = '¡Hola! 💛 Te escribo del equipo de *Harmonie*. ¡Buenas noticias! Por esta jornada RETIRAMOS la condición de depósito para reservar: ya *no necesitas pagar nada por adelantado* para asegurar tu cita. Te enviaremos un recordatorio para que confirmes tu reserva. Si quieres agendar o tienes alguna duda, aquí estoy para ayudarte 😊';
  const r = { total: 0, enviados: 0, omitidos_24h: 0, ya_avisados: 0, con_reserva: 0, errores: 0, dry: dry, muestra: [] };
  // Quien ya tiene reserva recibe el mensaje ESPECIAL (aviso-reservados), no el genérico: junto sus teléfonos para omitirlos.
  const telsReserva = new Set();
  try {
    for (const col of ['reservas_beni', 'citas']) {
      const rs = await db.collection(col).where('estado', 'in', ['confirmada', 'pendiente_pago', 'expirada', 'liberada']).get();
      rs.docs.forEach(function (d) { const t = String((d.data() || {}).telefono || '').replace(/\D/g, '').slice(-8); if (t) telsReserva.add(t); });
    }
  } catch (e) { console.error('aviso-nodep tels reserva:', e.message); }
  try {
    const snap = await db.collection('valeria_chats').get();
    for (const doc of snap.docs) {
      r.total++;
      const c = doc.data() || {};
      const userId = doc.id;
      if (c.aviso_nodep_at) { r.ya_avisados++; continue; }
      const canal = userId.split('_')[0];
      const contacto = userId.split('_').slice(1).join('_');
      const last8 = String(contacto).replace(/\D/g, '').slice(-8);
      if (last8 && last8.length >= 7 && telsReserva.has(last8)) { r.con_reserva++; continue; } // le llega el mensaje especial
      const lastUser = (c.lastUserMsgAt && c.lastUserMsgAt.toMillis) ? c.lastUserMsgAt.toMillis() : null;
      // Ventana de 24h para canales de Meta (protege el número de WhatsApp)
      if (canal !== 'tg') {
        if (!lastUser || (ahora - lastUser) >= H24) { r.omitidos_24h++; continue; }
      }
      if (r.muestra.length < 20) r.muestra.push(userId);
      if (dry) continue;
      try {
        await _enviarPorCanal(userId, MSG);
        logMensaje(userId, 'valeria', MSG);
        await doc.ref.update({ aviso_nodep_at: admin.firestore.FieldValue.serverTimestamp() });
        r.enviados++;
        await new Promise(function (rs) { setTimeout(rs, 300); }); // suave, para no gatillar antispam
      } catch (e) { r.errores++; console.error('aviso-nodep ' + userId + ':', e.message); }
    }
  } catch (e) { return res.status(200).json({ error: e.message, parcial: r }); }
  res.json(r);
});

app.listen(PORT, () => {
  console.log(`✅ Valeria Bot corriendo en puerto ${PORT}`);
  iniciarWatcherReservas();
  iniciarWatcherCalendario(); // Sincroniza reservas ↔ Google Calendar
  // Confirmación automática de pagos (BCP/Yape por correo → confirma reserva + notifica)
  if (iniciarWatcherPagos) {
    try {
      iniciarWatcherPagos({
        db: db, waSend: waSend, bot: bot, getAdminTelegram: getAdminTelegram, ADMIN_WHATSAPP: ADMIN_WHATSAPP,
        beneficiario: process.env.PAGOS_BENEFICIARIO || 'HARMONIE',
        smtp: {
          host: 'smtp.gmail.com',
          user: process.env.PAGOS_SMTP_USER || process.env.PAGOS_IMAP_USER,
          pass: process.env.PAGOS_SMTP_PASS || process.env.PAGOS_IMAP_PASS
        },
        MONTO_MIN: parseFloat(process.env.PAGOS_MONTO_MIN || '50'),
        pagoUrl: PAGO_URL,
        pollSeg: parseInt(process.env.PAGOS_POLL_SEG || '60', 10),
        imap: {
          host: process.env.PAGOS_IMAP_HOST,
          port: parseInt(process.env.PAGOS_IMAP_PORT || '993', 10),
          user: process.env.PAGOS_IMAP_USER,
          pass: process.env.PAGOS_IMAP_PASS,
          remitente: process.env.PAGOS_REMITENTE || '',
          asunto: process.env.PAGOS_ASUNTO || ''
        }
      });
    } catch (e) { console.error('⚠️ no pude iniciar el watcher de pagos:', e.message); }
  }
  iniciarWatcherExpiraciones(); // Aparta la reserva 60min; recordatorios 30/45min; expira sin pago
  iniciarWatcherRecordatorios(); // Recordatorio de confirmación ~8h antes + recordatorio simple ~2h antes
});
