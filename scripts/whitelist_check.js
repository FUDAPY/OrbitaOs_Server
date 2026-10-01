'use strict';
// OrbitaOs - pruebas de las reglas de autorizacion de WhatsApp.
//
// No toca MongoDB ni el navegador: src/whitelist.js es puro a proposito, asi
// que los cuatro casos que importan en produccion se comprueban aqui:
// usuario autorizado, usuario revocado, numero del bot y formato alternativo.

const assert = require('assert');
const wl = require('../src/whitelist');

const BOT = '595981234567';
const AUTORIZADO = '595991112222';

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}: ${err.message}`);
    process.exitCode = 1;
  }
}

/** Simula la coleccion User: solo phone + allowed, que es lo que decide. */
function usuarios(lista) {
  return lista.map(([phone, allowed]) => ({ phone: wl.normalizePhone(phone), allowed }));
}

/** Igual que users.isAllowedPhone, pero contra una lista en memoria. */
function permitidoEn(base, phone) {
  return base.some((u) => u.allowed && wl.mismoTelefono(u.phone, phone));
}

/** Veredicto igual al de index.js, pero sin depender de MongoDB. */
function veredicto(senderId, base, botPhone = BOT) {
  return wl.autorizar({
    senderId,
    botPhone,
    permitido: (phone) => permitidoEn(base, phone),
  });
}

/* -------------------------------------------------------------------------
 * 1) Usuario autorizado
 * ---------------------------------------------------------------------- */

const BASE_OK = usuarios([[AUTORIZADO, true]]);

console.log('\nUsuario autorizado');

check('un autorizado con @c.us pasa', () => {
  const r = veredicto(`${AUTORIZADO}@c.us`, BASE_OK);
  assert.strictEqual(r.permitido, true);
  assert.strictEqual(r.motivo, wl.MOTIVOS.AUTORIZADO);
  assert.strictEqual(r.phone, AUTORIZADO);
});

check('un autorizado con @s.whatsapp.net pasa', () => {
  assert.strictEqual(veredicto(`${AUTORIZADO}@s.whatsapp.net`, BASE_OK).permitido, true);
});

check('un desconocido se descarta', () => {
  const r = veredicto('595998887777@c.us', BASE_OK);
  assert.strictEqual(r.permitido, false);
  assert.strictEqual(r.motivo, wl.MOTIVOS.NO_AUTORIZADO);
});

/* -------------------------------------------------------------------------
 * 2) Usuario revocado
 * ---------------------------------------------------------------------- */

console.log('\nUsuario revocado');

check('allowed=false pierde el acceso', () => {
  const r = veredicto(`${AUTORIZADO}@c.us`, usuarios([[AUTORIZADO, false]]));
  assert.strictEqual(r.permitido, false);
  assert.strictEqual(r.motivo, wl.MOTIVOS.NO_AUTORIZADO);
});

check('reactivar allowed=true devuelve el acceso', () => {
  const base = usuarios([[AUTORIZADO, false]]);
  assert.strictEqual(veredicto(`${AUTORIZADO}@c.us`, base).permitido, false);
  base[0].allowed = true;
  assert.strictEqual(veredicto(`${AUTORIZADO}@c.us`, base).permitido, true);
});

check('un revocado no habilita a otro numero', () => {
  const base = usuarios([[AUTORIZADO, false], ['595993334444', false]]);
  assert.strictEqual(veredicto('595993334444@c.us', base).permitido, false);
});

/* -------------------------------------------------------------------------
 * 3) Numero del bot
 * ---------------------------------------------------------------------- */

console.log('\nNumero del bot');

check('BOT_PHONE no se autoriza a si mismo', () => {
  const r = veredicto(`${BOT}@c.us`, BASE_OK);
  assert.strictEqual(r.permitido, false);
  assert.strictEqual(r.motivo, wl.MOTIVOS.BOT);
});

check('BOT_PHONE sigue siendo bot con formato alterno', () => {
  const r = veredicto('+595 981 234-567@c.us', BASE_OK);
  assert.strictEqual(r.permitido, false);
  assert.strictEqual(r.motivo, wl.MOTIVOS.BOT);
});

/* -------------------------------------------------------------------------
 * 4) Formato alternativo
 * ---------------------------------------------------------------------- */

console.log('\nFormato alternativo del telefono');

check('normaliza espacios, signos y el sufijo', () => {
  assert.strictEqual(wl.normalizePhone('+595 981-234 567'), '595981234567');
  assert.strictEqual(wl.normalizePhone('595981234567@c.us'), '595981234567');
  assert.strictEqual(wl.normalizePhone('595981234567@s.whatsapp.net'), '595981234567');
  assert.strictEqual(wl.normalizePhone('(595) 981 234567'), '595981234567');
  assert.strictEqual(wl.normalizePhone(undefined), '');
  assert.strictEqual(wl.normalizePhone(null), '');
});

check('los espacios no cambian el veredicto', () => {
  const r = veredicto('+595 991 112 222 @c.us', BASE_OK);
  assert.strictEqual(r.permitido, true);
  assert.strictEqual(r.phone, AUTORIZADO);
});

check('guardado con codigo de pais, recibido sin el', () => {
  // El caso que rompia la lista blanca: en la base estaba con prefijo y desde
  // el celu llegaba el numero local.
  const base = usuarios([[AUTORIZADO, true]]);
  assert.strictEqual(veredicto('0991112222@c.us', base).permitido, true);
});

check('guardado sin codigo de pais, recibido con el', () => {
  const base = usuarios([['0991112222', true]]);
  assert.strictEqual(veredicto(`${AUTORIZADO}@c.us`, base).permitido, true);
});

check('dos numeros distintos siguen siendo distintos', () => {
  assert.strictEqual(wl.mismoTelefono(AUTORIZADO, '595993334444'), false);
  assert.strictEqual(wl.mismoTelefono(AUTORIZADO, ''), false);
  assert.strictEqual(wl.mismoTelefono('', ''), false);
});

check('un numero muy corto no se compara por cola', () => {
  // Menos de 9 digitos de cola seria choque entre numeros distintos.
  assert.strictEqual(wl.mismoTelefono('5951234', '81234'), false);
  assert.ok(wl.variantes('5951234').every((v) => v.length >= 7));
});

check('mismoTelefono no confunde prefijos distintos', () => {
  assert.strictEqual(wl.mismoTelefono('5959812345', '59819812345'), false);
});

check('BOT_PHONE no habilita a quien lo tiene en la lista', () => {
  // Que el bot este dado de alta como usuario NO lo convierte en autorizado:
  // la lista blanca es de remitentes, no del bot.
  const r = veredicto(`${BOT}@c.us`, usuarios([[BOT, true]]), BOT);
  assert.strictEqual(r.permitido, false);
  assert.strictEqual(r.motivo, wl.MOTIVOS.BOT);
});

check('sin BOT_PHONE definido no hay numero del bot', () => {
  const r = veredicto(`${BOT}@c.us`, BASE_OK, '');
  assert.strictEqual(r.permitido, false);
  assert.strictEqual(r.motivo, wl.MOTIVOS.NO_AUTORIZADO);
});

check('otro numero con la misma cola no es el bot', () => {
  // 595998887777 comparte tres digitos finales con el bot, pero no es el bot.
  assert.strictEqual(veredicto('595998887777@c.us', BASE_OK).motivo, wl.MOTIVOS.NO_AUTORIZADO);
});

/* -------------------------------------------------------------------------
 * 5) Identificadores de WhatsApp
 * ---------------------------------------------------------------------- */

console.log('\nIdentificadores de WhatsApp');

check('distingue grupos de chats privados', () => {
  assert.strictEqual(wl.esGrupo('120363000000000000@g.us'), true);
  assert.strictEqual(wl.esGrupo('595981234567@c.us'), false);
  assert.strictEqual(wl.esLid('236372620518922@lid'), true);
  assert.strictEqual(wl.esLid('595981234567@c.us'), false);
});

check('en grupos el remitente es el autor, no el grupo', () => {
  assert.strictEqual(
    wl.remitenteDe({ from: '120363000000000000@g.us', author: `${AUTORIZADO}@c.us` }),
    `${AUTORIZADO}@c.us`
  );
  // Sin autor declarado cae al from, que es lo mejor que se puede hacer.
  assert.strictEqual(wl.remitenteDe({ from: '120363000000000000@g.us' }), '120363000000000000@g.us');
  assert.strictEqual(wl.remitenteDe({ from: `${AUTORIZADO}@c.us` }), `${AUTORIZADO}@c.us`);
});

check('un id @lid no se toma por telefono sin resolver', () => {
  // El id no es el numero: la resolucion contra el contacto la hace index.js.
  // Lo que se comprueba aca es que el id, por si solo, no autoriza a nadie.
  const r = veredicto('236372620518922@lid', BASE_OK);
  assert.strictEqual(r.permitido, false);
});

check('un mensaje sin remitente se descarta con motivo propio', () => {
  const r = wl.autorizar({ senderId: '', botPhone: BOT, permitido: () => true });
  assert.strictEqual(r.permitido, false);
  assert.strictEqual(r.motivo, wl.MOTIVOS.SIN_TELEFONO);
});

check('un remitente vacio no alcanza para autorizar', () => {
  const r = wl.autorizar({ senderId: '@c.us', botPhone: BOT, permitido: () => true });
  assert.strictEqual(r.permitido, false);
  assert.strictEqual(r.motivo, wl.MOTIVOS.SIN_TELEFONO);
});

/* -------------------------------------------------------------------------
 * 6) Privacidad en los logs
 * ---------------------------------------------------------------------- */

console.log('\nLogs');

check('enmascara el telefono para no publicarlo entero', () => {
  assert.strictEqual(wl.enmascarar(AUTORIZADO), '***222');
  assert.strictEqual(wl.enmascarar('595981234567@c.us'), '***567');
  assert.strictEqual(wl.enmascarar(''), 'desconocido');
  assert.strictEqual(wl.enmascarar('12'), '***12');
  assert.ok(!wl.enmascarar(AUTORIZADO).includes('59599'));
});

check('el motivo siempre viene informado', () => {
  for (const sender of ['', `${BOT}@c.us`, '595998887777@c.us', `${AUTORIZADO}@c.us`]) {
    const r = veredicto(sender, BASE_OK);
    assert.ok(r.motivo, `sin motivo para ${sender}`);
    assert.strictEqual(typeof r.permitido, 'boolean');
  }
});

/* -------------------------------------------------------------------------
 * 7) Tipos de mensaje
 * ---------------------------------------------------------------------- */

console.log('\nTipos de mensaje');
/* -------------------------------------------------------------------------
 * 8) Integracion: index.js usa estas reglas
 * ---------------------------------------------------------------------- */

console.log('\nIntegracion con index.js');

check('index.js delega la autorizacion en src/whitelist', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.ok(src.includes("require('./src/whitelist')"), 'debe cargar el modulo');
  assert.ok(src.includes('whitelist.autorizar'), 'debe usar el veredicto');
  assert.ok(src.includes('users.isAllowedPhone'), 'debe consultar la base');
  // Y no debe quedar la authorization vieja, que solo comparaba msg.from.
  assert.ok(!src.includes('isAllowed(msg.from)'), 'no debe usar el gate viejo');
});

check('la lista blanca se consulta antes de guardar el mensaje', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const gate = src.indexOf('autorizarRemitente(remitente.phone)');
  const corte = src.indexOf('if (!veredicto.permitido) return;');
  // La definicion de persistMessage esta antes en el archivo: se busca la
  // llamada, que es la que importa, despues del gate.
  const guardar = src.indexOf('await persistMessage({', corte);
  assert.ok(gate > 0 && corte > gate, 'el gate debe existir y cortar');
  assert.ok(guardar > corte, 'no debe guardar antes de autorizar');
});

check('index.js resuelve el remitente antes de autorizar', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.ok(src.includes('resolverRemitente'), 'debe resolver el remitente');
  assert.ok(src.includes('msg.getContact()'), 'debe resolver los ids @lid');
  const resolver = src.indexOf('const remitente = await resolverRemitente(msg);');
  const gate = src.indexOf('autorizarRemitente(remitente.phone)');
  assert.ok(resolver > 0 && resolver < gate, 'debe resolver antes de autorizar');
});

check('el log de whitelist dice el motivo y no el telefono entero', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.ok(src.includes('mensaje ignorado'), 'debe avisar que se ignoro');
  assert.ok(src.includes('veredicto.motivo'), 'debe decir el motivo');
  assert.ok(src.includes('whitelist.enmascarar'), 'debe enmascarar el telefono');
});

check('src/users.js comparte el criterio de normalizacion', () => {
  const users = require('../src/users');
  assert.strictEqual(users.normalizePhone('+595 981 234-567@c.us'), '595981234567');
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'users.js'), 'utf8');
  assert.ok(src.includes("require('./whitelist')"), 'debe cargar el modulo');
  // La lista blanca tiene que buscar por variantes, no solo coincidencia exacta.
  assert.ok(src.includes('whitelist.variantes'), 'debe tolerar formatos');
});

check('el CLI de whitelist puede diagnosticar un numero', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'whitelist.js'),
    'utf8'
  );
  assert.ok(src.includes("case 'check'"), 'debe exponer el comando check');
  assert.ok(src.includes('TIENE ACCESO'), 'debe dar un veredicto legible');
});

console.log(`\n${passed} comprobaciones OK\n`);


check('lista los tipos que no son conversacion', () => {
  for (const t of ['revoked', 'e2e_notification', 'notification']) {
    assert.ok(wl.TIPOS_DE_SISTEMA.includes(t), `falta ${t}`);
  }
  assert.ok(!wl.TIPOS_DE_SISTEMA.includes('chat'));
});
