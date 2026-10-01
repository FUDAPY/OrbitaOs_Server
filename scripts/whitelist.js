'use strict';
// OrbitaOs - gestion de la lista blanca desde la linea de comandos.

require('dotenv').config();

const db = require('../src/database');
const users = require('../src/users');
const whitelist = require('../src/whitelist');

const AYUDA = `
Lista blanca de OrbitaOs

  list                       muestra los contactos con acceso
  check <numero>             dice si un numero tiene acceso y por que
  add <numero> [--name N]    agrega un contacto y le da acceso
      --user <usuario>        lo asocia a un usuario existente
      --role owner|admin|member
      [--phone <numero>]      (alias de <numero>)
  remove <numero>            quita el acceso de un contacto
  allow <numero>             reactiva el acceso
  block <numero>             desactiva el acceso sin borrarlo
`.trim();

function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      pos.push(a);
    }
  }
  return { flags, pos };
}

async function main() {
  const argv = process.argv.slice(2);
  const comando = argv[0];

  if (!comando || comando === 'help' || comando === '--help') {
    console.log(AYUDA);
    return;
  }

  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('Falta MONGO_URI en el entorno.');
    process.exit(1);
  }
  await db.connect(uri);

  const { flags, pos } = parseArgs(argv.slice(1));
  // Acepta tanto `add 549...` como `add --phone 549...`.
  const phone = users.normalizePhone(pos[0] || flags.phone || '');

  switch (comando) {
    case 'list': {
      const lista = await db.User.find({ phone: { $ne: null } })
        .sort({ phone: 1 })
        .lean();
      if (!lista.length) {
        console.log('\nNo hay contactos en la lista blanca.');
        console.log('Agrega uno con: npm run whitelist -- add 54911123456789\n');
        break;
      }
      console.log('\nTELEFONO        ACCESO  ROL     NOMBRE');
      console.log('-'.repeat(62));
      for (const u of lista) {
        console.log(
          `${u.phone.padEnd(15)} ${(u.allowed ? 'si' : 'NO').padEnd(7)} ` +
          `${String(u.role).padEnd(7)} ${u.name || '-'}`
        );
      }
      console.log('');
      break;
    }

    case 'check': {
      if (!phone) {
        console.error('Uso: check <numero>');
        process.exit(1);
      }
      // Responde la pregunta "¿este numero puede hablar con el bot?" y por que
      // no, que es lo primero que hay que descartar cuando alguien no recibe
      // respuesta desde su celular.
      const botPhone = users.normalizePhone(process.env.BOT_PHONE || '');
      const usuario = await users.findByPhone(phone);
      const deEnv = (process.env.WHITELIST || '')
        .split(',')
        .map((p) => users.normalizePhone(p))
        .filter(Boolean)
        .some((p) => whitelist.mismoTelefono(p, phone));

      console.log(`\nNumero recibido : ${phone}`);
      console.log(`Coincide con el bot: ${whitelist.mismoTelefono(phone, botPhone) ? 'si' : 'no'}`);
      if (!usuario) {
        console.log('Usuario: no esta registrado');
      } else {
        console.log(`Usuario: ${usuario.username} (${usuario.role})`);
        console.log(`Telefono guardado: ${usuario.phone}`);
        console.log(`Acceso (allowed): ${usuario.allowed ? 'si' : 'NO'}`);
      }
      console.log(`Autorizado por WHITELIST: ${deEnv ? 'si' : 'no'}`);

      const acceso = await users.isAllowedPhone(phone);
      const esBot = whitelist.mismoTelefono(phone, botPhone);
      console.log(`\nVeredicto: ${acceso && !esBot ? 'TIENE ACCESO' : 'SIN ACCESO'}`);
      if (esBot) {
        console.log('Motivo: es el numero del bot, que no se autoriza a si mismo.');
      } else if (!usuario) {
        console.log('Motivo: no hay ningun usuario con ese telefono.');
        console.log('Solucion: npm run whitelist -- add ' + phone);
      } else if (!usuario.allowed) {
        console.log('Motivo: el usuario existe pero tiene allowed=false.');
        console.log('Solucion: npm run whitelist -- allow ' + phone);
      } else if (!acceso && !deEnv) {
        console.log('Motivo: el telefono guardado difiere del recibido.');
        console.log('Solucion: corrige el telefono en el panel o re-agregalo:');
        console.log('  npm run whitelist -- add ' + phone);
      }
      console.log('');
      process.exitCode = acceso && !esBot ? 0 : 1;
      break;
    }

    case 'add': {
      if (!phone) {
        console.error('Uso: add <numero> [--name "Nombre"] [--role admin]');
        process.exit(1);
      }

      // Si ya existe ese telefono, se actualiza en vez de duplicar.
      const existente = await db.User.findOne({ phone }).lean();
      const patch = { phone, allowed: true };
      if (flags.name) patch.name = flags.name;
      if (flags.role) patch.role = flags.role;

      if (existente) {
        await db.User.updateOne({ phone }, { $set: patch });
        console.log(`Actualizado: ${phone} (acceso: si)`);
        if (flags.user) {
          await db.User.updateOne(
            { username: users.normalizeUsername(flags.user) },
            { $set: { phone, allowed: true } }
          );
          console.log(`Vinculado al usuario "${flags.user}"`);
        }
        break;
      }

      if (flags.user) {
        // Asocia el telefono a un usuario ya creado.
        const u = await db.User.findOneAndUpdate(
          { username: users.normalizeUsername(flags.user) },
          { $set: { phone, allowed: true, ...(flags.name ? { name: flags.name } : {}) } },
          { new: true }
        );
        if (!u) {
          console.error(`No existe el usuario "${flags.user}"`);
          process.exitCode = 1;
          break;
        }
        console.log(`${u.username} ahora tiene acceso desde ${phone}`);
        break;
      }

      // Contacto nuevo, sin cuenta de acceso al panel: solo WhatsApp.
      await db.User.create({
        username: `wa${phone}`,
        passwordHash: 'sin-acceso-por-whatsapp',
        phone,
        name: flags.name || '',
        role: ['owner', 'admin', 'member'].includes(flags.role) ? flags.role : 'member',
        allowed: true,
      });
      console.log(`Agregado: ${phone} con acceso al bot`);
      if (flags.name) console.log(`Nombre: ${flags.name}`);
      break;
    }

    case 'remove': {
      if (!phone) {
        console.error('Uso: remove <numero>');
        process.exit(1);
      }
      const r = await db.User.deleteOne({ phone });
      console.log(
        r.deletedCount
          ? `Eliminado: ${phone}`
          : `No habia ningun contacto con ${phone}`
      );
      break;
    }

    case 'allow':
    case 'block': {
      if (!phone) {
        console.error(`Uso: ${comando} <numero>`);
        process.exit(1);
      }
      const r = await db.User.updateOne(
        { phone },
        { $set: { allowed: comando === 'allow' } }
      );
      console.log(
        r.matchedCount
          ? `${phone}: acceso ${comando === 'allow' ? 'habilitado' : 'deshabilitado'}`
          : `No hay contacto con ${phone}. Agregalo primero con: add ${phone}`
      );
      break;
    }

    default:
      console.error(`Comando desconocido: ${comando}\n`);
      console.log(AYUDA);
      process.exitCode = 1;
  }

  await db.disconnect();
}

main().catch(async (err) => {
  console.error(`Error: ${err.message}`);
  await db.disconnect().catch(() => {});
  process.exit(1);
});
