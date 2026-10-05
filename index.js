'use strict';
// OrbitaOs - punto de entrada.

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');

const db = require('./src/database');
const ai = require('./src/ai_router');
const cron = require('./src/cron_jobs');
const programados = require('./src/scheduled_messages');
const users = require('./src/users');
const whitelist = require('./src/whitelist');
const health = require('./src/health_server');
const taskFlow = require('./src/task_flow');
const stockFlow = require('./src/stock_flow');
const nexus = require('./src/nexus_client');
const inyeccion = require('./src/inyeccion');

const { User, Message, Event, Task } = db;

const LOG_MESSAGES = (process.env.LOG_MESSAGES || 'true') === 'true';

// Nombre con el que se presenta el bot. Aparece en el saludo automatico.
const BOT_NAME = process.env.BOT_NAME || 'Administrador General Chicolin';

// Saludo que recibe quien escribe sin estar autorizado. NO pasa por la IA:
// es un texto fijo, asi que no cuesta ni un token.
const AUTO_REPLY = (
  process.env.AUTO_REPLY_MESSAGE ||
  `Hola, soy ${BOT_NAME}, en que puedo ayudarle, en breve le estaremos respondiendo`
).trim();

// Cada cuanto se repite ese saludo al mismo numero. Sin esto, quien escribe
// cinco veces recibiría el saludo cinco veces.
const AUTO_REPLY_MS = Number(process.env.AUTO_REPLY_HORAS || 24) * 3600 * 1000;

/** Ultimo saludo automatico enviado por telefono. */
const ultimosSaludos = new Map();

// Respuesta a un intento de manipular el modelo. No explica que se detecto
// (asi no se enseña que filtro hay) ni filtra nada del sistema.
const INYECCION_MSG =
  'Ese mensaje no lo puedo interpretar como consulta. Puedo ayudarte a agendar, ' +
  'cargar tareas o responder consultas de la operacion.';

/**
 * Contadores de mensajes entrantes. Se publican en /api/estado para poder
 * distinguir las dos fallas que se ven igual desde afuera: que el evento de
 * WhatsApp no llegue al proceso, o que llegue y se descarte antes de tiempo.
 */
const entradas = {
  recibidos: 0,
  autorizados: 0,
  descartados: 0,
  inyecciones: 0,
  ultimo_tipo: null,
  ultimo_recibido: null,
};

// Publica los contadores de entrada en /api/estado.
health.setContadores(() => ({ ...entradas }));

// La fuente de verdad es la coleccion User: cualquier usuario con telefono y
// allowed=true puede hablar con el bot. BOT_PHONE NO autoriza a nadie, solo
// identifica al numero emparejado para poder vincular la sesion.

/**
 * Decide si un remitente puede usar el bot. Devuelve el veredicto de
 * src/whitelist.js: { permitido, phone, motivo }, para poder loguear por que
 * se descarto un mensaje sin imprimir el telefono entero.
 *
 * La consulta real es users.isAllowedPhone: un usuario guardado con telefono y
 * allowed=true. BOT_PHONE no participa de la decision salvo para descartar al
 * propio bot.
 */
async function autorizarRemitente(senderId) {
  const veredicto = whitelist.autorizar({
    senderId,
    botPhone: BOT_PHONE,
    permitido: (phone) => users.isAllowedPhone(phone),
  });
  if (!veredicto.permitido) {
    console.log(
      `[whitelist] mensaje ignorado (${veredicto.motivo}): ` +
      `remitente ${whitelist.enmascarar(veredicto.phone)}`
    );
  }
  return veredicto;
}

/** Normaliza un numero de WhatsApp a solo digitos, sin el @c.us ni el pais agregado. */
function normalizePhone(id) {
  return whitelist.normalizePhone(id);
}

/**
 * Saludo para quien escribe sin estar autorizado.
 *
 * Es un texto fijo: no consulta la base, no llama a la IA y no guarda el
 * mensaje. Se manda una sola vez por numero dentro de la ventana de
 * AUTO_REPLY_MS, para no insistir si la persona insiste.
 */
async function responderSaludoAutomatico(msg, phone) {
  // En un grupo no se habla salvo que lo invoquen: el saludo automatico es
  // para chats privados.
  if (whitelist.esGrupo(msg.from)) return false;

  const ahora = Date.now();
  const ultimo = ultimosSaludos.get(phone) || 0;
  if (ahora - ultimo < AUTO_REPLY_MS) return false;
  ultimosSaludos.set(phone, ahora);

  try {
    await client.sendMessage(msg.from, AUTO_REPLY);
    console.log(
      `[wa] saludo automatico enviado a ${whitelist.enmascarar(phone)} (sin IA, sin guardar)`
    );
    return true;
  } catch (err) {
    console.error(`[wa] no se pudo enviar el saludo automatico: ${err.message}`);
    ultimosSaludos.delete(phone); // se reintenta en el proximo mensaje
    return false;
  }
}

/**
 * Respuestas locales para los autorizados, sin llamar a la IA.
 *
 * "solo cuando sea necesario" significa tambien no gastar un token en un
 * hola o en un gracias: son los mensajes mas frecuentes y no requieren
 * pensar nada. Devuelve null cuando el texto si necesita del modelo.
 */
const SALUDOS = /^(hola|holis|buenas|buen dia|buenas tardes|buenas noches|hey|ola|que tal|hello|hi|buenissss?)+[!. ]*$/i;
const AGRADECIMIENTOS = /^(gracias|muchas gracias|mil gracias|dale gracias|ok gracias|thanks|thank you)+[!. ]*$/i;
const CONFIRMACIONES = /^(ok|oka|dale|listo|perfecto|entendido|hecho|si|claro|joya|buenisimo|barbaro|excellent)[!. ]*$/i;

function respuestaLocal(body) {
  const texto = String(body || '').trim();
  if (!texto || texto.length > 60) return null;
  if (SALUDOS.test(texto)) {
    return `¡Hola! Soy ${BOT_NAME}. ¿En qué te ayudo?`;
  }
  if (AGRADECIMIENTOS.test(texto)) {
    return '¡De nada! Cualquier cosa avisame.';
  }
  if (CONFIRMACIONES.test(texto)) {
    return 'Perfecto. Quedo atento.';
  }
  return null;
}

/** Numeros de la variable WHITELIST (respaldo / carga inicial). */
function envWhitelist() {
  return (process.env.WHITELIST || '')
    .split(',')
    .map((p) => normalizePhone(p))
    .filter(Boolean);
}

/* =========================================================================
 * Cliente de WhatsApp
 * ====================================================================== */

const sessionPath = process.env.SESSION_PATH || path.join(__dirname, 'session');
fs.mkdirSync(sessionPath, { recursive: true });

// Telefono del numero corporativo, solo digitos con prefijo del pais.
const BOT_PHONE = (process.env.BOT_PHONE || '').replace(/\D/g, '');

/** Ultimo codigo de emparejamiento emitido, para el diagnostico HTTP. */
let ultimoCodigo = null;

/** Cuantos codigos se emitieron sin completar la vinculacion. */
let codigosEmitidos = 0;

/**
 * true cuando ya hay una sesion de WhatsApp vinculada en este arranque.
 * Sirve para NO pedir un codigo de emparejamiento sobre una sesion que ya
 * funciona: esa llamada deja el navegador colgado y se comen los mensajes.
 */
let sesionVinculada = false;

/** true cuando WhatsApp Web ya mostro su QR de vinculación. */
let qrVisto = false;

/** Resuelve la espera de la pagina, cuando llega el QR. */
let resolverQr = null;

// Elimina los locks de Chromium de una ejecucion anterior.
function clearChromiumLocks() {
  // LocalAuth compone el directorio asi: dataPath + "session-" + clientId.
  const profileDir = path.join(sessionPath, 'session-orbitaos');

  let entradas = [];
  try {
    if (!fs.existsSync(profileDir)) {
      console.log(`[wa] perfil nuevo en ${profileDir}`);
      return { profileDir, borrados: 0 };
    }
    entradas = fs.readdirSync(profileDir);
  } catch (err) {
    console.warn(`[wa] no se pudo leer el perfil: ${err.message}`);
    return { profileDir, borrados: 0 };
  }

  // Los locks de Chromium siempre empiezan por "Singleton".
  const locks = entradas.filter((e) => e.startsWith('Singleton'));
  const resumen = entradas.slice(0, 10).join(', ') || '(vacio)';
  console.log(`[wa] perfil ${profileDir}: ${entradas.length} entradas -> ${resumen}`);

  if (!locks.length) return { profileDir, borrados: 0 };

  let borrados = 0;
  for (const lock of locks) {
    try {
      // unlink borra el symlink aunque su destino ya no exista.
      fs.unlinkSync(path.join(profileDir, lock));
      borrados += 1;
    } catch (err) {
      console.warn(`[wa] no se pudo borrar ${lock} (${err.code}): ${err.message}`);
    }
  }

  if (borrados) {
    console.log(`[wa] ${borrados} lock(s) eliminado(s): ${locks.join(', ')}`);
  }
  return { profileDir, borrados };
}

// Destruye por completo el perfil de Chromium.
function wipeChromiumProfile(profileDir) {
  const dir = profileDir || path.join(sessionPath, 'session-orbitaos');
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    console.log(`[wa] perfil de Chromium reconstruido: ${dir}`);
    console.log('[wa] habra que volver a vincular WhatsApp con el codigo de 8 caracteres.');
    return true;
  } catch (err) {
    console.error(`[wa] no se pudo reconstruir el perfil (${err.code}): ${err.message}`);
    console.error('[wa] Borra el volumen "session-data" desde Dokploy para destrabarlo.');
    return false;
  }
}

const perfil = clearChromiumLocks();
console.log(
  `[wa] sesion: ruta=${sessionPath} perfil=${perfil.profileDir} locks=${perfil.borrados}`
);

const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: sessionPath,
    clientId: 'orbitaos',
  }),
  puppeteer: {
    // 'new' en vez de 'true': con las versiones nuevas de Chromium, 'true'
    // queda deprecado y puede arrancar en modo con display, provocando el
    // error "Can't open display:" dentro del contenedor.
    headless: process.env.PUPPETEER_HEADLESS === 'false' ? false : 'new',
    // Chromium del sistema (instalado en el Dockerfile), no el de Puppeteer.
    executablePath: process.env.CHROME_PATH || '/usr/bin/chromium',
    // Por defecto Puppeteer corta cada llamada al navegador a los 3 minutos.
    // En un contenedor lento, pedir un codigo de emparejamiento o leer un
    // contacto puede pasarse y dejar la pagina colgada, sin eventos de entrada.
    protocolTimeout: Number(process.env.PUPPETEER_PROTOCOL_TIMEOUT || 300000),
    args: [
      // Imprescindible en contenedores: sin esto Chromium no arranca como root.
      '--no-sandbox',
      '--disable-setuid-sandbox',
      // El /dev/shm por defecto son 64MB y Chromium se cae por falta de memoria.
      // El compose ya define shm_size: 1gb; esto es la red de seguridad.
      '--disable-dev-shm-usage',
      '--disable-gpu',
      // Reforza el modo headless y evita que intente abrir un display.
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--no-first-run',
      '--no-zygote',
      '--ignore-certificate-errors',
    ],
  },
});

/* =========================================================================
 * Utilidades de formato
 * ====================================================================== */

function formatDate(date, timezone) {
  try {
    return new Intl.DateTimeFormat('es-AR', {
      weekday: 'long',
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: timezone || 'America/Asuncion',
    }).format(date);
  } catch (_) {
    return date.toISOString();
  }
}

/** Convierte una fecha ISO o Date en Date, o null si no es valida. */
function toDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/* =========================================================================
 * Persistencia
 * ====================================================================== */

// Registra un mensaje en la bitacora.
async function persistMessage({ chatId, from, to, direction, body, intent, data, fallback, isGroup, whatsappMessageId }) {
  try {
    return await Message.create({
      chatId,
      from,
      to,
      direction,
      body,
      intent: intent || null,
      data: data || null,
      fallback: Boolean(fallback),
      isGroup: Boolean(isGroup),
      whatsappMessageId: whatsappMessageId || null,
    });
  } catch (err) {
    console.error(`[db] no se pudo guardar el mensaje: ${err.message}`);
    return null;
  }
}

// Carga los ultimos mensajes del chat para darselo como contexto a la IA.
async function getHistory(chatId) {
  try {
    const docs = await Message.find({ chatId })
      .sort({ createdAt: -1 })
      .limit(Number(process.env.AI_CONTEXT_MESSAGES || 8))
      .lean();

    // De mas reciente a mas antiguo: se invierte para el formato de la API.
    return docs
      .reverse()
      .map((m) => ({
        role: m.direction === 'outbound' ? 'assistant' : 'user',
        content: m.body,
      }));
  } catch (err) {
    console.error(`[db] no se pudo leer el historial: ${err.message}`);
    return [];
  }
}

/**
 * Resuelve el telefono real de quien manda el mensaje.
 *
 * En privado suele venir ya como "595981234567@c.us" y alcanza con normalizar.
 * Pero WhatsApp tambien entrega ids "@lid" (por ejemplo
 * "236372620518922@lid"), que NO son el telefono: sin resolverlos, la lista
 * blanca no los reconoce y el mensaje se descarta. Se pide entonces la ficha
 * del contacto, que si trae el numero.
 *
 * En grupos manda el que escribe (msg.author), no el grupo.
 */
async function resolverRemitente(msg) {
  const senderId = whitelist.remitenteDe(msg);
  const directo = normalizePhone(senderId);

  // Si ya es un numero con forma de telefono (8 a 15 digitos), no hay nada que
  // resolver. Los @lid suelen ser largos pero pueden caer en ese rango, asi que
  // solo se aceptan si el contacto confirma que son el mismo numero.
  if (directo && !whitelist.esLid(senderId) && /^\d{8,15}$/.test(directo)) {
    return { phone: directo, senderId };
  }

  // Un id @lid es opaco pero tiene contacto: ahi si vale la pena preguntarle.
  // Cualquier otro id sin digitos NO es un remitente (por ejemplo un estado o
  // un canal que llego hasta aca). Inventar un telefono ahi es justamente lo
  // que dejo entrar difusiones al pipeline.
  if (!whitelist.esLid(senderId)) {
    return { phone: directo, senderId };
  }

  try {
    const contacto = await msg.getContact();
    const numero = normalizePhone(contacto && contacto.number);
    if (numero && /^\d{8,15}$/.test(numero)) return { phone: numero, senderId };
  } catch (err) {
    console.warn(`[wa] no se pudo resolver el contacto ${whitelist.enmascarar(directo)}: ${err.message}`);
  }

  // Sin numero confiable no se inventa nada: se descarta.
  console.warn(
    `[whitelist] remitente ${whitelist.enmascarar(directo)} sin telefono resoluble (@lid)`
  );
  return { phone: '', senderId };
}

/** Devuelve el usuario, creandolo la primera vez. */
async function getOrCreateUser(phone) {
  const clean = normalizePhone(phone);
  // Busca por variantes, no por coincidencia exacta: si el telefono esta
  // guardado con otro formato no se debe crear un usuario duplicado.
  let user = await users.findByPhone(clean);
  if (!user) {
    try {
      user = await User.create({
        username: `wa${clean}`,
        passwordHash: 'sin-acceso-por-whatsapp',
        phone: clean,
        name: '',
        allowed: true,
      });
      user = user.toObject();
    } catch (err) {
      console.error(`[db] no se pudo crear el usuario: ${err.message}`);
      user = { phone: clean, timezone: 'America/Asuncion', name: '' };
    }
  }
  User.updateOne({ phone: clean }, { $set: { lastSeenAt: new Date() } }).catch(() => {});
  return user;
}

/* =========================================================================
 * Acciones por intencion
 * ====================================================================== */

/** Crea un evento a partir de los datos de la IA. */
async function actionScheduleEvent(data, ctx) {
  const startAt = ai.resolveEventDate(data);
  if (!startAt) {
    return 'Necesito una fecha y hora concretas para agendar la cita. Usá el formato "el 12/09 a las 15:00" o "mañana a las 10:00".';
  }

  const duration = Number(data.duration_minutes || data.durationMinutes || 60);
  const endAt = data.end_at ? toDate(data.end_at) : new Date(startAt.getTime() + duration * 60000);

  const event = await Event.create({
    title: data.title || 'Cita',
    description: data.description || '',
    owner: ctx.owner,
    createdBy: ctx.from,
    chatId: ctx.chatId,
    startAt,
    endAt,
    location: data.location || '',
    status: 'confirmed',
  });

  const lines = [
    '✅ *Cita agendada*',
    '',
    `*${event.title}*`,
    `🗓 ${formatDate(event.startAt, ctx.timezone)}`,
    `⏳ Fin estimado: ${formatDate(event.endAt, ctx.timezone)}`,
  ];
  if (event.location) lines.push(`📍 ${event.location}`);
  lines.push('', 'Te aviso 24 horas y 2 horas antes.');
  return lines.join('\n');
}

/** Crea una tarea en el pipeline. */
async function actionAddTask(data, ctx) {
  const title = (data.title || '').trim();
  if (!title) return 'La tarea necesita un titulo. Decime que hay que hacer.';

  // Position al final de la columna para mantener el orden del tablero.
  const last = await Task.findOne({ owner: ctx.owner, status: data.status || 'todo' })
    .sort({ position: -1 })
    .lean();

  const task = await Task.create({
    title,
    description: data.description || '',
    owner: ctx.owner,
    createdBy: ctx.from,
    chatId: ctx.chatId,
    status: data.status || 'todo',
    priority: data.priority || 'medium',
    dueAt: toDate(data.due_at),
    position: (last && last.position ? last.position : 0) + 1,
    // El prompt usa "assignee" para indicar a quien se asigna: va como etiqueta.
    labels: data.assignee
      ? [String(data.assignee).toLowerCase()]
      : Array.isArray(data.labels)
        ? data.labels
        : [],
  });

  const partes = [
    '✅ *Tarea creada*',
    '',
    `*${task.title}*`,
    `🔁 Estado: ${task.status}`,
    `🚦 Prioridad: ${task.priority}`,
  ];
  if (task.dueAt) partes.push(`📅 Vence: ${formatDate(task.dueAt, ctx.timezone)}`);
  if (data.assignee) partes.push(`👤 Para: ${data.assignee}`);
  return partes.join('\n');
}

/** Actualiza una tarea existente del pipeline. */
async function actionUpdateTask(data, ctx) {
  const patch = {};
  if (data.title) patch.title = data.title;
  if (data.description) patch.description = data.description;
  if (data.status) patch.status = data.status;
  if (data.priority) patch.priority = data.priority;
  if (data.due_at) patch.dueAt = toDate(data.due_at);

  // El prompt define "assignee" como a quien se asigna. Se usa como etiqueta.
  if (data.assignee) patch.labels = [String(data.assignee).toLowerCase()];

  if (Object.keys(patch).length === 0) {
    return 'No recibi ningun cambio que aplicar. Indicame que tarea y que modificar.';
  }

  // Con task_id apunta a una en concreto; sin el, opera sobre la mas reciente.
  const filter = data.task_id
    ? { _id: data.task_id, owner: ctx.owner }
    : { owner: ctx.owner };

  const updated = await Task.findOneAndUpdate(filter, { $set: patch }, { new: true });

  if (!updated) return 'No encontre esa tarea en tu pipeline.';
  return `✅ *Tarea actualizada*\n\n*${updated.title}*\n🔁 Estado: ${updated.status}\n🚦 Prioridad: ${updated.priority}`;
}

/**
 * Ajusta el stock en el POS (NexusOS).
 *
 * NO escribe aca: arma el pendiente y le pide confirmacion al usuario. La
 * escritura ocurre en el siguiente mensaje, dentro de stockFlow.procesar.
 */
async function actionAdjustStock(data, ctx) {
  return stockFlow.preparar(ctx.chatId, data);
}

/** Genera un documento en Markdown y responde con su contenido. */
async function actionCreateDocument(data, ctx) {
  const title = (data.title || 'Documento').trim();
  const content = (data.content || '').trim() || `_Sin contenido adicional._\n\n_${title}_`;

  const doc = [
    `# ${title}`,
    '',
    `> Generado por OrbitaOs · ${formatDate(new Date(), ctx.timezone)}`,
    '',
    content,
  ].join('\n');

  await persistMessage({
    chatId: ctx.chatId,
    from: 'orbitaos',
    to: ctx.owner,
    direction: 'outbound',
    body: `[documento] ${title}`,
    intent: 'create_document',
    data: { title, type: data.type || 'document' },
  });

  return `📄 *${title}*\n\n${doc}`;
}

/* =========================================================================
 * Comandos directos (no pasan por la IA)
 * ====================================================================== */

const HELP_TEXT = [
  '🤖 *OrbitaOs* — tu asistente de operaciones',
  '',
  'Puedo hacer esto:',
  '• 📅 Agendar citas y reuniones',
  '• 📄 Redactar documentos e informes',
  '• ✅ Crear y actualizar tareas del pipeline',
  '• 💬 Charlar y pedirme cosas',
  '',
  '*Ejemplos*',
  '"Agenda una reunion con el equipo el 12/09 a las 15:00"',
  '"Crear una tarea urgente: llamar al proveedor antes del viernes"',
  '"Redacta un acta de la reunion de ayer"',
  '"Completar la tarea de llamar al proveedor"',
  '',
  '*Comandos*',
  '/help — esta ayuda',
  '/agenda — tus proximas citas',
  '/tareas — el estado de tu pipeline',
  '/tarea — dar de alta una tarea paso a paso (sin gastar IA)',
  '/estado — diagnostico del sistema',
  '/contactos — la lista blanca',
  '/agregar <numero> <nombre> — autoriza a alguien',
  '/quitar <numero> — revoca el acceso',
].join('\n');

/** Lista los proximos eventos del usuario. */
async function commandAgenda(owner) {
  const events = await Event.find({
    owner,
    status: 'confirmed',
    startAt: { $gte: new Date() },
  })
    .sort({ startAt: 1 })
    .limit(10)
    .lean();

  if (!events.length) return '📅 No tenes citas programadas.';

  const lines = ['📅 *Tus proximas citas*', ''];
  for (const e of events) {
    lines.push(`• *${e.title}*`);
    lines.push(`  🗓 ${formatDate(e.startAt)}`);
    if (e.location) lines.push(`  📍 ${e.location}`);
  }
  return lines.join('\n');
}

/** Lista las tareas agrupadas por columna del Kanban. */
async function commandTasks(owner) {
  const tasks = await Task.find({ owner, status: { $ne: 'done' } })
    .sort({ position: 1 })
    .lean();

  if (!tasks.length) return '✅ No tenes tareas pendientes.';

  const columns = {
    backlog: '🗂 Backlog',
    todo: '📌 Por hacer',
    in_progress: '⚙️ En progreso',
    review: '👀 En revision',
  };

  const lines = ['✅ *Tu pipeline*', ''];
  for (const [key, label] of Object.entries(columns)) {
    const group = tasks.filter((t) => t.status === key);
    if (!group.length) continue;
    lines.push(`*${label}*`);
    for (const t of group) {
      const due = t.dueAt ? ` (vence ${formatDate(t.dueAt)})` : '';
      lines.push(`• ${t.title} — ${t.priority}${due}`);
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}

/** Diagnostico del sistema. */
async function commandStatus() {
  const [totalUsers, allowedCount, messages, events, tasks] = await Promise.all([
    User.countDocuments(),
    User.countDocuments({ allowed: true }),
    Message.countDocuments(),
    Event.countDocuments(),
    Task.countDocuments(),
  ]);
  const mode = process.env.SPACE_BUNNY_API_KEY
    ? 'Space Bunny Alpha'
    : 'MODO MOCK (sin IA)';
  const uso = ai.getUsage();
  return [
    '🛰 *Estado de OrbitaOs*',
    '',
    `• IA: ${mode}`,
    `• Usuarios: ${totalUsers} (${allowedCount} con acceso)`,
    `• Mensajes: ${messages}`,
    `• Eventos: ${events}`,
    `• Tareas: ${tasks}`,
    `• Cron: ${process.env.CRON_REMINDERS || '*/1 * * * *'}`,
    '',
    `💰 *Gasto de hoy*`,
    `• Llamadas: ${uso.llamadas}${uso.tope_diario ? ` de ${uso.tope_diario} (tope)` : ''}`,
    `• Tokens: ${uso.tokens_total} (${uso.tokens_prompt} entrada + ${uso.tokens_completion} salida)`,
    `• Errores: ${uso.errores}`,
  ].join('\n');
}

// Solo los usuarios con rol owner o admin pueden agregar o quitar contactos.

/** Indica si el usuario puede administrar la lista blanca. */
async function isAdmin(phone) {
  const clean = normalizePhone(phone);
  const ADMIN_PHONES = (process.env.ADMIN_WHITELIST || '')
    .split(',')
    .map((p) => normalizePhone(p))
    .filter(Boolean);
  if (ADMIN_PHONES.some((p) => whitelist.mismoTelefono(p, clean))) return true;

  // Tambien si el usuario esta marcado como owner o admin en la base.
  // Busca por variantes para que un telefono guardado con otro formato no lo
  // deje fuera de la administracion de la lista blanca.
  try {
    const u = await users.findByPhone(clean);
    return Boolean(u && (u.role === 'owner' || u.role === 'admin'));
  } catch (_) {
    return false;
  }
}

/** Comando /agregar <numero> [nombre] */
async function commandAddContact(args, fromPhone) {
  const [rawPhone, ...rest] = args;
  const phone = normalizePhone(rawPhone || '');

  if (phone.length < 8) {
    return 'Uso: /agregar <numero> [nombre]\nEj: /agregar 5491198765432 Ana';
  }

  const name = rest.join(' ').trim();
  // Busca por variantes: si el numero ya existe con otro formato se actualiza
  // ese registro en vez de intentar crear uno que choca con el indice unico.
  const existe = await users.findByPhone(phone);

  if (existe) {
    await User.updateOne(
      { _id: existe._id },
      { $set: { phone, allowed: true, ...(name ? { name } : {}) } }
    );
    return `✅ *${phone}* ya estaba en la lista. Acceso reactivado.`;
  }

  await User.create({
    username: `wa${phone}`,
    passwordHash: 'sin-acceso-por-whatsapp',
    phone,
    name,
    role: 'member',
    allowed: true,
  });

  return `✅ *Contacto agregado*\n\n📱 ${phone}${name ? `\n👤 ${name}` : ''}\n\nYa puede escribir al bot.`;
}

/** Comando /quitar <numero> */
async function commandRemoveContact(args) {
  const phone = normalizePhone(args[0] || '');
  if (phone.length < 8) return 'Uso: /quitar <numero>\nEj: /quitar 5491198765432';

  // Igual que al agregar: se resuelve el registro por variantes y se borra ese,
  // para no decir "no existe" cuando el numero esta guardado con otro formato.
  const existe = await users.findByPhone(phone);
  if (!existe) return `No hay ningun contacto con ${phone}.`;

  const r = await User.deleteOne({ _id: existe._id });
  if (!r.deletedCount) return `No hay ningun contacto con ${phone}.`;
  return `🗑 *${phone}* eliminado de la lista blanca. Ya no puede escribir al bot.`;
}

/** Comando /contactos — lista la lista blanca. */
async function commandListContacts() {
  const lista = await User.find({ phone: { $ne: null } }).sort({ createdAt: -1 }).lean();
  if (!lista.length) {
    return '📋 *Lista blanca vacía*\n\nAgregá el primero con:\n/agregar <numero> <nombre>';
  }

  const lines = [`📋 *Lista blanca* (${lista.length})`, ''];
  for (const u of lista.slice(0, 30)) {
    const marca = u.allowed ? '✅' : '⛔';
    lines.push(`${marca} ${u.phone}${u.name ? ` — ${u.name}` : ''}`);
  }
  if (lista.length > 30) lines.push(`\n_y ${lista.length - 30} más…_`);

  lines.push('', '_Agregar: /agregar <numero> <nombre>_', '_Quitar: /quitar <numero>_');
  return lines.join('\n');
}

/* =========================================================================
 * Orquestacion de mensajes
 * ====================================================================== */

/**
 * Lineas ya avisadas, para no repetirlas miles de veces. Los estados de un
 * contacto generan cientos de eventos por minuto y, sin esto, el log del
 * contenedor queda inutilizable y tapa lo que de verdad importa.
 */
const avisados = new Set();

/** Loguea una sola vez por clave. Devuelve true si la imprimio. */
function avisarUnaVez(clave, texto) {
  if (avisados.has(clave)) return false;
  avisados.add(clave);
  console.log(texto);
  return true;
}

// Procesa un mensaje entrante: valida, persiste, enruta a la IA y responde.
async function handleMessage(msg) {
  const isGroup = whitelist.esGrupo(msg.from);
  const body = (msg.body || '').trim();
  const remitenteId = whitelist.remitenteDe(msg);

  // --- Estados y difusiones: NO son conversaciones ---
  // Los estados de WhatsApp llegan como "status@broadcast", sin remitente real:
  // al normalizar quedan en cadena vacia. Antes se intentaba resolver el
  // contacto y asi cada foto o video de un estado podia terminar entrando al
  // pipeline y gastando una llamada a la IA. Se cortan aca, antes de tocar la
  // base, la ficha del contacto o la IA.
  if (whitelist.esDifusion(remitenteId) || whitelist.esDifusion(msg.from)) {
    entradas.descartados += 1;
    avisarUnaVez(
      'difusion',
      '[wa] estados/difusiones de WhatsApp ignorados (no son conversaciones)'
    );
    return;
  }

  // Traza de ENTRADA, antes de cualquier filtro. Sin esto no se puede saber si
  // un mensaje que no genera respuesta llego y se descarto, o si nunca llego
  // (sesion desincronizada, mensaje del propio bot, evento que no dispara).
  // El cuerpo solo se imprime si LOG_MESSAGES esta activo.
  console.log(
    `[wa] evento recibido: tipo=${msg.type || 'sin-tipo'} ` +
    `remitente=${whitelist.enmascarar(whitelist.remitenteDe(msg))} ` +
    (body ? `con texto (${body.length} car.)` : 'sin texto')
  );
  entradas.recibidos += 1;
  entradas.ultimo_tipo = msg.type || null;
  entradas.ultimo_recibido = new Date().toISOString();

  if (!body) return;
  // Ignora estados (read, delivered) y mensajes de sistema: solo se atiende
  // el chat de texto, en privado y en grupo.
  if (!isGroup && msg.type !== 'chat') {
    // Se resume: una linea por tipo, no una por foto o video.
    avisarUnaVez(
      `tipo-${msg.type}`,
      `[wa] eventos de tipo ${msg.type} descartados (solo se atiende texto). ` +
      'Contados en entradas.descartados.'
    );
    entradas.descartados += 1;
    return;
  }

  // --- Quien mando el mensaje ---
  // En grupos el remitente es msg.author (msg.from es el grupo). Y con los ids
  // nuevos "@lid" el remitente no es un telefono: hay que resolverlo contra la
  // ficha del contacto antes de comparar nada.
  const remitente = await resolverRemitente(msg);
  if (!remitente.phone) return;

  // --- Lista blanca: solo los autorizados ---
  // Va antes de guardar el mensaje y antes de llamar a la IA. Lo que no esta
  // autorizado no entra al pipeline: se le manda el saludo fijo y listo.
  const veredicto = await autorizarRemitente(remitente.phone);
  if (!veredicto.permitido) {
    entradas.descartados += 1;
    // El bot no se saluda a si mismo, y los que no tienen remitente no
    // reciben nada: solo se saluda a quien si tiene un telefono real.
    if (veredicto.motivo === whitelist.MOTIVOS.NO_AUTORIZADO) {
      await responderSaludoAutomatico(msg, remitente.phone);
    }
    return;
  }
  entradas.autorizados += 1;

  // Si el mensaje llego con otro formato (numero local, con signos), la
  // conversacion se guarda bajo el telefono que tiene el usuario en la base.
  // Asi el panel no le abre dos chats distintos a la misma persona.
  const autorizado = await users.findAllowedByPhone(remitente.phone);
  const phone = (autorizado && autorizado.phone) || remitente.phone;
  const chatId = isGroup ? normalizePhone(msg.from) : phone;

  // En grupos solo responde si lo invocan con el prefijo configurado.
  const prefix = process.env.GROUP_PREFIX || '';
  if (isGroup && (!prefix || !body.startsWith(prefix))) return;

  if (LOG_MESSAGES) {
    console.log(
      `[wa] ${isGroup ? `${whitelist.enmascarar(phone)} en grupo` : phone}: ${body}`
    );
  }

  const user = await getOrCreateUser(phone);
  const cleanBody = isGroup ? body.slice(prefix.length).trim() : body;
  // "from" es quien escribe (no el grupo) para que la bitacora y las acciones
  // queden atribuidas a la persona, no al chat compartido.
  const ctx = {
    owner: chatId,
    from: phone,
    chatId,
    timezone: user.timezone,
  };

  // 1) Guardar el mensaje entrante.
  await persistMessage({
    chatId,
    from: phone,
    to: 'orbitaos',
    direction: 'inbound',
    body: cleanBody,
    isGroup,
    whatsappMessageId: msg.id && msg.id._serialized,
  });

  // 2) Comandos directos.
  const lower = cleanBody.toLowerCase();
  let reply = null;

  // 2a) Gestion de la lista blanca, accesible desde el celular.
  //     Solo owner/admin; el resto recibe un rechazo.
  const partes = cleanBody.trim().split(/\s+/);
  const comando = partes[0] ? partes[0].toLowerCase() : '';
  const args = partes.slice(1);

  try {
    if (['/agregar', '/add', '/quitar', '/remove', '/contactos', '/lista'].includes(comando)) {
      if (!(await isAdmin(remitente.phone))) {
        reply = '⛔ No tenés permiso para administrar la lista blanca.';
      } else if (comando === '/agregar' || comando === '/add') {
        reply = await commandAddContact(args);
      } else if (comando === '/quitar' || comando === '/remove') {
        reply = await commandRemoveContact(args);
      } else {
        reply = await commandListContacts();
      }
    } else if (lower === '/help' || lower === 'ayuda') {
      reply = HELP_TEXT;
    } else if (lower === '/agenda') {
      reply = await commandAgenda(chatId);
    } else if (lower === '/tareas') {
      reply = await commandTasks(chatId);
    } else if (lower === '/estado') {
      reply = await commandStatus();
    }
  } catch (err) {
    console.error(`[cmd] fallo el comando: ${err.message}`);
    reply = 'Hubo un problema al ejecutar ese comando.';
  }

  // 2b) Flujo guiado de alta de tareas. Va ANTES de la IA a proposito:
  //     si el usuario esta completando el formulario, cada respuesta se
  //     resuelve con reglas locales y no se gasta un solo token. La IA solo
  //     entra si el mensaje no pertenece a un flujo en curso.
  if (!reply && taskFlow.estaActivo(chatId)) {
    try {
      const r = await taskFlow.procesar(chatId, cleanBody, ctx);
      reply = r.reply;
    } catch (err) {
      console.error(`[flow] fallo el flujo de tarea: ${err.message}`);
      taskFlow.cancelar(chatId);
      reply = 'Hubo un problema con el alta de la tarea. Volvé a empezar con `/tarea`.';
    }
  }

  // 2b-bis) Carga de stock en el POS. Tiene el mismo criterio que 2b: si hay
  //     una carga pendiente, la respuesta del usuario NO es una conversacion
  //     nueva. Va antes de respuestaLocal porque un "dale" de confirmacion
  //     seria interceptado como saludo y la carga nunca se aplicaria.
  if (!reply && stockFlow.estaActivo(chatId)) {
    try {
      const r = await stockFlow.procesar(chatId, cleanBody, ctx);
      reply = r.reply;
    } catch (err) {
      console.error(`[stock] fallo la carga de stock: ${err.message}`);
      stockFlow.cancelar(chatId);
      reply = 'Hubo un problema con la carga de stock. No se aplico nada.';
    }
  }

  // 2c) Pedir una tarea de forma explicita, sin pasar por la IA.
  if (!reply && taskFlow.detectarIntencion(cleanBody)) {
    const flujo = taskFlow.iniciar(chatId);
    reply = taskFlow.saludoInicial(flujo);
  }

  // 2d) Intentos de manipular al modelo. No llegan a la IA: no gastan token y
  //     quedan registrados para que el operador vea que alguien esta probando.
  if (!reply && inyeccion.debeBloquear(cleanBody)) {
    const hallazgo = inyeccion.detectar(cleanBody);
    entradas.inyecciones = (entradas.inyecciones || 0) + 1;
    console.warn(
      `[seguridad] intento de manipular al modelo (${hallazgo.regla}) desde ` +
      `${whitelist.enmascarar(phone)}: ${hallazgo.motivo}`
    );
    reply = INYECCION_MSG;
  }

  // 2e) Saludos, agradecimientos y confirmaciones: se resuelven con reglas
  //     locales. Son los mensajes mas frecuentes y no necesitan un modelo, asi
  //     que responderlos por aqui es lo que hace que la IA se use "solo cuando
  //     es necesario".
  if (!reply) {
    reply = respuestaLocal(cleanBody);
    if (reply) {
      console.log('[wa] respuesta local (sin IA)');
    }
  }

  // 3) Sin comando: la IA decide la intencion.
  if (!reply) {
    try {
      const history = await getHistory(chatId);
      // Se descarta el ultimo inbound: ya viaja aparte en el prompt.
      const context = history.slice(0, -1);

      const result = await ai.route(cleanBody, {
        history: context,
        timezone: user.timezone,
        displayName: user.name,
      });

      // 4) Ejecutar la accion segun la intencion.
      //    Si faltan datos, el router ya fijo el mensaje predeterminado y no
      //    hay nada que ejecutar todavia: solo se le pide la informacion.
      if (result.faltan_datos) {
        reply = result.response_text;
        console.log(
          `[ai] ${result.intent}: faltan datos, se pide la informacion faltante`
        );
      } else {
        switch (result.intent) {
          case 'schedule_event':
            reply = await actionScheduleEvent(result.data, ctx);
            break;
          case 'add_task':
            reply = await actionAddTask(result.data, ctx);
            break;
          case 'update_task':
            reply = await actionUpdateTask(result.data, ctx);
            break;
          case 'create_document':
            reply = await actionCreateDocument(result.data, ctx);
            break;
          case 'adjust_stock': {
            // El flujo devuelve { reply, estado }. El estado va a la bitacora
            // para poder ver despues si hubo apply, cancelacion o error.
            const r = await actionAdjustStock(result.data, ctx);
            reply = r.reply;
            break;
          }
          default:
            reply = result.response_text;
        }
      }

      // 5) Registrar la intencion detectada junto a la respuesta.
      await persistMessage({
        chatId,
        from: 'orbitaos',
        to: chatId,
        direction: 'outbound',
        body: reply,
        intent: result.intent,
        data: result.data,
        fallback: Boolean(result.mock || result.fallback_reason),
        isGroup,
      });
    } catch (err) {
      console.error(`[ai] fallo el procesamiento: ${err.message}`);
      reply = 'Hubo un problema procesando tu mensaje. Reintentá en un momento.';
    }
  }

  if (!reply) reply = 'No pude generar una respuesta. Probá reformularlo.';

  // 6) Enviar.
  try {
    await client.sendMessage(msg.from, reply);
  } catch (err) {
    console.error(`[wa] no se pudo enviar la respuesta: ${err.message}`);
  }
}


/* =========================================================================
 * Arranque y apagado
 * ====================================================================== */

let cronTask = null;
let tareaProgramados = null;
let httpServer = null;

/** Registra los eventos de ciclo de vida del cliente de WhatsApp. */
function registerClientEvents() {
  // --- Emparejamiento por CODIGO: lo unico util en un servidor sin monitor ---
  client.on('code', (code) => {
    ultimoCodigo = code;
    codigosEmitidos += 1;
    health.setPairingCode(code);
    console.log('\n' + '='.repeat(64));
    console.log('  CODIGO DE EMPAREJAMIENTO: ' + code);
    console.log('='.repeat(64));
    console.log('\n  En tu celular (WhatsApp > Dispositivos vinculados):');
    console.log('    1. Menú ≡  →  Dispositivos vinculados');
    console.log('    2. Entrá en "Vincular con número de teléfono"');
    console.log(`    3. Ingresá este código: ${code}`);
    console.log('\n  El código cambia cada pocos minutos.');
    console.log('  Usá SIEMPRE el ÚLTIMO que aparezca en los logs.');
    console.log(`  [actual: ${code}]`);
    console.log(`  [también en el panel: GET /  ->  "codigo_vinculacion"]\n`);

    // Si ya se emitieron muchos codigos sin autenticar, algo mas esta mal y
    // conviene decirlo en vez de seguir escupiendo codigos en silencio.
    if (codigosEmitidos === 5) {
      console.warn('[wa] Ya van 5 codigos sin vincular. Si al ingresarlos WhatsApp');
      console.warn('[wa] responde "no se pudo vincular", revisá:');
      console.warn(`[wa]   1. Que BOT_PHONE sea el número correcto (ahora: ${BOT_PHONE}),`);
      console.warn('[wa]      con prefijo de país y SIN + ni espacios. Ej: 595981123456');
      console.warn('[wa]   2. Que el código se ingrese dentro de los 3 minutos.');
      console.warn('[wa]   3. Que el volumen session-data no tenga una sesión vieja.');
    }
  });

  // --- QR: solo cuando NO hay BOT_PHONE definido ---
  // Con BOT_PHONE el emparejamiento es por código de 8 caracteres, que es lo
  // único útil en un servidor sin monitor. WhatsApp renueva el QR cada ~20 s,
  // así que si se imprimiera llenaría los logs de ruido: se descarta.
  let qrAvisado = false;
  client.on('qr', (qr) => {
    qrVisto = true;
    if (resolverQr) resolverQr();
    if (BOT_PHONE) {
      if (!qrAvisado) {
        console.log('[wa] El navegador pidió un QR, pero BOT_PHONE está definido:');
        console.log('[wa] se usa el código de emparejamiento de arriba.');
        qrAvisado = true;
      }
      return;
    }
    console.log('\n[wa] Escanea este QR con WhatsApp > Dispositivos vinculados:');
    qrcode.generate(qr, { small: true }, (code) => console.log(code));
    console.log('\n[wa] Si no podés escanear el QR, definí BOT_PHONE en el entorno');
    console.log('[wa] para obtener un código de 8 caracteres en su lugar.\n');
  });

  client.on('authenticated', () => {
    sesionVinculada = true;
    console.log('[wa] Autenticado. Sesion vinculada.');
    // Ya no hace falta mostrarlo: se evita que quede un codigo viejo en la web.
    ultimoCodigo = null;
    codigosEmitidos = 0;
    health.setPairingCode(null);
  });
  client.on('ready', () => {
    console.log('[wa] OrbitaOs listo y escuchando mensajes.');
    // Numero realmente vinculado. Si no es el de BOT_PHONE, el bot esta
    // escuchando en otra linea y no recibe lo que uno espera.
    // client.info todavia no existe en este instante, asi que se consulta al
    // navegador y se avisa si tampoco se puede.
    conTope(client.getWid(), 10000, 'no se pudo consultar el numero vinculado')
      .then((wid) => {
        const vinculado = whitelist.normalizePhone(wid && wid._serialized);
        if (!vinculado) {
          console.log('[wa] no se pudo leer el numero vinculado');
          return;
        }
        console.log(
          `[wa] numero vinculado: ${vinculado}` +
            (BOT_PHONE && vinculado !== BOT_PHONE
              ? ` (distinto de BOT_PHONE=${BOT_PHONE})`
              : '')
        );
      })
      .catch((err) => console.warn(`[wa] numero vinculado: ${err.message}`));
    health.setReady(true);
  });
  client.on('auth_failure', (msg) => {
    console.error(`[wa] Fallo de autenticacion: ${msg}`);
    console.error('[wa] El servicio reintenta solo. Para vincular de nuevo, usá el');
    console.error('[wa] ÚLTIMO código de emparejamiento que aparezca aquí abajo.');
  });
  client.on('disconnected', (reason) => {
    console.warn(`[wa] Desconectado: ${reason}`);
    health.setReady(false);

    // Un LOGOUT deja la pagina de WhatsApp Web con los bindings viejos de
    // Puppeteer ("window['onQRChangedEvent'] already exists"). Si se intenta
    // reinyectar encima, el proceso revienta. La salida es cerrar el navegador
    // y arrancar uno limpio, que es lo unico que deja la sesion utilizable.
    if (MOTIVOS_REINICIO.includes(reason)) {
      reiniciarCliente(reason).catch((err) =>
        console.error(`[wa] no se pudo reiniciar el cliente: ${err.message}`)
      );
    }
  });
  client.on('message', (msg) => {
    // Cada mensaje se procesa por separado; uno fallido no corta el flujo.
    handleMessage(msg).catch((err) => console.error(`[wa] error no capturado: ${err.message}`));
  });
}

/**
 * Motivos de desconexion que exigen arrancar el navegador de cero. Un LOGOUT o
 * un UNPAIRED dejan la pagina con bindings viejos de Puppeteer: reinyectar
 * encima tira el proceso.
 */
const MOTIVOS_REINICIO = ['LOGOUT', 'UNPAIRED', 'CONFLICT', 'NAVIGATION'];

/** Evita que dos reinicios se pisen entre si. */
let reiniciando = false;

/**
 * Cierra el navegador y levanta uno limpio, para volver a dejar el cliente
 * utilizable despues de un logout o de un conflicto de sesion.
 */
async function reiniciarCliente(motivo) {
  if (reiniciando) return;
  reiniciando = true;
  console.warn(`[wa] reiniciando el cliente de WhatsApp (motivo: ${motivo})`);
  health.setReady(false);

  try {
    await client.destroy();
  } catch (err) {
    console.warn(`[wa] al cerrar el navegador: ${err.message}`);
  }
  sesionVinculada = false;

  try {
    await client.initialize();
    // Si de verdad no hay sesion (recien desvinculado), se pide el codigo.
    const yaVinculado = await esperarVinculacion(20000);
    if (!yaVinculado && BOT_PHONE) {
      await esperarPaginaQr(90000);
      await pedirCodigoDeEmparejamiento();
    }
  } catch (err) {
    console.error(`[wa] fallo el reinicio del cliente: ${err.message}`);
  } finally {
    reiniciando = false;
  }
}

/** Apagado ordenado: cierra el navegador y la base de datos. */
async function shutdown(signal) {
  console.log(`\n[app] recibido ${signal}, cerrando...`);
  cron.stopReminderJobs(cronTask);
  programados.stopScheduledJob(tareaProgramados);
  if (httpServer) {
    try {
      await new Promise((resolve) => httpServer.close(resolve));
    } catch (_) {
      /* el servidor puede estar caido */
    }
  }
  try {
    await client.destroy();
  } catch (_) {
    /* el navegador puede estar caido */
  }
  try {
    await db.disconnect();
  } catch (_) {
    /* la conexion puede estar caida */
  }
  process.exit(0);
}

/** Punto de entrada. */
async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('[app] falta la variable MONGO_URI');
    process.exit(1);
  }

  // Se aplica antes de levantar el cliente: whatsapp-web.js inyecta estos
  // archivos en el navegador, asi que el parche tiene que estar en disco ya.
  // Es idempotente, y si la libreria no esta instalada (por ejemplo en las
  // pruebas) no molesta.
  try {
    require('./scripts/patch_whatsapp');
  } catch (err) {
    console.warn(`[wa] no se pudo aplicar el parche de whatsapp-web.js: ${err.message}`);
  }

  console.log('[app] conectando a MongoDB...');
  await db.connect(uri);

  // Servidor de salud. Arranca antes que WhatsApp para que el orquestador
  // vea el contenedor como vivo aun si el navegador tarda en vincularse.
  try {
    httpServer = await health.startHealthServer({ client });
  } catch (err) {
    console.error(`[http] no se pudo iniciar el servidor de salud: ${err.message}`);
  }

  // Primer arranque: crea el usuario owner si la base esta vacia.
  try {
    const boot = await users.ensureBootstrapUser();
    if (boot.created) {
      console.log(`[app] usuario owner creado: "${boot.username}"`);
    }
  } catch (err) {
    // No se detiene el arranque: el bot puede seguir operando con la lista
    // blanca, y el usuario se puede crear despues con el script de gestion.
    console.error(`[app] no se pudo crear el usuario inicial: ${err.message}`);
  }

  // Telefonos de WHITELIST se dan de alta como usuarios con acceso, para
  // que la lista blanca viva en la base y no solo en el entorno.
  const envPhones = envWhitelist();
  for (const phone of envPhones) {
    const existe = await users.findByPhone(phone);
    if (!existe) {
      try {
        await User.create({
          username: `wa${phone}`,
          passwordHash: 'sin-acceso-por-whatsapp',
          phone,
          name: '',
          allowed: true,
        });
        console.log(`[app] usuario de WhatsApp dado de alta: ${phone}`);
      } catch (err) {
        console.error(`[app] no se pudo dar de alta ${phone}: ${err.message}`);
      }
    }
  }

  // La lista blanca efectiva: usuarios con telefono y allowed=true. Es lo unico
  // que autoriza a hablar con el bot; BOT_PHONE no cuenta.
  const conAcceso = await User.countDocuments({ allowed: true, phone: { $ne: null } });
  console.log(`[app] MongoDB conectado. Usuarios con acceso: ${conAcceso}`);
  if (conAcceso === 0 && envPhones.length === 0) {
    console.warn('[app] ATENCION: ningun usuario con acceso. El bot no respondera a nadie.');
    console.warn('[app] Crea uno con: npm run user -- create <usuario> <clave> --phone <numero>');
  }
  if (BOT_PHONE) {
    console.log(`[app] numero del bot: ${BOT_PHONE} (solo vincula la sesion, no autoriza remitentes)`);
  }

  registerClientEvents();
  await initializeWithRecovery();

  // El cron solo arranca con WhatsApp listo: tanto los recordatorios como los
  // mensajes programados se envian por el mismo cliente.
  client.on('ready', () => {
    if (!cronTask) cronTask = cron.startReminderJobs(client);
    if (!tareaProgramados) tareaProgramados = programados.startScheduledJob(client);
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => shutdown(signal));
  }

  process.on('unhandledRejection', (reason) => {
    console.error('[app] promesa rechazada sin manejar:', reason);
    recuperarDeErrorFatal(reason);
  });

  // Sin esto, cualquier error interno de whatsapp-web.js tumba el proceso y el
  // bot deja de responder hasta que el orquestador lo reinicie. Caso real:
  // tras cerrar sesion desde el celular, la libreria reinyecta sobre una pagina
  // que ya tiene los bindings ("window['onQRChangedEvent'] already exists") y
  // revienta. Se registra y, si el navegador quedo inservible, se reconstruye.
  process.on('uncaughtException', (err) => {
    console.error(`[app] excepcion no capturada: ${err.message}`);
    recuperarDeErrorFatal(err);
  });
}

/**
 * Decide que hacer ante un error que viene de la libreria de WhatsApp.
 * Los errores de bindings y de sesion cerrada se recuperan reconstruyendo el
 * navegador; el resto se registra y se sigue, sin tumbar el servicio.
 */
function recuperarDeErrorFatal(error) {
  const mensaje = String((error && error.message) || error || '');
  if (/already exists|Failed to add page binding|Session closed|Target closed|Navigation|frame was detached/i.test(mensaje)) {
    console.error('[app] el navegador quedo inservible: se va a reconstruir.');
    reiniciarCliente('error de navegador').catch((err) =>
      console.error(`[app] no se pudo recuperar: ${err.message}`)
    );
  }
}
/**
 * Corre una promesa pero no la espera mas de `ms`. Si se pasa, se rechaza con
 * `motivo`: hay llamadas al navegador que quedan colgadas y no deben frenar el
 * arranque ni el procesamiento de mensajes.
 */
function conTope(promesa, ms, motivo) {
  return new Promise((resolve, reject) => {
    const temporizador = setTimeout(
      () => reject(new Error(motivo || `tope de ${ms} ms superado`)),
      ms
    );
    Promise.resolve(promesa).then(
      (valor) => {
        clearTimeout(temporizador);
        resolve(valor);
      },
      (err) => {
        clearTimeout(temporizador);
        reject(err);
      }
    );
  });
}

/**
 * Espera a que la sesion de WhatsApp se anuncie (authenticated o ready).
 * Devuelve true si se anuncio dentro del plazo, false si se agoto.
 *
 * initialize() resuelve antes de que esto ocurra, asi que sin esta espera el
 * arranque no puede distinguir "sesion nueva" de "sesion ya vinculada".
 */
function esperarVinculacion(ms) {
  if (sesionVinculada) return Promise.resolve(true);
  return new Promise((resolve) => {
    let listo = false;
    const terminar = (valor) => {
      if (listo) return;
      listo = true;
      clearTimeout(temporizador);
      client.removeListener('authenticated', alAutenticar);
      client.removeListener('ready', alListo);
      resolve(valor);
    };
    const alAutenticar = () => terminar(true);
    const alListo = () => terminar(true);
    const temporizador = setTimeout(() => terminar(false), ms);
    client.once('authenticated', alAutenticar);
    client.once('ready', alListo);
  });
}

/** Espera un tiempo. */
function dormir(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Espera a que la pagina de WhatsApp Web este cargada y muestre el QR.
 *
 * Importa: pedir el codigo de emparejamiento antes de que la pagina exista
 * hace que la llamada al navegador se quede esperando y expire, que es
 * exactamente lo que pasaba en produccion ("no se pudo pedir el codigo").
 */
function esperarPaginaQr(ms) {
  if (qrVisto) return Promise.resolve(true);
  return new Promise((resolve) => {
    let listo = false;
    const terminar = (valor) => {
      if (listo) return;
      listo = true;
      clearTimeout(temporizador);
      resolverQr = null;
      resolve(valor);
    };
    resolverQr = () => terminar(true);
    const temporizador = setTimeout(() => terminar(false), ms);
    client.once('qr', () => terminar(true));
    client.once('authenticated', () => terminar(true));
  });
}

/**
 * Pide el codigo de emparejamiento, con reintentos.
 *
 * Si despues de todo no se obtiene, no se deja al usuario sin salida: se
 * muestra el QR en los logs, que sigue siendo una forma valida de vincular.
 */
async function pedirCodigoDeEmparejamiento(intentos = 3) {
  for (let i = 1; i <= intentos; i += 1) {
    try {
      await conTope(
        client.requestPairingCode(BOT_PHONE),
        90000,
        'el navegador no respondio'
      );
      return true;
    } catch (err) {
      console.error(
        `[wa] no se pudo pedir el codigo (intento ${i} de ${intentos}): ${err.message}`
      );
      if (i < intentos) await dormir(10000);
    }
  }

  console.error('[wa] No se pudo obtener el codigo de emparejamiento.');
  console.error('[wa] Revisá que BOT_PHONE tenga el prefijo del pais y solo digitos,');
  console.error(`[wa] por ejemplo 595981234567 y nada más.`);
  console.error('[wa] El codigo tambien se puede ver desde el panel, en GET /api/estado');
  console.error('[wa] (campo codigo_vinculacion), con la sesion abierta.');
  return false;
}

// Arranca Chromium y, si falla por un perfil bloqueado o corrupto, lo destruye y reintenta una vez.
async function initializeWithRecovery() {
  // Si hay BOT_PHONE se pide emparejamiento con codigo, que es lo unico
  // util en un servidor sin monitor.
  const wantsPairing = Boolean(BOT_PHONE);

  for (let intento = 1; intento <= 2; intento += 1) {
    try {
      if (intento === 2) {
        console.log('[wa] segundo intento: se reconstruye el perfil de Chromium');
        wipeChromiumProfile();
      }
      if (wantsPairing) {
        console.log(`[app] emparejamiento por codigo para el numero ${BOT_PHONE}`);
      } else {
        console.log('[app] sin BOT_PHONE: empareja escaneando el QR de los logs.');
      }
      await client.initialize();

      // initialize() vuelve antes de que la sesion restaurada termine de
      // declararse: los eventos 'authenticated' y 'ready' llegan despues. Si
      // se decide aca sin esperar, se pide un codigo de emparejamiento sobre una
      // sesion que ya funciona, la llamada al navegador se cuelga
      // ("Runtime.callFunctionOn timed out") y WhatsApp Web deja de procesar
      // los mensajes entrantes. Por eso se espera a que se anuncie.
      const yaVinculado = sesionVinculada || (await esperarVinculacion(15000));

      // Navegador arriba: con BOT_PHONE se pide el codigo de emparejamiento
      // en vez de mostrar el QR, que en un servidor no se puede escanear.
      //
      // PERO solo si la sesion todavia no esta vinculada. Si ya hay sesion
      // guardada, pedir un codigo es innecesario y peligroso: la llamada al
      // navegador se queda esperando y deja WhatsApp Web colgado.
      if (wantsPairing && !yaVinculado) {
        // Primero se espera a que la pagina exista: pedir el codigo apenas abre
        // el navegador hace que la llamada expire sin llegar a WhatsApp.
        console.log('[app] no hay sesion: esperando la pagina de WhatsApp Web...');
        const pagina = await esperarPaginaQr(90000);
        if (!pagina) {
          console.warn('[wa] la pagina no dio señales a tiempo: se intenta igual.');
        }
        await pedirCodigoDeEmparejamiento();
      } else if (wantsPairing) {
        console.log('[wa] sesion ya vinculada: no se pide codigo de emparejamiento.');
      }
      return;
    } catch (err) {
      const detalle = err && err.message ? err.message : String(err);
      const esPerfil = /profile appears to be in use|SingletonLock|Code: 21|display/i.test(
        detalle
      );

      if (intento === 1 && esPerfil) {
        console.error(`[wa] el perfil de Chromium esta bloqueado: ${detalle.split('\n')[0]}`);
        console.error('[wa] se intentará de nuevo con el perfil limpio...');
        continue;
      }

      console.error(`[wa] fallo irrecuperable al iniciar el navegador: ${detalle}`);
      console.error('[wa] Si el error sigue siendo "profile in use", borra el volumen');
      console.error('[wa] "session-data" desde Dokploy y redesplega.');
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error(`[app] error fatal: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});




