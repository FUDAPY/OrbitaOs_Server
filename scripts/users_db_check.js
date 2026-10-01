'use strict';
// OrbitaOs - prueba del CRUD de usuarios contra un MongoDB real.

process.env.MONGO_URI =
  process.env.MONGO_URI || 'mongodb://localhost:27017/orbitaos_test';

const assert = require('assert');
const db = require('../src/database');
const users = require('../src/users');

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

(async () => {
  console.log(`\nConectando a ${process.env.MONGO_URI}...`);
  try {
    await db.connect(process.env.MONGO_URI);
  } catch (err) {
    console.error(`\nNo se pudo conectar: ${err.message}`);
    console.error('Levanta MongoDB o corrige MONGO_URI.');
    process.exit(1);
  }

  // Se limpia solo esta coleccion de prueba.
  await db.User.deleteMany({});
  console.log('\nCRUD de usuarios contra MongoDB\n');

  await check('crea el usuario owner inicial', async () => {
    delete process.env.ADMIN_USERNAME;
    delete process.env.ADMIN_PASSWORD;
    process.env.ADMIN_PHONE = '54911123456789';
    const r = await users.ensureBootstrapUser();
    assert.strictEqual(r.created, true);
    assert.strictEqual(r.username, 'thesadboypy');
  });

  await check('el bootstrap no duplica al segundo arranque', async () => {
    const r = await users.ensureBootstrapUser();
    assert.strictEqual(r.created, false);
  });

  await check('crea un segundo usuario', async () => {
    const u = await users.createUser({
      username: 'operador',
      password: 'clave123',
      name: 'Operador de Turno',
      role: 'admin',
    });
    assert.strictEqual(u.username, 'operador');
    assert.strictEqual(u.role, 'admin');
  });

  await check('no devuelve el hash de la contrasena', async () => {
    const u = await users.createUser({ username: 'tercero', password: 'clave456' });
    assert.strictEqual(u.passwordHash, undefined);
    const lista = await users.listUsers();
    assert.ok(lista.every((x) => x.passwordHash === undefined));
  });

  await check('rechaza un usuario duplicado', async () => {
    await assert.rejects(
      () => users.createUser({ username: 'operador', password: 'otra123' }),
      /ya existe/
    );
  });

  await check('rechaza una contrasena corta', async () => {
    await assert.rejects(
      () => users.createUser({ username: 'corto', password: '123' }),
      /al menos 6/
    );
  });

  await check('rechaza un telefono duplicado', async () => {
    await assert.rejects(
      () =>
        users.createUser({
          username: 'otro',
          password: 'clave123',
          phone: '54911123456789',
        }),
      /ya esta asociado/
    );
  });

  await check('autentica con la contrasena correcta', async () => {
    const u = await users.authenticate('thesadboypy', '741963');
    assert.ok(u, 'debe autenticar');
    assert.strictEqual(u.username, 'thesadboypy');
    assert.strictEqual(u.passwordHash, undefined);
  });

  await check('rechaza la contrasena incorrecta', async () => {
    assert.strictEqual(await users.authenticate('thesadboypy', 'incorrecta'), null);
  });

  await check('rechaza un usuario inexistente', async () => {
    assert.strictEqual(await users.authenticate('fantasma', '741963'), null);
  });

  await check('cambia el nombre', async () => {
    const u = await users.renameUser('operador', 'Jefe de Operaciones');
    assert.strictEqual(u.name, 'Jefe de Operaciones');
  });

  await check('cambia la contrasena', async () => {
    await users.changePassword('operador', 'nuevaclave');
    assert.ok(await users.authenticate('operador', 'nuevaclave'));
    assert.strictEqual(await users.authenticate('operador', 'clave123'), null);
  });

  await check('no puede borrar al unico owner', async () => {
    await assert.rejects(() => users.deleteUser('thesadboypy'), /unico owner/);
  });

  await check('elimina un usuario normal', async () => {
    const r = await users.deleteUser('tercero');
    assert.strictEqual(r.username, 'tercero');
    assert.strictEqual((await users.listUsers()).length, 2);
  });

  await check('la lista blanca acepta el telefono del owner', async () => {
    assert.strictEqual(await users.isAllowedPhone('54911123456789'), true);
    assert.strictEqual(await users.isAllowedPhone('54911123456789@c.us'), true);
  });

  await check('la lista blanca tolera el formato del telefono', async () => {
    // Guardado con codigo de pais y recibido como numero local: es el caso que
    // hacia que el numero autorizado no recibiera respuesta.
    assert.strictEqual(await users.isAllowedPhone('01112345678'), true);
    assert.strictEqual(await users.isAllowedPhone('+54 9 11 1234-5678'), true);
    assert.strictEqual(await users.isAllowedPhone(' 549 11 1234 5678 '), true);
    // Y al reves: guardado corto, recibido completo.
    await db.User.updateOne(
      { username: 'thesadboypy' },
      { $set: { phone: '01112345678' } }
    );
    assert.strictEqual(await users.isAllowedPhone('54911123456789@c.us'), true);
    await db.User.updateOne(
      { username: 'thesadboypy' },
      { $set: { phone: '54911123456789' } }
    );
  });

  await check('findByPhone encuentra aunque el formato difiera', async () => {
    const u = await users.findByPhone('01112345678');
    assert.ok(u, 'debe encontrarlo');
    assert.strictEqual(u.username, 'thesadboypy');
  });

  await check('la lista blanca rechaza un desconocido', async () => {
    assert.strictEqual(await users.isAllowedPhone('54911999999999'), false);
  });

  await check('un usuario con allowed=false pierde el acceso', async () => {
    await db.User.updateOne(
      { username: 'operador' },
      { $set: { allowed: false } }
    );
    assert.strictEqual(await users.isAllowedPhone('54911123456789'), true);
    assert.strictEqual(await users.isAllowedPhone('54911999999999'), false);
  });

  await check('un allowed=false explicito tampoco pasa por variante', async () => {
    // El caso revocado: el usuario existe pero no tiene acceso. Ninguna
    // variante de su telefono debe reentrar por la puerta de atras.
    await db.User.create({
      username: 'revocado',
      passwordHash: 'x',
      phone: '549118887777',
      name: 'Revocado',
      role: 'member',
      allowed: false,
    });
    assert.strictEqual(await users.isAllowedPhone('549118887777'), false);
    assert.strictEqual(await users.isAllowedPhone('0118887777'), false);
    assert.strictEqual(await users.isAllowedPhone('+54 9 11 888 7777'), false);
    // Reactivarlo si.
    await db.User.updateOne({ username: 'revocado' }, { $set: { allowed: true } });
    assert.strictEqual(await users.isAllowedPhone('0118887777'), true);
  });

  // Limpieza: solo la coleccion de esta prueba.
  await db.User.deleteMany({});
  console.log('\n(coleccion de prueba limpiada)\n');

  await db.disconnect();
  console.log(`${passed} comprobaciones OK\n`);
  process.exit(process.exitCode || 0);
})();
