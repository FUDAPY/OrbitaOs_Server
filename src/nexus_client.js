'use strict';
// OrbitaOs - cliente HTTP del API de NexusOS (POS / ERP / CRM).
//
// Unico punto de salida hacia el otro sistema. Todo lo que OrbitaOs le pide a
// NexusOS pasa por aca: consulta de stock y ajuste de inventario.
//
// Decisiones que importan:
//
// 1. El token de servicio viaja SIEMPRE en el header `x-service-token` y NUNCA
//    en la URL ni en el cuerpo. Tampoco se registra en logs ni se incluye en los
//    mensajes de error que ve el usuario.
// 2. `NEXUS_API_URL` trae el prefijo (ej. https://host/api/v1). El cliente no lo
//    agrega: si alguien lo pone mal, la falla es obvia y no un 404 confuso.
// 3. `enmascarar()` es la unica forma de nombrar al token hacia afuera. Evita que
//    un console.log futuro lo exponga por accidente.
// 4. Todo error se traduce a un `code` estable (el mismo que usa NexusOS) para
//    que el bot pueda decidir que mensaje le dice al usuario, sin parsear texto.

const crypto = require('crypto');

/** Prefijo de los errores propios de este modulo. */
const ERROR_CLIENTE = 'NEXUS_CLIENTE';

/** Codigos de error locales, para cuando el fallo es de OrbitaOs y no de NexusOS. */
const CODIGOS = {
  SIN_CONFIGURACION: 'NEXUS_SIN_CONFIGURACION',
  RED: 'NEXUS_SIN_CONEXION',
  TIMEOUT: 'NEXUS_TIMEOUT',
  NO_AUTORIZADO: 'NEXUS_NO_AUTORIZADO',
};

/** true si hay URL y token para trabajar. */
function configurado() {
  return Boolean(baseUrl() && process.env.NEXUS_SERVICE_TOKEN);
}

/** URL base sin barra final, para no duplicar separadores. */
function baseUrl() {
  return String(process.env.NEXUS_API_URL || '').trim().replace(/\/+$/, '');
}

/** Tiempo maximo de espera, acotado para no dejar el bot colgado. */
function timeoutMs() {
  const n = Number(process.env.NEXUS_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 60000) : 10000;
}

/**
 * Lista de sucursales configuradas, en el orden en que se declararon.
 *
 * Con una sola, el bot la usa sin preguntar. Con varias tiene que preguntar:
 * cargar en la sucursal equivocada es un error que nadie detecta hasta el
 * conteo de stock.
 *
 * Acepta tambien NEXUS_SUCURSAL (singular) por compatibilidad con
 * despliegues anteriores.
 */
function sucursales() {
  const lista = String(process.env.NEXUS_SUCURSALES || process.env.NEXUS_SUCURSAL || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set(lista)];
}

/**
 * Nombre seguro del token para logs. Muestra solo si hay token y nunca el valor:
 * "sb1…(52)" alcanza para depurar sin exponer el secreto.
 */
function enmascarar() {
  const t = process.env.NEXUS_SERVICE_TOKEN || '';
  return t ? `${t.slice(0, 3)}…(${t.length})` : '(vacio)';
}

/** Quita acentos y pasa a mayusculas: para comparar nombres sin depender de tildes. */
function normalizarTexto(valor) {
  return String(valor == null ? '' : valor)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Error de integracion con un `code` estable. El mensaje del servidor queda en
 * `detalle` para diagnostico; el bot muestra su propio texto, no este.
 */
class NexusError extends Error {
  constructor(code, mensaje, detalle) {
    super(mensaje);
    this.name = 'NexusError';
    this.code = code;
    this.detalle = detalle || '';
  }
}

/** Idempotency-Key: un UUID por operacion, nunca por reintento de red. */
function nuevoIdempotencyKey() {
  return crypto.randomUUID();
}

/**
 * Llamada HTTP a NexusOS. No tira por fuera: todo fallo vuelve como NexusError
 * para que el llamador elija el mensaje que ve el usuario.
 */
async function pedir(ruta, opciones = {}) {
  if (!configurado()) {
    throw new NexusError(
      CODIGOS.SIN_CONFIGURACION,
      'NexusOS no esta configurado en este servicio'
    );
  }

  const metodo = opciones.metodo || 'GET';
  // El token va en el header, nunca en la query ni en el cuerpo.
  const cabeceras = {
    Accept: 'application/json',
    'x-service-token': process.env.NEXUS_SERVICE_TOKEN,
  };
  if (opciones.body) cabeceras['Content-Type'] = 'application/json';
  if (opciones.idempotencyKey) cabeceras['Idempotency-Key'] = opciones.idempotencyKey;

  const controlador = new AbortController();
  const reloj = setTimeout(() => controlador.abort(), timeoutMs());

  let res;
  try {
    res = await fetch(`${baseUrl()}${ruta}`, {
      method: metodo,
      headers: cabeceras,
      body: opciones.body ? JSON.stringify(opciones.body) : undefined,
      signal: controlador.signal,
    });
  } catch (err) {
    // AbortError = se cumplio el timeout: el mensaje tiene que ser honesto.
    if (err && err.name === 'AbortError') {
      throw new NexusError(CODIGOS.TIMEOUT, 'NexusOS no respondio a tiempo');
    }
    throw new NexusError(CODIGOS.RED, 'No se pudo conectar con NexusOS', err && err.message);
  } finally {
    clearTimeout(reloj);
  }

  // El cuerpo puede venir vacio (204) o no ser JSON: se lee como texto y se
  // intenta parsear, para no perder el mensaje de error del servidor.
  const crudo = await res.text();
  let cuerpo = null;
  if (crudo) {
    try {
      cuerpo = JSON.parse(crudo);
    } catch {
      cuerpo = null;
    }
  }

  if (!res.ok) {
    const code = (cuerpo && cuerpo.code) || '';
    if (res.status === 401) {
      throw new NexusError(CODIGOS.NO_AUTORIZADO, 'NexusOS rechazo el token de servicio');
    }
    // Los codigos de negocio viajan tal cual: el bot los traduce.
    if (code) throw new NexusError(code, (cuerpo && cuerpo.error) || 'NexusOS devolvio un error');
    throw new NexusError(`${ERROR_CLIENTE}_${res.status}`, `NexusOS devolvio HTTP ${res.status}`);
  }

  return cuerpo && cuerpo.data !== undefined ? cuerpo.data : cuerpo;
}

/**
 * Busca productos por nombre. Devuelve la lista cruda del catalogo: decide el
 * llamador, porque "cual" de varios parecidos es una decision de negocio.
 *
 * @param {string} producto Texto tal cual lo escribio el usuario.
 * @param {{sucursal?: string}} [opciones]
 * @returns {Promise<Array<object>>} Items del catalogo.
 */
async function consultarStock(producto, opciones = {}) {
  const texto = String(producto || '').trim();
  if (!texto) return [];

  const params = new URLSearchParams({ producto: texto });
  if (opciones.sucursal) params.set('sucursal', opciones.sucursal);

  const data = await pedir(`/integrations/inventory/stock?${params.toString()}`);
  const items = data && Array.isArray(data.items) ? data.items : [];
  return items;
}

/**
 * Elige el producto que el usuario quiso decir.
 *
 * Nunca devuelve el primero a ciegas: si hay empate devuelve `null` y los
 * candidatos, para que el bot pregunte. Elegir mal significa cargar stock en el
 * producto equivocado y eso no se deshace solo.
 *
 * @param {Array<object>} items
 * @returns {{ok: true, item: object}|{ok: false, motivo: string, candidatos: Array<object>}}
 */
function elegirProducto(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, motivo: 'NO_ENCONTRADO', candidatos: [] };
  }
  if (items.length === 1) return { ok: true, item: items[0] };

  // Con varios, solo se acepta un candidato "obvio": el unico con stock. Si mas
  // de uno cumple, hay ambiguedad real y se pregunta.
  const conStock = items.filter((i) => Number(i.stock) > 0);
  if (conStock.length === 1) return { ok: true, item: conStock[0] };

  return { ok: false, motivo: 'AMBIGUO', candidatos: items.slice(0, 5) };
}

/**
 * Aplica un ajuste de stock. El `idempotencyKey` lo define el llamador para que
 * un reintento de la MISMA operacion reutilice la clave y NexusOS no duplique.
 *
 * @param {{producto: string, cantidad: number, modo: string, motivo?: string}} ajuste
 * @param {{sucursal?: string, idempotencyKey?: string, usuarioRol?: string}} [opciones]
 */
async function ajustarStock(ajuste, opciones = {}) {
  const producto = String(ajuste && ajuste.producto ? ajuste.producto : '').trim();
  const cantidad = Number(ajuste && ajuste.cantidad);
  if (!producto) throw new NexusError('PRODUCTO_INVALIDO', 'Falta el producto');
  if (!Number.isFinite(cantidad) || cantidad === 0) {
    throw new NexusError('CANTIDAD_INVALIDA', 'La cantidad no es valida');
  }

  const body = {
    ajustes: [
      {
        producto,
        // El signo NUNCA viaja en la cantidad: el modo define el sentido.
        cantidad: Math.abs(cantidad),
        modo: ajuste.modo || 'agregar',
        motivo: ajuste.motivo || 'Ingreso por WhatsApp (OrbitaOs)',
      },
    ],
    origen: 'orbitaos',
    usuario: 'OrbitaOs (WhatsApp)',
    canal: 'whatsapp',
  };
  if (opciones.sucursal) body.sucursal = opciones.sucursal;
  if (opciones.usuarioRol) body.usuarioRol = opciones.usuarioRol;

  return pedir('/integrations/inventory/adjustments', {
    metodo: 'POST',
    body,
    idempotencyKey: opciones.idempotencyKey || nuevoIdempotencyKey(),
  });
}

module.exports = {
  NexusError,
  CODIGOS,
  configurado,
  enmascarar,
  sucursales,
  normalizarTexto,
  nuevoIdempotencyKey,
  consultarStock,
  elegirProducto,
  ajustarStock,
};