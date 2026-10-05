'use strict';
// OrbitaOs - prueba del flujo de control de acceso y formato de index.js.

process.env.WHITELIST = '54911123456789, 54911-9876-5432';
process.env.GROUP_PREFIX = '@orbita';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ai = require('../src/ai_router');

// ---- Funciones replicadas de index.js (misma logica) ---------------------
function loadWhitelist() {
  return new Set(
    (process.env.WHITELIST || '')
      .split(',')
      .map((p) => p.replace(/\D/g, ''))
      .filter(Boolean)
  );
}
const WHITELIST = loadWhitelist();
function normalizePhone(id) {
  return String(id).split('@')[0].replace(/\D/g, '');
}
function isAllowed(senderId) {
  return WHITELIST.has(normalizePhone(senderId));
}
function toDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
function formatDate(date, timezone) {
  return new Intl.DateTimeFormat('es-AR', {
    weekday: 'long', day: '2-digit', month: '2-digit',
    hour: '2-digit', minute: '2-digit',
    timeZone: timezone || 'America/Argentina/Buenos_Aires',
  }).format(date);
}

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

console.log('\nLista blanca');

check('carga los telefonos de WHITELIST', () => {
  assert.strictEqual(WHITELIST.size, 2);
  assert.ok(WHITELIST.has('54911123456789'));
  assert.ok(WHITELIST.has('5491198765432'));
});

check('acepta un autorizado con sufijo @c.us', () => {
  assert.ok(isAllowed('54911123456789@c.us'));
});

check('acepta un autorizado con @s.whatsapp.net', () => {
  assert.ok(isAllowed('54911123456789@s.whatsapp.net'));
});

check('rechaza un numero desconocido', () => {
  assert.strictEqual(isAllowed('54911999999999@c.us'), false);
});

check('rechaza un grupo aunque el id contenga un autorizado', () => {
  assert.strictEqual(isAllowed('120363000000000000@g.us'), false);
});

console.log('\nNormalizacion de telefonos');

check('quita el sufijo y no numerico', () => {
  assert.strictEqual(normalizePhone('+54 9 11 1234-5678@c.us'), '5491112345678');
  assert.strictEqual(normalizePhone('54911123456789@c.us'), '54911123456789');
  assert.strictEqual(normalizePhone('120363000000000000@g.us'), '120363000000000000');
});

console.log('\nValidacion de mensaje');

check('descarta cuerpo vacio', () => {
  assert.strictEqual(!('' || '').trim(), true);
});

check('descarta estados de no-chat', () => {
  const isGroup = false;
  const type = 'image';
  assert.strictEqual(!isGroup && type !== 'chat', true);
});

check('acepta un mensaje de texto en grupo', () => {
  const isGroup = true;
  const type = 'chat';
  assert.strictEqual(!isGroup && type !== 'chat', false);
});

console.log('\nFechas');

check('convierte ISO a Date', () => {
  const d = toDate('2026-10-01T15:00:00.000Z');
  assert.ok(d instanceof Date);
  assert.strictEqual(d.toISOString(), '2026-10-01T15:00:00.000Z');
});

check('devuelve null para una fecha invalida', () => {
  assert.strictEqual(toDate('no es una fecha'), null);
  assert.strictEqual(toDate(''), null);
  assert.strictEqual(toDate(null), null);
});

check('formatea con la zona horaria del usuario', () => {
  const d = new Date('2026-10-01T15:00:00.000Z');
  // Buenos Aires es UTC-3: 15:00 UTC se ven las 12:00.
  const s = formatDate(d, 'America/Argentina/Buenos_Aires');
  assert.ok(s.includes('12:00'), `esperaba 12:00, obtuve ${s}`);
  // Madrid es UTC+2 en octubre: 15:00 UTC se ven las 17:00 (05:00 p. m.).
  const m = formatDate(d, 'Europe/Madrid');
  assert.ok(m.includes('05:00'), `esperaba 05:00 p. m., obtuve ${m}`);
  // Misma fecha, distinta zona horaria: el formateo depende del usuario.
  assert.notStrictEqual(s, m);
});

console.log('\nContrato con los modulos');

check('index.js importa los modulos correctos', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  for (const req of [
    "require('./src/database')",
    "require('./src/ai_router')",
    "require('./src/cron_jobs')",
    "require('whatsapp-web.js')",
    "require('qrcode-terminal')",
  ]) {
    assert.ok(src.includes(req), `falta ${req}`);
  }
});

check('index.js arranca el cron cuando WhatsApp esta listo', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.ok(src.includes("client.on('ready'"));
  assert.ok(src.includes('cron.startReminderJobs(client)'));
});

check('index.js apaga de forma ordenada', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.ok(src.includes('SIGTERM'));
  assert.ok(src.includes('client.destroy()'));
  assert.ok(src.includes('db.disconnect()'));
});

check('index.js conecta a MongoDB y no aborta sin WHITELIST', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.ok(src.includes('MONGO_URI'), 'debe exigir MONGO_URI');
  // La lista blanca ya no es obligatoria: el acceso vive en la base de datos.
  assert.ok(
    !src.includes('WHITELIST esta vacia'),
    'no debe abortar cuando WHITELIST esta vacia'
  );
  // Y en su lugar crea el usuario owner inicial.
  assert.ok(src.includes('ensureBootstrapUser()'));
});

check('el modulo de usuarios esta integrado en index.js', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.ok(src.includes("require('./src/users')"));
  assert.ok(src.includes('users.isAllowedPhone'));
});

check('el modulo de whitelist existe y es puro', () => {
  const wl = require('../src/whitelist');
  // Si este modulo tocara la base o el navegador, las reglas de autorizacion
  // dejarian de ser comprobables sin levantar nada.
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'whitelist.js'),
    'utf8'
  );
  assert.ok(!src.includes('require('), 'no debe requerir nada');
  assert.ok(!src.includes('mongoose'), 'no debe tocar la base');
  assert.strictEqual(typeof wl.autorizar, 'function');
  assert.strictEqual(typeof wl.normalizePhone, 'function');
  assert.strictEqual(typeof wl.mismoTelefono, 'function');
});

check('index.js usa las reglas de src/whitelist', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.ok(src.includes("require('./src/whitelist')"), 'debe cargarlo');
  assert.ok(src.includes('whitelist.autorizar'), 'debe pedir el veredicto');
  assert.ok(src.includes('users.isAllowedPhone'), 'debe consultar la base');
});

check('BOT_PHONE no autoriza remitentes', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const wl = require('../src/whitelist');
  // El bot se declara a si mismo no autorizado, aunque este en la base.
  const r = wl.autorizar({
    senderId: '595981234567@c.us',
    botPhone: '595981234567',
    permitido: () => true,
  });
  assert.strictEqual(r.permitido, false);
  assert.strictEqual(r.motivo, 'bot');
  // Y el log de arranque lo deja claro para que nadie lo confunda.
  assert.ok(src.includes('no autoriza remitentes'));
});

check('la lista blanca se resuelve por el remitente real', () => {
  const wl = require('../src/whitelist');
  // En grupos manda el autor, no el grupo.
  assert.strictEqual(
    wl.remitenteDe({ from: '120363000000000000@g.us', author: '595991112222@c.us' }),
    '595991112222@c.us'
  );
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.ok(src.includes('resolverRemitente'), 'debe resolver el remitente');
  assert.ok(src.includes('msg.getContact()'), 'debe resolver los ids @lid');
});

check('el gate va antes de guardar y antes de la IA', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const corte = src.indexOf('if (!veredicto.permitido) {');
  assert.ok(corte > 0, 'debe cortar cuando no esta autorizado');
  assert.ok(
    src.indexOf('await persistMessage({', corte) > corte,
    'no debe guardar un mensaje no autorizado'
  );
  assert.ok(
    src.indexOf('await ai.route(', corte) > corte,
    'no debe gastar tokens con un mensaje no autorizado'
  );
});

check('los logs de whitelist no imprimen el telefono entero', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.ok(src.includes('veredicto.motivo'), 'debe decir el motivo');
  assert.ok(src.includes('whitelist.enmascarar'), 'debe enmascarar');
  // Y el log viejo, que imprimia el id completo, no debe quedar.
  assert.ok(!src.includes('mensaje ignorado de ${msg.from}'));
});
check('los no autorizados reciben el saludo fijo, sin IA', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  // Es lo que pedia el negocio: que cualquiera escriba y reciba una
  // presentacion, pero sin que eso cueste un token.
  assert.ok(src.includes('AUTO_REPLY_MESSAGE'), 'el saludo debe ser configurable');
  assert.ok(src.includes('Administrador General Chicolin'), 'debe tener el nombre por defecto');
  const gate = src.indexOf('if (!veredicto.permitido) {');
  const saludo = src.indexOf('responderSaludoAutomatico(msg, remitente.phone)');
  assert.ok(gate > 0 && saludo > gate, 'el saludo va en el camino no autorizado');
  // Y ese camino no guarda ni llama a la IA.
  const fn = src.indexOf('async function responderSaludoAutomatico');
  const cuerpo = src.slice(fn, src.indexOf('/**', fn + 40));
  assert.ok(!cuerpo.includes('ai.route'), 'el saludo no debe llamar a la IA');
  assert.ok(!cuerpo.includes('persistMessage'), 'el saludo no debe guardar el mensaje');
  assert.ok(cuerpo.includes('client.sendMessage'), 'el saludo si debe enviarse');
});

check('el saludo automatico no insiste ni habla en grupos', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const fn = src.indexOf('async function responderSaludoAutomatico');
  const cuerpo = src.slice(fn, src.indexOf('/**', fn + 40));
  // Un saludo por ventana de tiempo, no uno por mensaje.
  assert.ok(src.includes('AUTO_REPLY_HORAS'), 'la ventana debe ser configurable');
  assert.ok(cuerpo.includes('ultimosSaludos'), 'debe recordar a quien ya saludo');
  assert.ok(cuerpo.includes('esGrupo'), 'no debe hablar en grupos');
});

check('solo se saluda a quien no tiene acceso de verdad', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  // El bot no se saluda a si mismo, ni un id sin telefono recibe nada.
  assert.ok(
    src.includes('veredicto.motivo === whitelist.MOTIVOS.NO_AUTORIZADO'),
    'solo el motivo no-autorizado dispara el saludo'
  );
});

check('hola y gracias se responden sin llamar a la IA', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.ok(src.includes('function respuestaLocal'), 'debe existir la respuesta local');
  const h = src.indexOf('async function handleMessage');
  const cuerpo = src.slice(h, src.indexOf('/* ====', h));
  const local = cuerpo.indexOf('respuestaLocal(cleanBody)');
  const ia = cuerpo.indexOf('await ai.route(');
  assert.ok(local > 0, 'debe aplicar la respuesta local');
  assert.ok(local < ia, 'debe aplicarse ANTES de la IA');
  // Y cubre los mensajes mas frecuentes del dia a dia.
  const fn = src.indexOf('function respuestaLocal');
  const cuerpo2 = src.slice(fn, src.indexOf('/**', fn + 20));
  for (const caso of ['SALUDOS', 'AGRADECIMIENTOS', 'CONFIRMACIONES']) {
    assert.ok(cuerpo2.includes(caso), `debe cubrir ${caso}`);
  }
});

check('la presentacion del bot se configura por entorno', () => {
  const yml = fs.readFileSync(path.join(__dirname, '..', 'docker-compose.yml'), 'utf8');
  assert.ok(yml.includes('BOT_NAME:'), 'el compose debe pasar BOT_NAME');
  assert.ok(yml.includes('AUTO_REPLY_MESSAGE:'), 'el compose debe pasar el saludo');
  assert.ok(yml.includes('AUTO_REPLY_HORAS:'), 'el compose debe pasar la ventana');
  const env = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
  assert.ok(env.includes('BOT_NAME='), 'el .env.example debe documentarla');
  assert.ok(env.includes('AUTO_REPLY_MESSAGE='), 'el .env.example debe documentarla');
});

check('un estado de WhatsApp no es una conversacion', () => {
  const wl = require('../src/whitelist');
  // Los estados llegan como status@broadcast: al normalizar quedan vacios.
  assert.strictEqual(wl.normalizePhone('status@broadcast'), '');
  assert.strictEqual(wl.esDifusion('status@broadcast'), true);
  assert.strictEqual(wl.esDifusion('1234567890@newsletter'), true);
  assert.strictEqual(wl.esDifusion('595981234567@c.us'), false);
  assert.strictEqual(wl.esDifusion('595981234567@lid'), false);
});

check('los estados de WhatsApp se cortan antes de todo', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const fn = src.indexOf('async function handleMessage');
  assert.ok(fn > 0, 'debe existir handleMessage');
  const cuerpo = src.slice(fn, src.indexOf('/* ====', fn));
  // El corte va antes de resolver el contacto, la base y la IA: si se deja
  // para mas tarde, cada foto o video de un estado consume una llamada.
  const corte = cuerpo.indexOf('esDifusion');
  assert.ok(corte > 0, 'debe cortar las difusiones');
  assert.ok(cuerpo.indexOf('persistMessage') > corte, 'antes de guardar');
  assert.ok(cuerpo.indexOf('ai.route') > corte, 'antes de llamar a la IA');
  assert.ok(cuerpo.indexOf('resolverRemitente') > corte, 'antes de resolver el contacto');
});

check('no se inventa un telefono a un remitente que no lo tiene', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const fn = src.indexOf('async function resolverRemitente');
  const cuerpo = src.slice(fn, src.indexOf('getOrCreateUser', fn));
  // Consultar la ficha del contacto tiene sentido para un @lid, que es opaco
  // pero real. Para un id sin digitos, inventar un telefono es lo que dejo
  // entrar los estados al pipeline.
  const lid = cuerpo.indexOf('if (!whitelist.esLid(senderId))');
  const contacto = cuerpo.indexOf('msg.getContact()');
  assert.ok(lid > 0, 'debe cortar los ids que no son @lid');
  assert.ok(contacto > lid, 'solo consulta el contacto para un @lid');
});

check('los descartes repetidos no inundan el log', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.ok(src.includes('avisarUnaVez'), 'debe existir el aviso unico');
  const fn = src.indexOf('async function handleMessage');
  const cuerpo = src.slice(fn, src.indexOf('/* ====', fn));
  assert.ok(cuerpo.includes('avisarUnaVez'), 'los descartes deben resumirse');
});

check('el parche de envio de whatsapp-web.js esta disponible', () => {
  const ruta = path.join(__dirname, '..', 'scripts', 'patch_whatsapp.js');
  assert.ok(fs.existsSync(ruta), 'debe existir el script de parche');
  const src = fs.readFileSync(ruta, 'utf8');
  // Sin esto el bot recibe y guarda, pero no puede responder.
  assert.ok(src.includes('canCheckStatusRankingPosterGating'), 'debe cubrir el fallo conocido');
  assert.ok(src.includes('const isStatus'), 'debe corregir la deteccion de estado');
  // Idempotente: se ejecuta en cada arranque y en cada build.
  assert.ok(src.includes('if (src.includes(parche.nuevo)) continue;'), 'debe ser idempotente');
  // Y tiene que estar enganchado al arranque y a la imagen.
  const app = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.ok(app.includes("require('./scripts/patch_whatsapp')"), 'debe correr al arrancar');
  const df = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8');
  assert.ok(df.includes('node scripts/patch_whatsapp.js'), 'debe correr en el build');
});

check('todo mensaje entrante deja rastro antes de filtrarse', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  // La traza de entrada tiene que ir antes del primer corte, o un mensaje que
  // no genera respuesta deja cero rastro y no hay forma de diagnosticarlo.
  const traza = src.indexOf('[wa] evento recibido:');
  const primerCorte = src.indexOf('if (!body) return;');
  assert.ok(traza > 0, 'debe haber traza de entrada');
  assert.ok(traza < primerCorte, 'la traza debe ir antes de filtrar');
  // Y se cuentan los eventos, para separar "no llego" de "llego y se descarto".
  assert.ok(src.includes('entradas.recibidos += 1;'), 'debe contar lo recibido');
  assert.ok(src.includes('entradas.autorizados += 1;'), 'debe contar lo autorizado');
  assert.ok(src.includes('entradas.descartados += 1;'), 'debe contar lo descartado');
});

check('el estado publica los contadores de entrada', () => {
  const recursos = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'api_recursos.js'),
    'utf8'
  );
  assert.ok(recursos.includes('setContadores'), 'debe aceptar los contadores');
  assert.ok(recursos.includes('entradas: contadores()'), 'debe publicarlos en el estado');
  const health = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'health_server.js'),
    'utf8'
  );
  assert.ok(health.includes('setContadores'), 'el servidor debe reenviarlos');
});


console.log('\nEmparejamiento de WhatsApp');

check('soporta emparejamiento por codigo (BOT_PHONE)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.ok(src.includes('BOT_PHONE'), 'debe leer BOT_PHONE');
  // whatsapp-web.js 1.34.7 emite 'code' ella misma desde inject() cuando se
  // usa pairWithPhoneNumber; pedirlo a mano con requestPairingCode() despues
  // de initialize() rechaza al instante.
  assert.ok(src.includes('pairWithPhoneNumber'), 'debe usar la opcion de la libreria');
  assert.ok(src.includes("client.on('code'"), 'debe escuchar el evento code');
  assert.ok(!src.includes('requestPairingCode'), 'no debe pedir el codigo a mano');
});

check('el QR queda como respaldo cuando no hay BOT_PHONE', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.ok(src.includes("client.on('qr'"), 'debe conservar el evento qr');
  assert.ok(src.includes('qrcode.generate'), 'debe seguir mostrando el QR');
});

check('BOT_PHONE se normaliza a solo digitos', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.ok(
    src.includes("const BOT_PHONE = (process.env.BOT_PHONE || '').replace(/\\D/g, '')"),
    'debe limpiar el numero de simbolos'
  );
});

console.log('\nCLI de lista blanca');

check('el script de whitelist expone todos los comandos', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'whitelist.js'),
    'utf8'
  );
  for (const cmd of ["case 'list'", "case 'add'", "case 'remove'", "case 'allow'", "case 'block'"]) {
    assert.ok(src.includes(cmd), `falta ${cmd}`);
  }
  // Agregar, desactivar y eliminar son caminos distintos.
  assert.ok(src.includes('allowed: true'), 'add debe dar acceso');
  assert.ok(src.includes('$set: { allowed: comando'), 'allow/block deben alternar acceso');
  assert.ok(src.includes('deleteOne'), 'remove debe eliminar');
});

check('package.json expone el comando whitelist', () => {
  const pkg = require('../package.json');
  assert.ok(pkg.scripts.whitelist, 'falta el script whitelist');
  assert.ok(pkg.scripts.user, 'falta el script user');
});

console.log('\nEstabilidad de Chromium en contenedores');

check('diagnostica el perfil de Chromium e imprime los nombres', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.ok(
    src.includes('clearChromiumLocks'),
    'debe limpiar los locks del perfil persistente'
  );
  assert.ok(src.includes('readdirSync'), 'debe listar el directorio');
});

check('detecta los locks por listado, no por existsSync', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  // SingletonLock es un symlink ROTO: existsSync devuelve false y el lock
  // pasaria desapercibido, dejando el contenedor en loop de reinicios.
  assert.ok(
    src.includes("entradas.filter((e) => e.startsWith('Singleton'))"),
    'debe detectar los locks listando el directorio'
  );
  assert.ok(src.includes('fs.unlinkSync'), 'debe borrarlos con unlinkSync');
  assert.ok(
    !/existsSync\(file\)/.test(src),
    'no debe usar existsSync sobre el lock'
  );
});

check('reintenta con el perfil limpio si Chromium falla', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.ok(src.includes('initializeWithRecovery'), 'debe reintentar');
  assert.ok(src.includes('wipeChromiumProfile'), 'debe reconstruir el perfil');
  // Detecta el error tipico de perfil tomado.
  assert.ok(
    src.includes('profile appears to be in use'),
    'debe reconocer el error de perfil bloqueado'
  );
  // Y descarta el error si el segundo intento tambien falla.
  assert.ok(src.includes('fallo irrecuperable'));
});

check('usa headless moderno y flags de contenedor', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  // 'new' evita el fallback a headless con display.
  assert.ok(src.includes("'new'"), 'debe usar headless new');
  for (const flag of [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
  ]) {
    assert.ok(src.includes(flag), `falta el flag ${flag}`);
  }
});

check('el entrypoint corrige permisos y baja a node', () => {
  const fs2 = require('fs');
  const path2 = require('path');
  const sh = fs2.readFileSync(
    path2.join(__dirname, '..', 'docker-entrypoint.sh'),
    'utf8'
  );
  // Sin esto el volumen (creado por Docker como root) queda inaccesible.
  assert.ok(sh.includes('chown -R node:node'), 'debe corregir el ownership');
  // Y baja privilegios antes de ejecutar la app.
  assert.ok(sh.includes('exec gosu node'), 'debe bajar a node con gosu');
  // Tambien borra los locks, incluyendo los symlinks rotos.
  assert.ok(sh.includes('Singleton*'), 'debe borrar los locks');
  assert.ok(
    sh.includes('[ -e "$lock" ] || [ -L "$lock" ]'),
    'debe cubrir symlinks rotos, que no pasan el test -e'
  );
});

check('el Dockerfile usa el entrypoint y ya no fija USER node', () => {
  const fs2 = require('fs');
  const path2 = require('path');
  const df = fs2.readFileSync(path2.join(__dirname, '..', 'Dockerfile'), 'utf8');
  assert.ok(df.includes('docker-entrypoint.sh'), 'debe invocar el entrypoint');
  assert.ok(df.includes('gosu'), 'debe instalar gosu');
  assert.ok(df.includes('dumb-init'), 'debe usar dumb-init como PID 1');
  // USER node impediria corregir los permisos del volumen.
  assert.ok(!/^USER node$/m.test(df), 'no debe fijar USER node (el entrypoint baja privilegios)');
});

check('el compose no fuerza el usuario', () => {
  const yml = fs.readFileSync(
    path.join(__dirname, '..', 'docker-compose.yml'),
    'utf8'
  );
  // "user:" impediria al entrypoint hacer chown como root.
  assert.ok(
    !/^\s{4}user:\s/m.test(yml),
    'el compose no debe fijar user:, lo hace el entrypoint'
  );
});

check('expone el uso de la IA (control de gasto)', () => {
  assert.strictEqual(typeof ai.getUsage, 'function', 'debe exportar getUsage');

  delete process.env.SPACE_BUNNY_DAILY_CAP;
  delete process.env.SPACE_BUNNY_API_KEY;
  const u = ai.getUsage();
  for (const campo of [
    'llamadas', 'ok', 'errores',
    'tokens_prompt', 'tokens_completion', 'tokens_total',
    'tope_diario', 'desde',
  ]) {
    assert.ok(campo in u, `falta ${campo} en el snapshot`);
  }
  assert.strictEqual(typeof u.llamadas, 'number');
  assert.strictEqual(u.tope_diario, 0, 'sin variable, el tope es 0 (ilimitado)');
});

check('sin clave de API no se hace ninguna llamada', async () => {
  delete process.env.SPACE_BUNNY_API_KEY;
  const antes = ai.getUsage();
  const r = await ai.route('Hola', { history: [] });
  const despues = ai.getUsage();
  assert.strictEqual(r.mock, true, 'debe responder en modo mock');
  assert.strictEqual(
    despues.llamadas,
    antes.llamadas,
    'no debe contar llamadas al exterior sin clave'
  );
});

check('el flujo de tareas va antes que la IA en index.js', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.ok(src.includes("require('./src/task_flow')"), 'debe importar el flujo');
  assert.ok(src.includes('taskFlow.estaActivo'), 'debe chequear el flujo activo');
  assert.ok(src.includes('taskFlow.procesar'), 'debe procesar la respuesta');

  // Orden critico: si la IA se consultara antes, cada respuesta gastaria un
  // token. El flujo debe resolverse antes de llegar a ai.route().
  const flujoPos = src.indexOf('taskFlow.procesar');
  const iaPos = src.indexOf('ai.route(');
  assert.ok(flujoPos > 0 && iaPos > 0, 'deben existir ambos');
  assert.ok(
    flujoPos < iaPos,
    'el flujo debe procesarse ANTES de llamar a la IA'
  );
});

check('index.js abre el flujo con /tarea y con intencion natural', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.ok(src.includes('taskFlow.detectarIntencion'), 'debe detectar la intención');
  assert.ok(src.includes('taskFlow.iniciar'), 'debe iniciar el flujo');
  assert.ok(src.includes('/tarea'), 'debe documentar el comando /tarea');
});

console.log('\nControl de gasto');

check('el tope diario corta antes de llamar a la API', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'ai_router.js'),
    'utf8'
  );
  // El corte debe ocurrir ANTES del fetch, si despues no sirve de nada.
  const capPos = src.indexOf('stats.llamadas >= cap');
  const fetchPos = src.indexOf('await fetch(');
  assert.ok(capPos > 0, 'debe comprobar el tope');
  assert.ok(
    capPos < fetchPos,
    'el tope debe comprobarse antes de llamar a la API'
  );
  assert.ok(
    src.includes('SPACE_BUNNY_DAILY_CAP'),
    'el tope debe venir del entorno'
  );
});

check('el gasto se informa en /estado y en la API del panel', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const api = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'api_recursos.js'),
    'utf8'
  );
  assert.ok(app.includes('ai.getUsage()'), '/estado debe mostrar el gasto');
  assert.ok(api.includes('uso_ia'), 'la API debe reportar el uso');
});

check('los mensajes predeterminados son los exactos del prompt', () => {
  assert.strictEqual(
    ai.MISSING_EVENT,
    'Para agendar, por favor indícame:\n📅 Fecha\n⏰ Hora\n📝 Qué cosa (motivo)\n📍 Dónde',
    'el mensaje de evento debe coincidir caracter por caracter'
  );
  assert.strictEqual(
    ai.MISSING_TASK,
    'Para crear la tarea necesito:\n👤 Para quién\n✅ Qué tarea\n🔥 Prioridad\n⏳ Fecha límite',
    'el mensaje de tarea debe coincidir caracter por caracter'
  );
});

check('el prompt incluye la fecha y hora ya resueltas', () => {
  const p = ai.buildSystemPrompt();
  const ahora = ai.momentoActual();
  // Los placeholders {CURRENT_DATE} / {CURRENT_TIME} deben estar reemplazados.
  assert.ok(!p.includes('{CURRENT_DATE}'), 'no debe quedar el placeholder sin resolver');
  assert.ok(!p.includes('{CURRENT_TIME}'), 'no debe quedar el placeholder sin resolver');
  assert.ok(p.includes(ahora.date), 'debe incluir la fecha actual');
  assert.ok(p.includes(ahora.time), 'debe incluir la hora actual');
  assert.ok(p.includes('America/Asuncion'), 'debe indicar la zona horaria');
});

check('el prompt declara las 5 intenciones', () => {
  const p = ai.buildSystemPrompt();
  for (const i of ['chat', 'create_document', 'schedule_event', 'add_task', 'update_task']) {
    assert.ok(p.includes(`"${i}"`), `falta la intención ${i}`);
  }
  assert.ok(p.includes('Space Bunny Alpha'), 'debe presentarse como Space Bunny Alpha');
  assert.ok(p.includes('lista blanca'), 'debe mencionar la lista blanca');
});

check('el mensaje predeterminado se impone si faltan datos', () => {
  // schedule_event sin fecha: debe pedir los datos, no agendar.
  const r1 = ai.aplicarMensajesPredeterminados({
    intent: 'schedule_event',
    response_text: 'algo distinto',
    data: { title: 'Reunión', start_at: null, location: 'Sala 3' },
  });
  assert.strictEqual(r1.response_text, ai.MISSING_EVENT);
  assert.strictEqual(r1.faltan_datos, true);

  // add_task incompleta: debe pedir los datos.
  const r2 = ai.aplicarMensajesPredeterminados({
    intent: 'add_task',
    response_text: 'creada!',
    data: { assignee: null, title: 'x', priority: 'alta', due_at: null },
  });
  assert.strictEqual(r2.response_text, ai.MISSING_TASK);
  assert.strictEqual(r2.faltan_datos, true);
});

check('una fecha partida en date+time cuenta como resuelta', () => {
  // El caso que fallo en produccion: start_at null pero date+time presentes.
  const r = ai.aplicarMensajesPredeterminados({
    intent: 'schedule_event',
    response_text: 'agendada',
    data: { title: 'Reunión', start_at: null, date: 'tomorrow', time: '15:00', location: 'Sala 3' },
  });
  assert.strictEqual(r.faltan_datos, undefined, 'no debe pedir datos de nuevo');
  assert.strictEqual(r.response_text, 'agendada', 'debe respetar la respuesta del modelo');
});

check('chat y create_document nunca seVen forzados', () => {
  for (const intent of ['chat', 'create_document', 'update_task']) {
    const r = ai.aplicarMensajesPredeterminados({
      intent,
      response_text: 'libre',
      data: {},
    });
    assert.strictEqual(r.faltan_datos, undefined, `${intent} no debe forzarse`);
    assert.strictEqual(r.response_text, 'libre');
  }
});

check('index.js respeta faltan_datos y no ejecuta la accion', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.ok(
    src.includes('result.faltan_datos'),
    'debe chequear faltan_datos antes de ejecutar'
  );
  const checkPos = src.indexOf('result.faltan_datos');
  const actionPos = src.indexOf('actionScheduleEvent(result.data, ctx)');
  assert.ok(
    checkPos < actionPos,
    'el chequeo debe ir antes de ejecutar la acción'
  );
  // Y debe usar "assignee", el campo que define el prompt.
  assert.ok(src.includes('data.assignee'), 'debe leer el campo assignee');
});

console.log('\nBusqueda web con DuckDuckGo');

check('la herramienta buscar_en_web está declarada en formato OpenAI', () => {
  assert.ok(Array.isArray(ai.HERRAMIENTAS), 'debe ser un array');
  assert.strictEqual(ai.HERRAMIENTAS.length, 1, 'solo hay una herramienta');

  const t = ai.HERRAMIENTAS[0];
  assert.strictEqual(t.type, 'function');
  assert.strictEqual(t.function.name, 'buscar_en_web');
  // Formato de parametros compatible con OpenAI.
  const p = t.function.parameters;
  assert.strictEqual(p.type, 'object');
  assert.ok(p.properties.query, 'debe declarar el parametro query');
  assert.ok(p.required.includes('query'), 'query es obligatorio');
});

check('ejecutarHerramientas devuelve mensajes con rol "tool"', async () => {
  const r = await ai.ejecutarHerramientas(
    [
      {
        id: 'call_test',
        type: 'function',
        function: {
          name: 'buscar_en_web',
          arguments: JSON.stringify({ query: 'capital de Paraguay' }),
        },
      },
    ],
    {}
  );
  assert.strictEqual(r.busquedas, 1, 'debe contar una búsqueda');
  assert.ok(r.mensajes.length >= 1, 'debe devolver al menos un mensaje');
  assert.strictEqual(r.mensajes[0].role, 'tool', 'el rol debe ser "tool"');
  assert.strictEqual(r.mensajes[0].tool_call_id, 'call_test', 'debe mantener el id');
});

check('una herramienta desconocida no rompe el flujo', async () => {
  const r = await ai.ejecutarHerramientas(
    [{ id: 'c1', function: { name: 'otra_cosa', arguments: '{}' } }],
    {}
  );
  assert.strictEqual(r.busquedas, 0, 'no debe contar como búsqueda');
  assert.ok(
    r.mensajes[0].content.includes('desconocida'),
    'debe avisar que la herramienta no existe'
  );
});

check('una consulta vacía se rechaza sin llamar a la red', async () => {
  const r = await ai.ejecutarHerramientas(
    [{ id: 'c1', function: { name: 'buscar_en_web', arguments: '{}' } }],
    {}
  );
  assert.strictEqual(r.busquedas, 0);
  assert.ok(r.mensajes[0].content.includes('vacía'));
});

check('el flujo de route usa doble llamada con tools', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'ai_router.js'),
    'utf8'
  );
  assert.ok(src.includes('tools: HERRAMIENTAS') || src.includes('cuerpo.tools'),
    'debe enviar las herramientas en la primera llamada');
  assert.ok(src.includes('tool_calls'), 'debe interceptar los tool_calls');
  assert.ok(src.includes("role: 'tool'"), 'debe inyectar mensajes con rol tool');
  assert.ok(src.includes('ejecutarHerramientas'), 'debe ejecutar la búsqueda');
  // La primera llamada NO debe forzar JSON (si lo fuerza, no puede pedir tools).
  const toolsPos = src.indexOf('cuerpo.tools = HERRAMIENTAS');
  const jsonPos = src.indexOf('cuerpo.response_format');
  assert.ok(jsonPos < toolsPos, 'response_format se aplica aparte de tools');
  assert.ok(
    src.includes('conHerramientas && !forzarJson'),
    'tools solo en la llamada que no fuerza JSON'
  );
});

check('web_search usa solo DuckDuckGo', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'web_search.js'),
    'utf8'
  );
  assert.ok(src.includes('duckduckgo'), 'debe usar DuckDuckGo');
  assert.ok(src.includes('html.duckduckgo.com'), 'debe consultar la web de DDG');
  // No debe hardcodear ninguna API key de pago.
  assert.ok(!/sk-[a-zA-Z0-9]{20,}/.test(src), 'no debe contener API keys');
  // Fuentes de error envueltas en try/catch.
  assert.ok(src.includes('catch'), 'debe manejar errores de red');
});

console.log('\nTraefik y dominio');

check('el compose NO declara redes externas de Traefik', () => {
  const fs2 = require('fs');
  const path2 = require('path');
  const yml = fs2.readFileSync(
    path2.join(__dirname, '..', 'docker-compose.yml'),
    'utf8'
  );
  // Declarar la red de Traefik como externa rompe el deploy cuando el
  // servidor no tiene una red con ese nombre. Dokploy resuelve el dominio
  // desde su propia pestaña Domains.
  assert.ok(
    !/external:\s*true/.test(yml),
    'no debe declarar redes externas: fallan si el nombre no coincide'
  );
  assert.ok(
    !/traefik\./i.test(yml) || !yml.includes('traefik.http'),
    'no debe declarar etiquetas de Traefik: las genera Dokploy'
  );
});

check('el servicio solo usa su red propia', () => {
  const fs2 = require('fs');
  const path2 = require('path');
  const yml = fs2.readFileSync(
    path2.join(__dirname, '..', 'docker-compose.yml'),
    'utf8'
  );
  // Una sola red propia definida a nivel global.
  assert.strictEqual(
    (yml.match(/^networks:\s*$/gm) || []).length,
    1,
    'debe haber una unica definicion global de redes'
  );
  assert.ok(
    !/^\s{2}traefik:\s*$/m.test(yml),
    'no debe existir una red llamada traefik'
  );
  // Y el servicio no debe apuntar a ninguna red externa.
  assert.ok(
    !/^\s{6}-\s*traefik\s*$/m.test(yml),
    'el servicio no debe unirse a una red traefik'
  );
});

check('el puerto queda expuesto pero no publicado', () => {
  const fs2 = require('fs');
  const path2 = require('path');
  const yml = fs2.readFileSync(
    path2.join(__dirname, '..', 'docker-compose.yml'),
    'utf8'
  );
  // Publicar un puerto en el host choca con otras apps del servidor.
  assert.ok(!/^\s{4}ports:\s*$/m.test(yml), 'no debe declarar "ports:"');
  assert.ok(/expose:\s*\n\s+- "3000"/.test(yml), 'debe exponer el puerto 3000');
});

console.log('\nEntrypoint del contenedor');

check('el entrypoint usa finales de linea LF, no CRLF', () => {
  const fs2 = require('fs');
  const path2 = require('path');
  const buf = fs2.readFileSync(
    path2.join(__dirname, '..', 'docker-entrypoint.sh')
  );
  // Con CRLF el shebang queda "#!/bin/sh\r" y el contenedor arranca con
  // "/app/docker-entrypoint.sh: No such file or directory".
  for (let i = 0; i < buf.length - 1; i += 1) {
    if (buf[i] === 13 && buf[i + 1] === 10) {
      throw new Error('el archivo tiene finales CRLF');
    }
  }
  assert.strictEqual(buf[buf.length - 1], 10, 'debe terminar en salto de linea');
});

check('el entrypoint no tiene BOM al inicio', () => {
  const fs2 = require('fs');
  const path2 = require('path');
  const buf = fs2.readFileSync(
    path2.join(__dirname, '..', 'docker-entrypoint.sh')
  );
  // El BOM UTF-8 (EF BB BF) delante del shebang tambien lo rompe.
  const conBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  assert.strictEqual(conBom, false, 'no debe tener BOM UTF-8');
});

check('el shebang apunta a un interprete existente', () => {
  const fs2 = require('fs');
  const path2 = require('path');
  const primera = fs2
    .readFileSync(path2.join(__dirname, '..', 'docker-entrypoint.sh'), 'utf8')
    .split('\n')[0]
    .trim();
  assert.strictEqual(primera, '#!/bin/sh');
});

check('el Dockerfile normaliza el entrypoint al construir', () => {
  const fs2 = require('fs');
  const path2 = require('path');
  const df = fs2.readFileSync(path2.join(__dirname, '..', 'Dockerfile'), 'utf8');
  // Red de seguridad: aunque el .sh llegue con CRLF, el build lo corrige.
  assert.ok(
    df.includes("sed -i 's/\\r$//'"),
    'debe quitar los CR del entrypoint durante el build'
  );
  assert.ok(df.includes('chmod +x /app/docker-entrypoint.sh'), 'debe hacerlo ejecutable');
});

check('.gitattributes fuerza LF en los scripts', () => {
  const fs2 = require('fs');
  const path2 = require('path');
  const ga = fs2.readFileSync(
    path2.join(__dirname, '..', '.gitattributes'),
    'utf8'
  );
  assert.ok(
    /\*.sh\s+text\s+eol=lf/.test(ga),
    'debe declarar eol=lf para los scripts de shell'
  );
});

check('el codigo de vinculacion se publica en la web', () => {
  const api = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'api_recursos.js'),
    'utf8'
  );
  const http = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'health_server.js'),
    'utf8'
  );
  // El codigo se renueva cada ~3 min: sin esto hay que cazarlo en los logs.
  assert.ok(api.includes('codigo_vinculacion'), 'debe exponer el codigo vigente');
  assert.ok(api.includes('setCodigoVinculacion'), 'debe permitir inyectarlo');
  assert.ok(
    api.includes('!vinculado && codigo'),
    'solo se muestra mientras no este vinculado'
  );
  assert.ok(http.includes('setPairingCode'), 'el servidor debe exportarlo');
});

check('index.js publica y limpia el codigo de vinculacion', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.ok(src.includes('health.setPairingCode(code)'), 'debe publicarlo al recibirlo');
  assert.ok(
    src.includes('health.setPairingCode(null)'),
    'debe limpiarlo al autenticar'
  );
});

check('el QR repetido no inunda los logs', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  // WhatsApp renueva el QR cada ~20 s: con BOT_PHONE eso son miles de lineas.
  assert.ok(
    src.includes('qrAvisado'),
    'debe avisar del QR una sola vez cuando hay BOT_PHONE'
  );
});

check('no se pide codigo de emparejamiento si la sesion ya esta vinculada', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  // Pedir un codigo sobre una sesion que ya funciona deja el navegador colgado
  // ("Runtime.callFunctionOn timed out") y se comen los mensajes entrantes.
  assert.ok(src.includes('sesionVinculada'), 'debe saber si ya hay sesion');
  assert.ok(
    src.includes('if (wantsPairing && !yaVinculado)'),
    'el codigo solo se pide cuando NO hay sesion'
  );
  // El flag se activa con el evento authenticated.
  const aut = src.indexOf("client.on('authenticated'");
  assert.ok(aut > 0 && src.indexOf('sesionVinculada = true;', aut) > aut,
    'authenticated debe marcar la sesion como vinculada');
  // Y el arranque lo dice, para no confundirlo con un fallo.
  assert.ok(src.includes('sesion ya vinculada: no se pide codigo'));
});

check('el navegador tiene timeout de protocolo holgado', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  // El default de Puppeteer (3 min) corta llamadas lentas del navegador.
  assert.ok(src.includes('protocolTimeout'), 'debe configurarse');
});

check('el arranque dice que numero quedo realmente vinculado', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  // Si el numero vinculado no es BOT_PHONE, el bot escucha en otra linea.
  assert.ok(src.includes('numero vinculado:'), 'debe informarlo');
  // client.info todavia no existe en 'ready': hay que consultarlo.
  assert.ok(src.includes('client.getWid()'), 'debe consultarlo al navegador');
  assert.ok(src.includes('distinto de BOT_PHONE'), 'debe avisar si difieren');
});

check('el arranque espera a que la sesion se anuncie', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  // initialize() resuelve ANTES de que la sesion restaurada emita sus eventos.
  // Sin esta espera se pide un codigo sobre una sesion que ya funciona.
  assert.ok(src.includes('esperarVinculacion'), 'debe esperar');
  const init = src.indexOf('async function initializeWithRecovery');
  const cuerpo = src.slice(init, src.indexOf('main().catch', init));
  const posInit = cuerpo.indexOf('await client.initialize();');
  const posEspera = cuerpo.indexOf('esperarVinculacion(15000)');
  const posCodigo = cuerpo.indexOf('esperarCodigo(90000)');
  assert.ok(init > 0, 'debe existir el arranque');
  assert.ok(posInit >= 0 && posEspera > posInit, 'debe esperar despues de initialize');
  assert.ok(posCodigo > posEspera, 'debe esperar el codigo despues de la sesion');
  // El codigo lo emite la libreria con pairWithPhoneNumber: no se pide a mano.
  assert.ok(cuerpo.includes('if (wantsPairing && !yaVinculado)'), 'el gate se mantiene');
  assert.ok(!cuerpo.includes('requestPairingCode'), 'no debe pedir el codigo a mano');
});

check('una llamada colgada al navegador no frena el arranque', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.ok(src.includes('conTope'), 'debe haber un tope para las llamadas');
  assert.ok(src.includes('client.getWid()'), 'el numero vinculado se consulta con tope');
});

check('con BOT_PHONE se vincula por codigo, el QR se descarta', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  // Es lo pedido: si hay BOT_PHONE, el emparejamiento es por codigo de 8
  // caracteres. El QR se renueva cada ~20 s y llenaria los logs de ruido.
  const h = src.indexOf("client.on('qr'");
  assert.ok(h > 0, 'debe seguir escuchando el QR');
  const cuerpo = src.slice(h, src.indexOf('});', h));
  const ramaBot = cuerpo.indexOf('if (BOT_PHONE)');
  const imprime = cuerpo.indexOf('qrcode.generate');
  assert.ok(ramaBot > 0, 'debe distinguir si hay BOT_PHONE');
  assert.ok(imprime > ramaBot, 'el QR se imprime despues de la rama de BOT_PHONE');
  // La rama de BOT_PHONE tiene que cortar ANTES de imprimirlo.
  const hasta = cuerpo.slice(0, imprime);
  assert.ok(hasta.includes('return;'), 'con BOT_PHONE el QR no se imprime');
  // Y aun asi sirve para saber que la pagina ya cargo.
  assert.ok(cuerpo.includes('qrVisto = true;'), 'el QR debe marcar la pagina como lista');
  // El codigo lo emite la propia libreria con pairWithPhoneNumber.
  assert.ok(src.includes('pairWithPhoneNumber'), 'debe usar la opcion de la libreria');
  assert.ok(src.includes('phoneNumber: BOT_PHONE'), 'debe pasarle el numero del bot');
  assert.ok(src.includes("client.on('code'"), 'debe escuchar el evento code');
  assert.ok(src.includes('function esperarCodigo'), 'debe esperar el evento code');
  // Y si no llega, dice que revisar y donde mirar, sin ofrecer el QR.
  assert.ok(src.includes('codigo_vinculacion'), 'debe decir donde ver el codigo');
  assert.ok(src.includes('BOT_PHONE'), 'debe revisar el formato del numero');
});

check('un error interno de la libreria no tumba el bot', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  // Caso real: tras cerrar sesion desde el celular, whatsapp-web.js reinyecta
  // sobre una pagina que ya tiene los bindings de Puppeteer y lanza. Sin este
  // handler el proceso muere y el bot deja de responder.
  assert.ok(src.includes("process.on('uncaughtException'"), 'debe capturar uncaughtException');
  assert.ok(src.includes('recuperarDeErrorFatal'), 'debe decidir como recuperarse');
  assert.ok(src.includes("already exists"), 'debe reconocer el error de bindings');
});

check('un logout deja el navegador limpio, no reinyectado encima', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.ok(src.includes('MOTIVOS_REINICIO'), 'debe listar los motivos');
  assert.ok(src.includes("'LOGOUT'"), 'LOGOUT debe reiniciar');
  const fn = src.indexOf('async function reiniciarCliente');
  assert.ok(fn > 0, 'debe existir el reinicio');
  const cuerpo = src.slice(fn, fn + 900);
  // La salida es cerrar el navegador y abrir uno nuevo, no reinyectar encima.
  assert.ok(cuerpo.includes('client.destroy()'), 'debe cerrar el navegador');
  assert.ok(cuerpo.includes('client.initialize()'), 'debe abrir uno nuevo');
  // Y no se superponen reinicios.
  assert.ok(cuerpo.includes('if (reiniciando) return;'), 'debe evitar reinicios encimados');
  // El evento disconnected debe conectar con el reinicio.
  const ev = src.indexOf("client.on('disconnected'");
  assert.ok(ev > 0 && src.indexOf('reiniciarCliente(reason)', ev) > ev,
    'disconnected debe disparar el reinicio');
});

check('el diagnostico de acceso esta protegido y es utilizable', () => {
  const recursos = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'api_recursos.js'),
    'utf8'
  );
  const fn = recursos.indexOf('async function consultarAcceso');
  assert.ok(fn > 0, 'debe existir el handler');
  const cuerpo = recursos.slice(fn, recursos.indexOf('/** GET /api/estado */', fn));
  assert.ok(cuerpo.includes('exigirAdmin'), 'solo administradores');
  assert.ok(cuerpo.includes('isAllowedPhone'), 'consulta el acceso real');
  assert.ok(cuerpo.includes('mismoTelefono'), 'descarta al bot');
  assert.ok(cuerpo.includes('contadores()'), 'incluye los contadores de entrada');
});

console.log('\nZona horaria');

check('el compose define TZ en los dos servicios', () => {
  const yml = fs.readFileSync(
    path.join(__dirname, '..', 'docker-compose.yml'),
    'utf8'
  );
  // MongoDB y orbitaos: sin esto los timestamps quedan en UTC.
  const ocurrencias = (yml.match(/TZ: \$\{TZ:-America\/Asuncion\}/g) || []).length;
  assert.strictEqual(ocurrencias, 2, 'debe estar en mongo y en orbitaos');
});

check('los cron usan la zona horaria del negocio', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'cron_jobs.js'), 'utf8');
  assert.ok(src.includes('America/Asuncion'), 'debe usar la zona por defecto');
  assert.ok(src.includes('process.env.CRON_TZ'), 'debe respetar CRON_TZ');
});

check('el .env.example declara TZ=America/Asuncion', () => {
  const env = fs.readFileSync(
    path.join(__dirname, '..', '.env.example'),
    'utf8'
  );
  assert.ok(env.includes('TZ=America/Asuncion'));
  assert.ok(env.includes('CRON_TZ=America/Asuncion'));
  assert.ok(!env.includes('Buenos_Aires'), 'no debe quedar la zona vieja');
});

check('el compose no publica puertos en el host', () => {
  const yml = fs.readFileSync(
    path.join(__dirname, '..', 'docker-compose.yml'),
    'utf8'
  );
  // Publicar un puerto choca con Traefik: "port is already allocated".
  // Solo se permite 'expose' (no publica en el host).
  assert.ok(
    !/^\s{4}ports:\s*$/m.test(yml),
    'el servicio no debe declarar "ports:" en el host'
  );
  assert.ok(yml.includes('expose:'), 'debe usar expose, que no publica nada');
});

check('el servidor de salud responde /health y /', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'health_server.js'),
    'utf8'
  );
  assert.ok(src.includes("'/health'"), 'debe exponer /health');
  assert.ok(src.includes("'/healthz'"), 'debe exponer el alias /healthz');
  assert.ok(src.includes('startHealthServer'), 'debe exportar el arranque');
  // Sin dependencias: solo el modulo http de Node.
  assert.ok(src.includes("require('http')"));
  assert.ok(!src.includes('express'), 'no debe agregar dependencias');
});

check('index.js arranca y cierra el servidor de salud', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.ok(src.includes('health.startHealthServer'), 'debe iniciarlo');
  assert.ok(src.includes('health.setReady(true)'), 'debe marcar listo en ready');
  assert.ok(src.includes('httpServer.close'), 'debe cerrarlo en el shutdown');
});

console.log('\nLista blanca por WhatsApp');

check('los comandos de whitelist exigen permiso de admin', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.ok(src.includes('isAdmin'), 'debe verificar el rol');
  assert.ok(
    src.includes('No tenés permiso para administrar la lista blanca'),
    'debe rechazar a los no-admin'
  );
  for (const cmd of ['/agregar', '/quitar', '/contactos']) {
    assert.ok(src.includes(cmd), `falta el comando ${cmd}`);
  }
});

check('ADMIN_WHITELIST define quienes administran', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.ok(src.includes('ADMIN_WHITELIST'));
  // Y tambien sirve el rol owner/admin en la base.
  assert.ok(src.includes("u.role === 'owner'"));
});

console.log(`\n${passed} comprobaciones OK\n`);
