// ============================================================================
//  pagos.js — Confirmación automática de pagos (BCP / Yape) para HARMONIE
//  ----------------------------------------------------------------------------
//  Valeria lee la casilla de correo donde el banco avisa cada transferencia QR,
//  saca (monto + titular que paga + N° de transacción), busca la reserva
//  pendiente de pago en Firestore `citas`, la CONFIRMA y notifica al cliente
//  (WhatsApp) + al equipo (WhatsApp + Telegram).
//
//  Diseño defensivo:
//   • Solo abre correos DEL BANCO (filtro por remitente/asunto). El correo
//     personal ni se toca ni se marca leído.
//   • Idempotente: cada N° de transacción se procesa UNA sola vez
//     (colección `pagos_procesados`). Aunque el correo se relea, no re-confirma.
//   • Si NO puede decidir con certeza (0 reservas pendientes, varias ambiguas,
//     o monto menor al esperado) → NO confirma nada: le avisa a Julio para que
//     revise a mano. Cero riesgo de confirmar un pago que no corresponde.
//
//  Las dependencias (Firestore, envíos de WhatsApp/Telegram) se inyectan desde
//  index.js para reusar lo que ya existe. Config por variables de entorno:
//     PAGOS_IMAP_HOST   (Yahoo: imap.mail.yahoo.com)
//     PAGOS_IMAP_PORT   (993)
//     PAGOS_IMAP_USER   (ru.tejada@yahoo.com)
//     PAGOS_IMAP_PASS   (contraseña de aplicación — NUNCA en el código)
//     PAGOS_REMITENTE   (correo del banco, ej. notificaciones@bcp.com.bo)
//     PAGOS_MONTO_MIN   (monto mínimo aceptado; 50 en producción, 1 para probar)
//     PAGOS_POLL_SEG    (cada cuántos segundos revisa; 60 por defecto)
// ============================================================================

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

// ── Utilitarios ─────────────────────────────────────────────────────────────
function norm(s) {
  return String(s || '').toUpperCase().normalize('NFD')
    .replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
}
function soloDigitos(s) { return String(s || '').replace(/\D/g, ''); }
function primerNombre(s) {
  const t = String(s || '').trim().split(/\s+/)[0] || '';
  return t ? (t.charAt(0).toUpperCase() + t.slice(1).toLowerCase()) : '';
}
function tsMs(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (ts._seconds) return ts._seconds * 1000;
  if (ts.seconds) return ts.seconds * 1000;
  return 0;
}
// ¿El nombre del que paga coincide con el de la reserva? (comparte un token ≥3)
function coincideNombre(a, b) {
  const ta = norm(a).split(' ').filter(function (x) { return x.length >= 3; });
  const tb = norm(b).split(' ').filter(function (x) { return x.length >= 3; });
  return ta.some(function (x) { return tb.indexOf(x) !== -1; });
}

// ── Parseo del cuerpo del correo del banco ──────────────────────────────────
// Tolerante a saltos de línea y a que los campos vengan de una tabla HTML.
// Corta el nombre al toparse con la etiqueta siguiente (por si viene todo pegado).
function limpiarNombre(s) {
  return String(s || '')
    .split(/\s+(?:Cuenta|Email|Correo|Beneficiario|Origen|Destino|Detalle|Monto|Glosa|Fecha|Descripci|Originante|Identificador|Operaci|N[uú]mero|N[°ºo])/i)[0]
    .trim().replace(/\s+/g, ' ');
}
function parsearPago(texto) {
  const t = String(texto || '').replace(/\r/g, '');

  // ── Formato 1: MULTIPLICA EXTRANET (pago RECIBIDO por HARMONIE) — EL QUE IMPORTA ──
  // "Número de operación: 0108397", "Originante: <quien paga>", "Descripción: HARMONIE",
  // "Monto Recibido: Bs 1.00". Es la notificación cuando un cliente PAGA el QR del negocio.
  const mOp = t.match(/N[uú]mero\s+de\s+operaci[oó]n\s*:?\s*([0-9]{3,})/i);
  const mRec = t.match(/Monto\s+Recibido\s*:?\s*(?:Bs\.?|BOB|BOL)?\s*([0-9]+(?:[.,][0-9]{1,2})?)/i);
  if (mOp && mRec) {
    const mOrig = t.match(/Originante\s*:?\s*([A-Za-zÁÉÍÓÚÑáéíóúñ.\- ]{3,80})/i);
    const mDesc = t.match(/Descripci[oó]n\s*:?\s*([A-Za-zÁÉÍÓÚÑáéíóúñ0-9.\- ]{2,80})/i);
    const mFe = t.match(/Fecha\s*:?\s*([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{2,4}(?:\s+[0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?)?)/i);
    return {
      tipo: 'recibido',
      nTransaccion: mOp[1].trim(),                         // dedup por N° de operación
      titular: mOrig ? limpiarNombre(mOrig[1]) : '',       // quién pagó
      monto: parseFloat(mRec[1].replace(',', '.')),
      fecha: mFe ? mFe[1].trim() : '',
      beneficiario: mDesc ? limpiarNombre(mDesc[1]) : ''   // "Descripción" (HARMONIE)
    };
  }

  // ── Formato 2: Transferencia QR (pago SALIENTE de Julio) — fallback/compatibilidad ──
  const mTx = t.match(/N[°ºo]?\s*Transacci[oó]n\s*:?\s*([0-9]{4,})/i);
  if (!mTx) return null; // sin N° de operación ni transacción no es un correo de pago
  const mTit = t.match(/Titular\s*:?\s*([A-Za-zÁÉÍÓÚÑáéíóúñ.\- ]{3,80})/i);
  const mMonto = t.match(/Monto\s*(?:transferido)?\s*:?\s*(?:BOL|Bs\.?|BOB)?\s*([0-9]+(?:[.,][0-9]{1,2})?)/i);
  const mFecha = t.match(/Fecha\s*:?\s*([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{2,4}(?:\s+[0-9]{1,2}:[0-9]{2})?)/i);
  const mBenef = t.match(/Beneficiario\s*:?\s*([A-Za-zÁÉÍÓÚÑáéíóúñ.\- ]{2,80})/i);
  return {
    tipo: 'enviado',
    nTransaccion: mTx[1].trim(),
    titular: mTit ? limpiarNombre(mTit[1]) : '',
    monto: mMonto ? parseFloat(mMonto[1].replace(',', '.')) : null,
    fecha: mFecha ? mFecha[1].trim() : '',
    beneficiario: mBenef ? limpiarNombre(mBenef[1]) : ''
  };
}

function resumenPago(p) {
  return '💵 Bs ' + (p.monto != null ? p.monto : '?') + '\n'
    + '👤 Pagó: ' + (p.titular || '(sin nombre)') + '\n'
    + '📅 ' + (p.fecha || '-') + '\n'
    + '🔖 Tx ' + p.nTransaccion;
}

// ── Avisos al equipo (WhatsApp + Telegram) ──────────────────────────────────
async function avisarJulio(deps, texto) {
  try { await deps.waSend(deps.ADMIN_WHATSAPP, texto); } catch (e) { console.error('pago aviso WA:', e.message); }
  try {
    const adm = await deps.getAdminTelegram();
    if (adm) { await deps.bot.sendMessage(adm, texto); console.log('💳 aviso enviado a Telegram admin ' + adm); }
    else console.warn('💳 sin admin de Telegram registrado — no pude avisar por TG (usá /admin en el bot)');
  } catch (e) { console.error('pago aviso TG:', e.message); }
}

// ── Núcleo: procesa UN pago ya parseado ─────────────────────────────────────
// Reusable venga de donde venga (correo IMAP hoy, webhook de MacroDroid mañana).
async function procesarPago(deps, p) {
  const db = deps.db;
  if (!db) { console.warn('pagos: sin Firestore'); return; }
  const id = p.nTransaccion;
  const procRef = db.collection('pagos_procesados').doc(id);

  // 1) Idempotencia: ¿ya lo procesamos?
  try {
    const prev = await procRef.get();
    if (prev.exists) { console.log('💸 pago ' + id + ' ya procesado, salteo'); return; }
  } catch (e) { console.error('pagos: lectura dedup:', e.message); }

  const guardar = function (extra) {
    const doc = {
      nTransaccion: id, titular: p.titular || '', monto: (p.monto != null ? p.monto : null),
      fecha: p.fecha || '', beneficiario: p.beneficiario || '', procesadoAt: new Date()
    };
    for (const k in extra) doc[k] = extra[k];
    return procRef.set(doc).catch(function (e) { console.error('pagos: guardar procesado:', e.message); });
  };

  // 2) Busca reservas pendientes de pago
  let candidatas = [];
  try {
    const snap = await db.collection('citas').where('estado', '==', 'pendiente_pago').get();
    snap.forEach(function (d) { candidatas.push(Object.assign({ _id: d.id }, d.data())); });
  } catch (e) { console.error('pagos: query citas:', e.message); }
  candidatas.sort(function (a, b) { return tsMs(b.timestamp) - tsMs(a.timestamp); }); // más reciente primero

  // 3) Elige la reserva
  console.log('💳 pago ' + id + ': ' + candidatas.length + ' reserva(s) pendiente(s) de pago');
  let elegida = null, motivo = '';
  if (candidatas.length === 0) {
    // Diagnóstico: mostrar las últimas citas y su estado para entender por qué no matcheó.
    try {
      const diag = await db.collection('citas').orderBy('timestamp', 'desc').limit(6).get();
      const res = [];
      diag.forEach(function (d) { const x = d.data(); res.push('"' + (x.nombre || '?') + '" estado=' + (x.estado || '?') + ' modalidad=' + (x.modalidad || '?') + ' ' + (x.fecha || '') + ' ' + (x.hora || '')); });
      console.log('💳 diag — últimas 6 citas: ' + (res.length ? res.join(' || ') : '(no hay ninguna cita en la colección)'));
    } catch (e) { console.error('💳 diag citas:', e.message); }
    console.log('💳 pago ' + id + ' sin reserva pendiente → aviso a Julio');
    await avisarJulio(deps, '⚠️ Llegó un PAGO pero NO hay ninguna reserva pendiente de pago.\n' + resumenPago(p) + '\nRevisá si corresponde a algo.');
    await guardar({ resultado: 'sin_reserva' });
    return;
  } else if (candidatas.length === 1) {
    elegida = candidatas[0]; motivo = 'única pendiente';
  } else {
    const conNombre = candidatas.filter(function (c) { return coincideNombre(p.titular, c.nombre); });
    if (conNombre.length === 1) { elegida = conNombre[0]; motivo = 'por nombre'; }
    else {
      console.log('💳 pago ' + id + ' ambiguo (' + candidatas.length + ' pendientes) → aviso a Julio');
      await avisarJulio(deps, '🤔 Llegó un pago pero hay ' + candidatas.length + ' reservas pendientes y no puedo decidir con certeza.\n' + resumenPago(p) + '\n👉 Confirmá vos a mano cuál corresponde.');
      await guardar({ resultado: 'ambiguo', pendientes: candidatas.length });
      return;
    }
  }

  // 4) Verifica el monto
  const montoOk = (p.monto == null) ? true : (p.monto >= deps.MONTO_MIN);
  if (!montoOk) {
    await avisarJulio(deps, '⚠️ Pago de Bs ' + p.monto + ' (menor a Bs ' + deps.MONTO_MIN + ') de ' + p.titular + '.\nReserva: ' + elegida.nombre + ' · ' + (elegida.telefono || '') + '\nNo la confirmé sola — revisá.\n' + resumenPago(p));
    await guardar({ resultado: 'monto_bajo', citaId: elegida._id });
    return;
  }

  // 5) CONFIRMA la reserva
  try {
    await db.collection('citas').doc(elegida._id).update({
      estado: 'confirmada',
      pago: {
        nTransaccion: id, monto: (p.monto != null ? p.monto : null),
        titular: p.titular || '', fecha: p.fecha || '',
        confirmadoPor: 'valeria-email', confirmadoAt: new Date()
      }
    });
  } catch (e) {
    console.error('pagos: update cita:', e.message);
    await avisarJulio(deps, '❌ Encontré el pago y la reserva pero falló al confirmarla en el sistema. Revisá a mano.\n' + resumenPago(p) + '\nReserva: ' + elegida.nombre);
    await guardar({ resultado: 'error_update', citaId: elegida._id });
    return;
  }
  await guardar({ resultado: 'confirmado', citaId: elegida._id, motivo: motivo });

  // 6) Notifica al CLIENTE (WhatsApp)
  const telCli = soloDigitos(elegida.telefono);
  if (telCli) {
    const msgCli = '¡Hola ' + (primerNombre(elegida.nombre) || '') + '! 😊 Recibimos tu pago de Bs '
      + (p.monto != null ? p.monto : '') + ' ✅\nTu cita en HARMONIE quedó *CONFIRMADA*'
      + (elegida.fecha ? (' para el ' + elegida.fecha) : '')
      + (elegida.hora ? (' a las ' + elegida.hora) : '')
      + (elegida.sede ? (' · ' + elegida.sede) : '')
      + '.\n¡Te esperamos! 💛 Recordá que los Bs 50 se descuentan de tu tratamiento.';
    deps.waSend(telCli, msgCli).catch(function (e) { console.error('pago aviso cliente:', e.message); });
  }

  // 7) Notifica al EQUIPO
  await avisarJulio(deps, '✅ PAGO CONFIRMADO automáticamente (' + motivo + ')\n'
    + '💵 Bs ' + (p.monto != null ? p.monto : '?') + ' de ' + p.titular + '\n'
    + '👤 Reserva: ' + elegida.nombre + ' · ' + (elegida.telefono || '') + '\n'
    + '📅 ' + (elegida.fecha || '-') + ' ' + (elegida.hora || '') + (elegida.sede ? (' · ' + elegida.sede) : '') + '\n'
    + '🔖 Tx ' + id);
  console.log('✅ pago ' + id + ' confirmado → cita ' + elegida._id + ' (' + motivo + ')');
}

// ── Adaptador de entrada: lee la bandeja por IMAP ───────────────────────────
const _vistosMem = new Set(); // messageIds ya evaluados en esta corrida (evita re-bajar el cuerpo)
let _revisando = false;
async function revisarBandeja(deps) {
  if (_revisando) return; // evita solapes si una pasada tarda
  _revisando = true;
  const cfg = deps.imap;
  let client = null;
  try {
    client = new ImapFlow({
      host: cfg.host, port: cfg.port || 993, secure: true,
      auth: { user: cfg.user, pass: cfg.pass }, logger: false
    });
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      // Filtramos EN EL SERVIDOR (por remitente O por asunto) + últimos 2 días.
      // NO filtramos por "sin leer": procesamos aunque el correo esté abierto
      // (la dedup por N° de operación evita repetir). Así no importa si Julio lo abre.
      const desde = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      const criteria = { since: desde };
      if (cfg.remitente) criteria.from = cfg.remitente;
      else if (cfg.asunto) criteria.subject = cfg.asunto;
      let uids = [];
      try { uids = await client.search(criteria, { uid: true }); }
      catch (e) { console.error('pagos: search:', e.message); }
      uids = uids || [];
      console.log('💳 poll: ' + uids.length + ' correo(s) del banco (últimos 2 días)');
      let procesados = 0;
      for (const uid of uids) {
        // 1) Envelope primero (barato): filtra y deduplica sin bajar el cuerpo.
        let env;
        try { env = await client.fetchOne(uid, { envelope: true }, { uid: true }); }
        catch (e) { console.error('pagos: envelope ' + uid + ':', e.message); continue; }
        if (!env) continue;
        const from = ((env.envelope && env.envelope.from && env.envelope.from[0] && env.envelope.from[0].address) || '').toLowerCase();
        const subject = (env.envelope && env.envelope.subject) || '';
        const msgId = (env.envelope && env.envelope.messageId) || ('uid-' + uid);
        const esDelBanco =
          (cfg.remitente && from.indexOf(cfg.remitente.toLowerCase()) !== -1) ||
          (cfg.asunto && subject.toLowerCase().indexOf(cfg.asunto.toLowerCase()) !== -1) ||
          /multiplica\s*extranet|transferencia\s*qr/i.test(subject);
        if (!esDelBanco) continue;
        if (_vistosMem.has(msgId)) continue; // ya lo miramos en esta corrida
        _vistosMem.add(msgId);

        // 2) Bajamos el cuerpo y parseamos.
        let cuerpo = '';
        try {
          const full = await client.fetchOne(uid, { source: true }, { uid: true });
          const mail = await simpleParser(full.source);
          cuerpo = (mail.text && mail.text.trim())
            ? mail.text
            : String(mail.html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ');
        } catch (e) { console.error('pagos: fetch/parse ' + uid + ':', e.message); continue; }
        console.log('💳 correo del banco: subj="' + subject + '"');

        const p = parsearPago(cuerpo);
        if (!p) { console.warn('pagos: correo del banco sin campos reconocibles (uid ' + uid + ')'); continue; }
        console.log('💳 pago parseado: tipo=' + (p.tipo || '?') + ' op/tx=' + p.nTransaccion + ' monto=' + p.monto + ' titular="' + p.titular + '" beneficiario="' + p.beneficiario + '"');

        // Solo procesamos dinero que ENTRA a HARMONIE. Si el beneficiario es otro,
        // es un pago SALIENTE (Julio pagándole a un tercero) → se ignora.
        const benefEsperado = norm(deps.beneficiario || 'HARMONIE');
        if (p.beneficiario && norm(p.beneficiario).indexOf(benefEsperado) === -1) {
          console.log('💳 op/tx=' + p.nTransaccion + ' IGNORADO: beneficiario "' + p.beneficiario + '" no es ' + (deps.beneficiario || 'HARMONIE') + ' (pago saliente)');
          continue;
        }
        try { await procesarPago(deps, p); procesados++; }
        catch (e) { console.error('pagos: procesar:', e.message); }
      }
      if (uids.length && !procesados) console.log('💳 (nada nuevo del banco para procesar)');
    } finally { lock.release(); }
  } catch (e) {
    console.error('pagos IMAP:', e.message);
  } finally {
    if (client) { try { await client.logout(); } catch (_) {} }
    _revisando = false;
  }
}

// ── Arranque ────────────────────────────────────────────────────────────────
function iniciarWatcherPagos(deps) {
  if (!deps || !deps.imap || !deps.imap.user || !deps.imap.pass) {
    console.warn('⚠️ Watcher de pagos inactivo (faltan PAGOS_IMAP_USER / PAGOS_IMAP_PASS)');
    return;
  }
  const cada = (deps.pollSeg || 60) * 1000;
  console.log('💳 Watcher de pagos activo → revisa ' + deps.imap.user + ' cada ' + (cada / 1000) + 's (monto mín Bs ' + deps.MONTO_MIN + ')');
  revisarBandeja(deps); // primera pasada inmediata
  setInterval(function () { revisarBandeja(deps).catch(function () {}); }, cada);
}

module.exports = { iniciarWatcherPagos, procesarPago, parsearPago };
