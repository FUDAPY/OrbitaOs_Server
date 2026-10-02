'use strict';
// OrbitaOs - deteccion de intentos de manipular al modelo.
//
// El bot manda el texto del remitente al modelo de lenguaje. Eso abre una
// puerta: alguien con acceso puede escribir "ignora las instrucciones..." y
// tratar de sacar el prompt o de hacer que el modelo se comporte distinto.
//
// Aqui solo se detectan intentos **inequivocos**: reemplazar o extraer las
// instrucciones del sistema. No se intenta adivinar intenciones, porque
// "actua como un chef" o "escribime un informe" son pedidos legitimos y
// bloquearlos romperia el uso normal.
//
// La defensa de verdad esta en el prompt (ver src/ai_router.js): esto es la
// segunda capa, la que avisa y evita gastar un token en el intento.
//
// Modulo puro: se prueba sin base de datos ni navegador.

// Reglas de alta precision. El texto se normaliza antes (ver normalizar).
const REGLAS = [
  {
    nombre: 'ignorar-instrucciones',
    // "ignora", "ignorar", "ignorá", "ignoralas": el sufijo se acepta entero.
    re: /\b(ignora\w*|olvida\w*|descarta\w*|disregard\w*)\b[\s\S]{0,40}?\b(instrucciones|indicaciones|reglas)\b/i,
    motivo: 'intenta descartar las instrucciones del sistema',
  },
  {
    nombre: 'ignorar-previas',
    re: /\bignore\b[\s\S]{0,30}?\b(all\s+the\s+)?(previous|prior|above|earlier)\b/i,
    motivo: 'intenta descartar el contexto previo',
  },
  {
    nombre: 'extraer-prompt',
    // "system" y "sistem": con leetspeak un 1 se lee como i y queda "sistem".
    re: /\b(system\s?prompt|systema?\s?prompt|sistem\s?prompt|prompt\s+(del|de)\s+sistema|your\s+(system\s+)?(prompt|instructions|rules)|tus\s+instrucciones)\b/i,
    motivo: 'intenta extraer las instrucciones del modelo',
  },
  {
    nombre: 'repetir-contexto',
    re: /\b(repite|repeat|print|mostra|imprim|reproduc)\w*\b[\s\S]{0,30}?\b(lo\s+anterior|todo\s+lo\s+(dicho|escrito|anterior)|everything\s+above)\b/i,
    motivo: 'intenta que el modelo repita el contexto del sistema',
  },
  {
    nombre: 'modo-jailbreak',
    re: /\b(developer\s+mode|modo\s+desarrollador|dan\s+mode|sin\s+(restricciones|limites|filtros)|without\s+(restrictions|filters))\b/i,
    motivo: 'intenta sacar al modelo de sus restricciones',
  },
];

/**
 * Normaliza el texto para que las reglas no dependan de acentos, mayusculas
 * ni de los tricks de homoglifos (leetspeak: "ign0ra", "1nstrucciones").
 */
function normalizar(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // quita los acentos
    .replace(/[0@]/g, 'o')
    .replace(/[1!|]/g, 'i')
    .replace(/[3]/g, 'e')
    .replace(/[4\$]/g, 'a')
    .replace(/[7]/g, 't')
    .replace(/[\s_-]+/g, ' ');
}

/**
 * Analiza un mensaje.
 * Devuelve { detectado, regla, motivo } con `regla` y `motivo` en null cuando
 * no hay nada que reportar.
 */
function detectar(texto) {
  // Un mensaje enorme es raro en un chat operativo y barria todo: se limita.
  const crudo = String(texto || '');
  if (crudo.length > 2000) return { detectado: false, regla: null, motivo: null };

  const limpio = normalizar(crudo);
  for (const regla of REGLAS) {
    if (regla.re.test(limpio)) {
      return { detectado: true, regla: regla.nombre, motivo: regla.motivo };
    }
  }
  return { detectado: false, regla: null, motivo: null };
}

// Respuesta al intento: corta, sin explicar que se detecto y sin datos del
// sistema. Se podria desactivar con ALLOW_INJECTION=1 para depurar.
function debeBloquear(texto) {
  if (String(process.env.ALLOW_INJECTION || '').toLowerCase() === 'true') return false;
  return detectar(texto).detectado;
}

module.exports = { detectar, debeBloquear, normalizar, REGLAS };