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

  const senderId = wl.remitenteDe(msg);
  const { phone: resuelto } = await resolverRemitente(msg);
  if (!resuelto) return;

  const veredicto = wl.autorizar({
    senderId: resuelto,
    botPhone,
    permitido: isAllowedPhone,
  });
  if (!veredicto.permitido) return;

  const autorizado = findAllowedByPhone(resuelto);
  const phone = (autorizado && autorizado.phone) || resuelto;
  const chatId = isGroup ? wl.normalizePhone(msg.from) : phone;
  guardados.push({ chatId, from: phone, body });

  llamadasIA += 1;
  respuestas += 1;
  return 'respuesta';
}

/** Copia resolverRemitente: resuelve los ids @lid contra la ficha del contacto. */
async function resolverRemitente(msg) {
  const senderId = wl.remitenteDe(msg);
  const directo = wl.normalizePhone(senderId);
  if (directo && !wl.esLid(senderId) && /^\d{8,15}$/.test(directo)) {
    return { phone: directo, senderId };
  }
  const numero = wl.normalizePhone(msg.contacto && msg.contacto.number);
  if (numero && /^\d{8,15}$/.test(numero)) return { phone: numero, senderId };
  return { phone: wl.esLid(senderId) ? '' : directo, senderId };
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
    const r = await handleMessage(msgPrivado(`${ANA}@c.us`, 'hola'));
    assert.ok(r, 'debe responder');
    assert.strictEqual(llamadasIA, 1);
    assert.strictEqual(guardados.length, 1);
    assert.strictEqual(guardados[0].from, ANA);
    assert.strictEqual(guardados[0].body, 'hola');
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

  console.log(
    `\n${passed} comprobaciones OK ` +
    `(guardados: ${guardados.length}, llamadas a la IA: ${llamadasIA}, ` +
    `respuestas: ${respuestas})\n`
  );
})();
