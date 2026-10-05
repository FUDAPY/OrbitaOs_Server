'use strict';
// OrbitaOs - regresion: NINGUN usuario se crea solo.
//
// El gate de lista blanca ya impedia que un desconocido llegara a la IA, pero
// existian DOS caminos por los que un numero recibia cuenta sin que nadie lo
// autorizara:
//
//   1. getOrCreateUser() daba de alta en caliente a quien estuviera permitido
//      pero sin ficha de usuario.
//   2. El arranque creaba un usuario por cada telefono de WHITELIST.
//
// Este script verifica que esas dos puertas estan cerradas. Lee el codigo
// fuente de index.js porque las funciones dependen de MongoDB: lo que se
// comprueba es el COMPORTAMIENTO DECLARADO, y los casos que si se pueden
// ejercitar sin base se ejecutan de verdad.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const wl = require('../src/whitelist');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

let passed = 0;
function check(nombre, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${nombre}`);
  } catch (err) {
    console.error(`  FAIL ${nombre}: ${err.message}`);
    process.exitCode = 1;
  }
}

/** Recorta el cuerpo de una funcion para poder inspeccionarlo. */
function cuerpoDe(nombre) {
  const i = src.indexOf(`async function ${nombre}`);
  assert.ok(i > 0, `debe existir ${nombre}()`);
  const fin = src.indexOf('\n}\n', i);
  return src.slice(i, fin);
}

console.log('alta_check · no se crean usuarios automaticamente');

/* --- 1) getOrCreateUser no crea ------------------------------------------ */

check('getOrCreateUser NO llama a User.create', () => {
  const cuerpo = cuerpoDe('getOrCreateUser');
  assert.ok(
    !cuerpo.includes('User.create'),
    'no debe crear usuarios: el alta tiene que ser explicita'
  );
});

check('getOrCreateUser NO concede acceso al que no esta registrado', () => {
  const cuerpo = cuerpoDe('getOrCreateUser');
  // Si no hay ficha, devuelve un perfil de solo lectura con allowed: false.
  assert.ok(cuerpo.includes('allowed: false'), 'el perfil de reserva no habilita acceso');
  assert.ok(
    !/allowed:\s*true/.test(cuerpo),
    'no debe devolver un perfil con acceso habilitado'
  );
});

check('getOrCreateUser sigue resolviendo el usuario ya registrado', () => {
  const cuerpo = cuerpoDe('getOrCreateUser');
  assert.ok(cuerpo.includes('findByPhone'), 'debe buscar el usuario existente');
});

/* --- 2) El arranque no crea usuarios desde WHITELIST ---------------------- */

check('el arranque NO crea usuarios desde WHITELIST', () => {
  // El bloque de WHITELIST en main() no debe crear nada.
  const i = src.indexOf('const envPhones = envWhitelist();');
  assert.ok(i > 0, 'debe seguir leyendo WHITELIST para el diagnostico');
  const bloque = src.slice(i, i + 900);
  assert.ok(
    !bloque.includes('User.create'),
    'WHITELIST no debe crear usuarios: solo avisar los que no tienen ficha'
  );
});

check('el arranque AVISA de los numeros sin ficha en vez de crearlos', () => {
  const i = src.indexOf('const envPhones = envWhitelist();');
  const bloque = src.slice(i, i + 900);
  assert.ok(bloque.includes('findByPhone'), 'debe comprobar si existe la ficha');
  assert.ok(bloque.includes('console.warn'), 'debe avisar por log, no crear');
});

/* --- 3) /agregar exige nombre y respeta el rol --------------------------- */

check('/agregar exige el nombre para dar de alta', () => {
  const cuerpo = cuerpoDe('commandAddContact');
  assert.ok(cuerpo.includes('Necesito el *nombre*'), 'sin nombre no debe dar de alta');
});

check('/agregar usa el rol informado en vez de member fijo', () => {
  const cuerpo = cuerpoDe('commandAddContact');
  assert.ok(!/role:\s*'member'/.test(cuerpo), 'no debe dejar member fijo: el rol se informa');
  assert.ok(cuerpo.includes('role: rol'), 'debe guardar el rol indicado');
});

check('/agregar valida el rol contra una lista cerrada', () => {
  const cuerpo = cuerpoDe('commandAddContact');
  assert.ok(cuerpo.includes("['admin', 'supervisor', 'member']"), 'debe validar el rol');
});

/* --- 4) El gate sigue siendo la unica puerta ----------------------------- */

check('el gate va antes de guardar y antes de la IA', () => {
  // Ojo: hay DOS cortes con este codigo. El primero esta dentro de
  // autorizarRemitente (registra el motivo y devuelve). El que importa es el de
  // handleMessage, que es el que corta el pipeline. Se busca ese, no el primero.
  const gate = src.indexOf('const veredicto = await autorizarRemitente(remitente.phone);');
  assert.ok(gate > 0, 'handleMessage debe resolver la autorizacion');
  const corte = src.indexOf('if (!veredicto.permitido) {', gate);
  assert.ok(corte > gate, 'el corte debe ir despues de resolver la autorizacion');
  assert.ok(
    src.indexOf('await persistMessage({', corte) > corte,
    'el mensaje se guarda despues del gate, no antes'
  );
  assert.ok(
    src.indexOf('ai.route(', corte) > corte,
    'la IA se consulta despues del gate, no antes'
  );
});

check('el corte del gate corta el pipeline con return', () => {
  const gate = src.indexOf('const veredicto = await autorizarRemitente(remitente.phone);');
  const corte = src.indexOf('if (!veredicto.permitido) {', gate);
  // Ventana amplia: el bloque incluye comentarios y el saludo automatico.
  const bloque = src.slice(corte, corte + 700);
  assert.ok(bloque.includes('return;'), 'un no autorizado debe terminar aqui');
  assert.ok(
    bloque.indexOf('return;') < bloque.indexOf('entradas.autorizados += 1'),
    'el return va antes de contar al autorizado'
  );
});

/* --- 5) Casos que se ejercitan de verdad, sin base de datos --------------- */

check('un numero desconocido NO pasa la lista blanca', () => {
  const v = wl.autorizar({
    senderId: '595999999999@c.us',
    botPhone: '595981234567',
    permitido: () => false,
  });
  assert.strictEqual(v.permitido, false);
  assert.strictEqual(v.motivo, wl.MOTIVOS.NO_AUTORIZADO);
});

check('un numero con ficha habilitada SI pasa la lista blanca', () => {
  const permitido = (p) => wl.mismoTelefono(p, '595991112222');
  const v = wl.autorizar({
    senderId: '595991112222@c.us',
    botPhone: '595981234567',
    permitido,
  });
  assert.strictEqual(v.permitido, true);
});

check('el bot no se autoriza a si mismo', () => {
  const v = wl.autorizar({
    senderId: '595981234567@c.us',
    botPhone: '595981234567',
    permitido: () => true,
  });
  assert.strictEqual(v.permitido, false);
  assert.strictEqual(v.motivo, wl.MOTIVOS.BOT);
});

console.log(`alta_check · ${passed} comprobaciones OK`);