'use strict';
// OrbitaOs - reglas de la lista blanca de WhatsApp.
//
// Este modulo es puro a proposito: no usa MongoDB, ni el navegador de
// WhatsApp, ni variables de entorno. Asi las reglas de autorizacion se pueden
// probar enteras (scripts/whitelist_check.js) sin levantar nada, y tanto
// index.js como src/users.js comparten exactamente la misma logica.

/** Tipos de mensaje que nunca son conversacion (no se guardan ni se responden). */
const TIPOS_DE_SISTEMA = [
  'revoked',
  'e2e_notification',
  'notification',
  'ciphertext',
  'unsupported',
  'poll_vote',
];

/** Menos de este largo de cola no se compara: el riesgo de choque entre dos
 *  numeros distintos no compensa la tolerancia al formato. */
const MIN_DIGITOS_COLA = 9;

/* -------------------------------------------------------------------------
 -- Telefonos
 -- ---------------------------------------------------------------------- */

/**
 * Quita el sufijo de WhatsApp (@c.us, @s.whatsapp.net, @lid, @g.us) y todo lo
 * que no sea digito. "595 981 234-567" y "595981234567@c.us" dan lo mismo.
 */
function normalizePhone(id) {
  return String(id === undefined || id === null ? '' : id)
    .split('@')[0]
    .replace(/\D/g, '');
}

/** Quita los ceros iniciales: "0981234567" es "981234567". */
function sinCerosIniciales(digitos) {
  return String(digitos || '').replace(/^0+/, '');
}

/**
 * Variantes aceptables de un mismo telefono, para tolerar diferencias de
 * formato: como fue guardado (595981234567), con prefijo internacional
 * (+595 981 234 567) o sin codigo de pais (0981 234567).
 */
function variantes(phone) {
  const base = normalizePhone(phone);
  if (!base) return [];
  const out = new Set([base]);
  for (const v of [base, sinCerosIniciales(base)]) {
    for (const largo of [MIN_DIGITOS_COLA, MIN_DIGITOS_COLA + 1]) {
      if (v.length > largo) out.add(v.slice(-largo));
    }
  }
  return [...out];
}

/** true si los dos telefonos coinciden aunque esten escritos distinto. */
function mismoTelefono(a, b) {
  const va = variantes(a);
  const vb = variantes(b);
  if (!va.length || !vb.length) return false;
  return va.some((x) => vb.includes(x));
}

/* -------------------------------------------------------------------------
 -- Identificadores de WhatsApp
 -- ---------------------------------------------------------------------- */

/** true si el id es de un grupo. */
function esGrupo(id) {
  return /@g\.us$/i.test(String(id || ''));
}

/**
 * true si el id es un "@lid": el identificador opaco de un dispositivo
 * vinculado. NO es el telefono, asi que hay que resolverlo antes de comparar.
 */
function esLid(id) {
  return /@lid$/i.test(String(id || ''));
}

/** Quien mando el mensaje: en grupos es msg.author, no el id del grupo. */
function remitenteDe(msg) {
  if (!msg) return '';
  if (esGrupo(msg.from)) return msg.author || msg.from;
  return msg.from;
}

/** true si el remitente es el propio numero del bot (nadie se habla a si mismo). */
function esNumeroDelBot(id, botPhone) {
  return mismoTelefono(id, botPhone);
}

/* -------------------------------------------------------------------------
 -- Veredicto
 -- ---------------------------------------------------------------------- */

// Motivos del veredicto. Se imprimen en los logs para distinguir "no tiene
// acceso" de cualquier otro fallo del bot.
const MOTIVOS = {
  SIN_TELEFONO: 'sin-telefono',
  BOT: 'bot',
  NO_AUTORIZADO: 'no-autorizado',
  AUTORIZADO: 'autorizado',
};

/**
 * Decide si un remitente puede usar el bot, sin tocar la base de datos ni el
 * navegador: `permitido(phone)` es la consulta que cada capa hace por su lado.
 *
 * Devuelve { permitido, phone, motivo } para que el llamador pueda loguear el
 * motivo y las pruebas puedan distinguir cada caso.
 */
function autorizar({ senderId, botPhone, permitido }) {
  const phone = normalizePhone(senderId);
  if (!phone) {
    return { permitido: false, phone: '', motivo: MOTIVOS.SIN_TELEFONO };
  }
  if (esNumeroDelBot(phone, botPhone)) {
    return { permitido: false, phone, motivo: MOTIVOS.BOT };
  }
  if (typeof permitido === 'function' && !permitido(phone)) {
    return { permitido: false, phone, motivo: MOTIVOS.NO_AUTORIZADO };
  }
  return { permitido: true, phone, motivo: MOTIVOS.AUTORIZADO };
}

/**
 * Los logs no exponen telefonos completos: alcanza con los ultimos digitos
 * para ubicar el problema sin publicar un dato personal.
 */
function enmascarar(phone) {
  const d = normalizePhone(phone);
  if (!d) return 'desconocido';
  return `***${d.slice(-3)}`;
}

module.exports = {
  MOTIVOS,
  MIN_DIGITOS_COLA,
  TIPOS_DE_SISTEMA,
  authorize: autorizar,
  autorizar,
  enmascarar,
  esGrupo,
  esLid,
  esNumeroDelBot,
  mismoTelefono,
  normalizePhone,
  remitenteDe,
  sinCerosIniciales,
  variantes,
};
