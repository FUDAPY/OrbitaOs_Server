'use strict';
// OrbitaOs - simulacro del gate de autorizacion de index.js.
//
// Replica el orden exacto de handleMessage con usuarios en memoria y un doble
// de la IA, para comprobar que un remitente autorizado se guarda y se le
// responde, y que uno no autorizado no genera ni una fila ni un token.

const assert = require('assert');
const wl = require('../src/whitelist');

const BOT = '595981234567';
const ANA = '595991112222';
const OTRO = '595998887777';

const usuarios = [
  { phone: ANA, allowed: true },
  { phone: OTRO, allowed: false },
];

const guardados = [];
let llamadasIA = 0;
let respuestas = 0;
let respuestasLocales = 0;

/** Igual que users.isAllowedPhone, contra la lista en memoria. */
function isAllowedPhone(phone) {
  const clean = wl.normalizePhone(phone);
  return usuarios.some((u) => u.allowed && wl.mismoTelefono(u.phone, clean));
}

/** Igual que users.findAllowedByPhone: el telefono canonico del usuario. */
function findAllowedByPhone(phone) {
  const clean = wl.normalizePhone(phone);
  return usuarios.find((u) => u.allowed && wl.mismoTelefono(u.phone, clean)) || null;
}

/** Copia handleMessage: mismo orden, misma logica de corte. */
async function handleMessage(msg, botPhone = BOT) {
  const isGroup = wl.esGrupo(msg.from);
  const body = (msg.body || '').trim();
  if (!body) return;
  if (!isGroup && msg.type !== 'chat') return;

  // Estados y difusiones: no son conversaciones.
  const senderId = wl.remitenteDe(msg);
  if (wl.esDifusion(senderId) || wl.esDifusion(msg.from)) return;

  const { phone: resuelto } = await resolverRemitente(msg);
  if (!resuelto) return;

  const veredicto = wl.autorizar({
    senderId: resuelto,
    botPhone,
    permitido: isAllowedPhone,
  });
  if (!veredicto.permitido) {
    // El camino de los no autorizados: saludo fijo, sin IA y sin guardar.
    if (veredicto.motivo === wl.MOTIVOS.NO_AUTORIZADO) {
      await responderSaludoAutomatico(msg, resuelto);
    }
    return;
  }

  const autorizado = findAllowedByPhone(resuelto);
  const phone = (autorizado && autorizado.phone) || resuelto;
  const chatId = isGroup ? wl.normalizePhone(msg.from) : phone;
  guardados.push({ chatId, from: phone, body });

  // Respuesta local: saludos y agradecimientos no gastan un token.
  const local = respuestaLocal(body);
  if (local) {
    respuestasLocales += 1;
    return local;
  }

  llamadasIA += 1;
  respuestas += 1;
  return 'respuesta';
}

const BOT_NAME = 'Administrador General Chicolin';
const AUTO_REPLY = `Hola, soy ${BOT_NAME}, en que puedo ayudarle, en breve le estaremos respondiendo`;
const AUTO_REPLY_MS = 24 * 3600 * 1000;
const ultimosSaludos = new Map();
const saludosEnviados = [];

async function responderSaludoAutomatico(msg, phone) {
  if (wl.esGrupo(msg.from)) return false;
  const ahora = Date.now();
  if (ahora - (ultimosSaludos.get(phone) || 0) < AUTO_REPLY_MS) return false;
  ultimosSaludos.set(phone, ahora);
  saludosEnviados.push({ phone, texto: AUTO_REPLY });
  return true;
}

const SALUDOS = /^(hola|holis|buenas|buen dia|buenas tardes|buenas noches|hey|ola|que tal|hello|hi)+[!. ]*$/i;
const AGRADECIMIENTOS = /^(gracias|muchas gracias|mil gracias|ok gracias|thanks)+[!. ]*$/i;
const CONFIRMACIONES = /^(ok|oka|dale|listo|perfecto|entendido|hecho|si|claro|joya)+[!. ]*$/i;

function respuestaLocal(body) {
  const texto = String(body || '').trim();
  if (!texto || texto.length > 60) return null;
  if (SALUDOS.test(texto)) return `¡Hola! Soy ${BOT_NAME}.`;
  if (AGRADECIMIENTOS.test(texto)) return '¡De nada!';
  if (CONFIRMACIONES.test(texto)) return 'Perfecto.';
  return null;
}

/** Copia resolverRemitente: resuelve los ids @lid contra la ficha del contacto. */
async function resolverRemitente(msg) {
  const senderId = wl.remitenteDe(msg);
  const directo = wl.normalizePhone(senderId);
  if (directo && !wl.esLid(senderId) && /^\d{8,15}$/.test(directo)) {
    return { phone: directo, senderId };
  }
  // Solo un @lid se resuelve contra la ficha del contacto: para cualquier otro
  // id sin digitos no se inventa un telefono.
  if (!wl.esLid(senderId)) return { phone: directo, senderId };
  const numero = wl.normalizePhone(msg.contacto && msg.contacto.number);
  if (numero && /^\d{8,15}$/.test(numero)) return { phone: numero, senderId };
  return { phone: '', senderId };
}

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}: ${err.message}`);
    process.exitCode = 1;
  }
}

const msgPrivado = (from, body) => ({ from, body, type: 'chat' });

(async () => {
  console.log('\nFlujo completo del gate de autorizacion');

  await check('el autorizado recibe respuesta y su mensaje queda guardado', async () => {
    // Una consulta de verdad: es lo que llega al modelo.
    const r = await handleMessage(msgPrivado(`${ANA}@c.us`, 'quiero agendar una reunion'));
    assert.ok(r, 'debe responder');
    assert.strictEqual(llamadasIA, 1);
    assert.strictEqual(guardados.length, 1);
    assert.strictEqual(guardados[0].from, ANA);
    assert.strictEqual(guardados[0].body, 'quiero agendar una reunion');
  });

  await check('el revocado no genera ni guardado ni trafico a la IA', async () => {
    const antes = { guardados: guardados.length, llamadasIA };
    await handleMessage(msgPrivado(`${OTRO}@c.us`, 'hola'));
    assert.strictEqual(guardados.length, antes.guardados, 'no debe guardar');
    assert.strictEqual(llamadasIA, antes.llamadasIA, 'no debe llamar a la IA');
  });

  await check('el bot no se responde a si mismo', async () => {
    const antes = { guardados: guardados.length, llamadasIA };
    await handleMessage(msgPrivado(`${BOT}@c.us`, 'hola'));
    assert.strictEqual(guardados.length, antes.guardados);
    assert.strictEqual(llamadasIA, antes.llamadasIA);
  });

  await check('el autorizado guardado con otro formato entra igual', async () => {
    // Guardado con codigo de pais, recibido como numero local.
    const antes = guardados.length;
    await handleMessage(msgPrivado('0991112222@c.us', 'hola'));
    assert.strictEqual(guardados.length, antes + 1);
    assert.strictEqual(guardados[guardados.length - 1].from, ANA);
  });

  await check('un @lid se resuelve contra el contacto antes de autorizar', async () => {
    const antes = guardados.length;
    await handleMessage({
      from: '236372620518922@lid',
      contacto: { number: `${ANA}@c.us` },
      body: 'hola',
      type: 'chat',
    });
    assert.strictEqual(guardados.length, antes + 1);
    // Y se guarda con el telefono real, no con el id opaco.
    assert.strictEqual(guardados[guardados.length - 1].from, ANA);
  });

  await check('un @lid sin contacto resoluble se descarta', async () => {
    const antes = { guardados: guardados.length, llamadasIA };
    await handleMessage({
      from: '236372620518999@lid',
      body: 'hola',
      type: 'chat',
    });
    assert.strictEqual(guardados.length, antes.guardados);
    assert.strictEqual(llamadasIA, antes.llamadasIA);
  });

  await check('en un grupo se autoriza al que escribe, no al grupo', async () => {
    const antes = guardados.length;
    await handleMessage({
      from: '120363000000000000@g.us',
      author: `${ANA}@c.us`,
      body: 'hola',
      type: 'chat',
    });
    assert.strictEqual(guardados.length, antes + 1);
    const ultimo = guardados[guardados.length - 1];
    assert.strictEqual(ultimo.chatId, '120363000000000000');
    assert.strictEqual(ultimo.from, ANA, 'debe atribuirse a la persona');
  });

  await check('un revocado en un grupo tampoco entra', async () => {
    const antes = { guardados: guardados.length, llamadasIA };
    await handleMessage({
      from: '120363000000000000@g.us',
      author: `${OTRO}@c.us`,
      body: 'hola',
      type: 'chat',
    });
    assert.strictEqual(guardados.length, antes.guardados);
    assert.strictEqual(llamadasIA, antes.llamadasIA);
  });

  await check('un estado de WhatsApp no se procesa', async () => {
    const antes = { guardados: guardados.length, llamadasIA };
    await handleMessage({ from: `${ANA}@c.us`, body: '', type: 'e2e_notification' });
    assert.strictEqual(guardados.length, antes.guardados);
    assert.strictEqual(llamadasIA, antes.llamadasIA);
  });

  await check('un estado de WhatsApp no se procesa ni llama a la IA', async () => {
    const antes = { g: guardados.length, ia: llamadasIA };
    await handleMessage({
      from: 'status@broadcast',
      body: 'un estado con texto',
      type: 'chat',
    });
    assert.strictEqual(guardados.length, antes.g, 'no debe guardar');
    assert.strictEqual(llamadasIA, antes.ia, 'no debe llamar a la IA');
  });

  await check('un desconocido recibe el saludo fijo, sin IA y sin guardar', async () => {
    const desconocido = '595977778888';
    const antes = { g: guardados.length, ia: llamadasIA, s: saludosEnviados.length };
    await handleMessage(msgPrivado(`${desconocido}@c.us`, 'hola, tienen delivery?'));
    assert.strictEqual(saludosEnviados.length, antes.s + 1, 'debe saludar');
    const saludo = saludosEnviados[saludosEnviados.length - 1];
    assert.strictEqual(saludo.phone, desconocido);
    assert.ok(
      saludo.texto.includes('Administrador General Chicolin'),
      'debe presentarse con el nombre del bot'
    );
    assert.ok(saludo.texto.includes('en breve le estaremos respondiendo'), 'texto pedido');
    assert.strictEqual(llamadasIA, antes.ia, 'el saludo NO debe llamar a la IA');
    assert.strictEqual(guardados.length, antes.g, 'el mensaje NO se guarda');
  });

  await check('el saludo automatico no se repite con cada mensaje', async () => {
    const desconocido = '595976666666';
    const antes = saludosEnviados.length;
    await handleMessage(msgPrivado(`${desconocido}@c.us`, 'hola'));
    await handleMessage(msgPrivado(`${desconocido}@c.us`, 'estan?'));
    await handleMessage(msgPrivado(`${desconocido}@c.us`, 'holis'));
    assert.strictEqual(saludosEnviados.length, antes + 1, 'solo un saludo por ventana');
  });

  await check('hola de un autorizado no gasta un token', async () => {
    const antes = { ia: llamadasIA, loc: respuestasLocales };
    const r = await handleMessage(msgPrivado(`${ANA}@c.us`, 'hola'));
    assert.ok(r, 'debe responder');
    assert.strictEqual(respuestasLocales, antes.loc + 1, 'debe ser respuesta local');
    assert.strictEqual(llamadasIA, antes.ia, 'no debe llamar a la IA');
  });

  await check('gracias y ok tampoco gastan un token', async () => {
    const antes = llamadasIA;
    await handleMessage(msgPrivado(`${ANA}@c.us`, 'gracias!'));
    await handleMessage(msgPrivado(`${ANA}@c.us`, 'perfecto'));
    assert.strictEqual(llamadasIA, antes, 'cero llamadas a la IA');
  });

  await check('una consulta de verdad si usa la IA', async () => {
    const antes = llamadasIA;
    await handleMessage(msgPrivado(`${ANA}@c.us`, 'quiero agendar una reunion manana'));
    assert.strictEqual(llamadasIA, antes + 1, 'debe llamar a la IA');
  });

  console.log(
    `\n${passed} comprobaciones OK ` +
    `(guardados: ${guardados.length}, IA: ${llamadasIA}, ` +
    `locales: ${respuestasLocales}, saludos: ${saludosEnviados.length})\n`
  );
})();
