'use strict';
// OrbitaOs - politica de reintentos contra el proveedor de IA.
//
// El fallo real en produccion era:
//
//   Space Bunny 400: Upstream error: Provider returned an empty response
//
// Es un fallo TRANSITORIO del proveedor: la misma llamada, un segundo despues,
// funciona. Con un solo intento por llamada, un problema momentaneo del
// proveedor degradaba el bot entero a respuestas mock.
//
// Aqui se decide que merece reintento y cuanto se espera entre intentos.
// Modulo puro: se prueba sin red y sin API key.

// Estados donde reintentar tiene sentido: el proveedor esta saturado o
// devolvio algo temporal.
const REINTENTABLES = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

// Nunca se reintenta: la peticion esta mal (400 comun), o la clave no vale
// (401/403). Reintentar ahi solo gasta tiempo y, en el caso de la clave,
// se acerca al limite de peticiones.
const NO_REINTENTABLES = new Set([400, 401, 402, 403, 404, 405, 413, 422]);

/**
 * Un 400 con esta forma del cuerpo NO es un error del llamador: es el
 * proveedor de arriba devolviendo una respuesta vacia. Vale la pena reintentar.
 */
function esUpstreamVacio(cuerpo) {
  const t = String(cuerpo || '').toLowerCase();
  return (
    t.includes('upstream') &&
    (t.includes('empty response') || t.includes('respuesta vacia') || t.includes('empty'))
  );
}

/**
 * Decide si un fallo merece reintento.
 * `status` es el codigo HTTP, o null si fue un fallo de red (DNS, conexion).
 */
function esReintentable(status, cuerpo) {
  if (status === null || status === undefined) return true; // fallo de red
  if (status === 400) return esUpstreamVacio(cuerpo);
  if (NO_REINTENTABLES.has(status)) return false;
  if (REINTENTABLES.has(status)) return true;
  // Cualquier otro 5xx se reintenta: son errores del servidor, no del pedido.
  return status >= 500;
}

/**
 * Espera antes del siguiente intento: crece para no golpear el proveedor
 * mientras esta saturado. `i` es el numero de intento ya realizado (0-based).
 */
function espera(i) {
  const base = Number(process.env.AI_RETRY_BASE_MS || 800);
  const tope = Number(process.env.AI_RETRY_MAX_MS || 8000);
  return Math.min(base * 2 ** i, tope);
}

/** Cuantos intentos se hacen en total, incluido el primero. */
function intentosTotales() {
  const n = Number(process.env.AI_RETRY_INTENTOS || 3);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, 6) : 3;
}

module.exports = {
  REINTENTABLES,
  NO_REINTENTABLES,
  esReintentable,
  esUpstreamVacio,
  espera,
  intentosTotales,
};