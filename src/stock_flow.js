'use strict';
// OrbitaOs - flujo guiado de carga de stock contra NexusOS.
//
// POR QUE ES UN FLUJO Y NO UNA ACCION DIRECTA: escribir en el inventario de un
// POS es una operacion que no se deshace sola. Cargar 6 unidades en el producto
// equivocado significa vender stock que no existe y nadie se da cuenta hasta
// que el conteo falla. Por eso NUNCA se escribe a partir de texto libre: el
// bot arma el resumen, lo muestra y espera un "si" explicito.
//
// El estado vive en memoria por chat, igual que el flujo de tareas. Si el
// contenedor se reinicia, el pendiente se pierde: se vuelve a pedir, nunca se
// aplica a ciegas.

const nexus = require('./nexus_client');

/** El pendiente caduca si el usuario no responde en este tiempo. */
const TIMEOUT_MS = 15 * 60 * 1000;

/** Pendientes activos, por chat. */
const flujos = new Map();

/** Respuestas que confirman la operacion. */
const CONFIRMAR = /^(si|s|dale|dale2|listo|ok|oka|hecho|confirmo|confirmar|va|de una|vale|correcto|exacto|ese es)[!. ]*$/i;

/** Palabras que abortan el pendiente. */
const CANCELAR = /^(no|n|cancela|cancelar|olvidalo|dejalo|nada|error|mistake)[!. ]*$/i;

/** Saca los asteriscos del formato de WhatsApp, para no romper el resumen. */
function limpiar(texto) {
  return String(texto == null ? '' : texto)
    .replace(/[*_`~]/g, '')
    .trim()
    .slice(0, 160);
}

/**
 * Traduce un codigo de error de NexusOS al texto que ve el usuario.
 *
 * La regla acá es dura: si no se puede confirmar la operacion, se dice que NO se
 * pudo hacer. Nunca se informa exito sin respuesta del servidor.
 */
function mensajeDeError(code) {
  switch (code) {
    case nexus.CODIGOS.SIN_CONFIGURACION:
    case nexus.CODIGOS.NO_AUTORIZADO:
      return 'No pude conectar con el sistema de stock. Avisale al administrador.';
    case nexus.CODIGOS.RED:
      return 'No pude conectarme con el sistema de stock. No se cargo nada.';
    case nexus.CODIGOS.TIMEOUT:
      return 'El sistema de stock no respondio a tiempo. No se cargo nada.';
    case 'PRODUCTO_NO_ENCONTRADO':
      return 'No encontre ese producto en el catalogo.';
    case 'PRODUCTO_AMBIGUO':
      return 'Hay varios productos parecidos.';
    case 'CANTIDAD_INVALIDA':
      return 'La cantidad no es valida.';
    case 'STOCK_NEGATIVO':
      return 'No hay stock suficiente para esa salida.';
    case 'SUCURSAL_REQUERIDA':
      return 'Ese producto es de una sucursal. Decime cual.';
    default:
      return 'No pude aplicar el cambio en el stock.';
  }
}

/** Linea de resumen de un producto del catalogo. */
function lineaProducto(item) {
  const nombre = limpiar(item.nombre || item.producto || '?');
  const stock = Number(item.stock);
  const saldo = Number.isFinite(stock) ? stock : '?';
  return `• ${nombre} — stock: ${saldo}`;
}

/**
 * Arma el resumen de confirmacion a partir de un producto ya resuelto.
 * Se muestra producto, cantidad, modo y sucursal: todo lo que hace falta para
 * detectar un error de tipeo antes de que se escriba.
 */
function resumen(ajuste) {
  const partes = ['📦 *Confirmá la carga de stock*', ''];
  partes.push(`Producto: *${limpiar(ajuste.productoNombre || ajuste.producto)}*`);
  partes.push(`Cantidad: *${ajuste.cantidad}*`);
  partes.push(`Modo: ${ajuste.modo}`);
  if (ajuste.sucursal) partes.push(`Sucursal: ${ajuste.sucursal}`);
  partes.push('', 'Respondé *si* para aplicar o *no* para cancelar.');
  return partes.join('\n');
}

/**
 * Inicia (o reinicia) un pendiente para un chat.
 *
 * @param {string} chatId
 * @param {{producto: object, cantidad: number, modo: string, sucursal?: string}} datos
 */
function iniciar(chatId, datos) {
  const flujo = {
    chatId,
    producto: datos.producto,
    productoNombre: datos.producto.nombre || datos.producto.producto || '',
    productoId: String(datos.producto.id || datos.producto._id || ''),
    // Se guarda la clave aqui y no en el envio: si el reintento del POST usa
    // otra clave, NexusOS lo trata como una carga nueva.
    idempotencyKey: nexus.nuevoIdempotencyKey(),
    cantidad: Math.abs(Number(datos.cantidad)),
    modo: datos.modo || 'agregar',
    sucursal: datos.sucursal || '',
    ultimo: Date.now(),
  };
  flujos.set(chatId, flujo);
  return flujo;
}

/** Indica si hay un pendiente activo para ese chat. */
function estaActivo(chatId) {
  const f = flujos.get(chatId);
  if (!f) return false;
  if (Date.now() - f.ultimo > TIMEOUT_MS) {
    flujos.delete(chatId);
    return false;
  }
  return true;
}

/** Descarta el pendiente de un chat. */
function cancelar(chatId) {
  return flujos.delete(chatId);
}

/** Devuelve el pendiente activo o null. */
function obtener(chatId) {
  return flujos.get(chatId) || null;
}

/** Pide elegir entre candidatos, guardando la eleccion pendiente. */
function pedirEleccion(chatId, candidatos) {
  flujos.set(chatId, {
    chatId,
    esperandoEleccion: true,
    candidatos: candidatos.slice(0, 5),
    ultimo: Date.now(),
  });
  const opciones = candidatos
    .slice(0, 5)
    .map((c, i) => `${i + 1}. ${limpiar(c.nombre || c.producto)}`)
    .join('\n');
  return `🤔 Encontré varios productos parecidos:\n\n${opciones}\n\nRespondé con el *número* del que es.`;
}

/**
 * Resuelve el nombre que la persona escribe a la sucursal EXACTA que espera
 * NexusOS.
 *
 * No alcanza con comparar strings: nadie escribe "CAFETERIA CHICOLIN" con esa
 * falta de ortografia y esas mayusculas. Se comparan palabras clave sin
 * acentos ni mayusculas, y se devuelve el valor oficial de la lista.
 *
 * Devuelve '' si no reconoce ninguna: en ese caso hay que preguntar, nunca
 * adivinar ni mandar un valor inventado que NexusOS no reconoceria.
 *
 * @param {string} texto Lo que dijo el usuario.
 * @returns {string} El valor exacto, o '' si no lo reconoci.
 */
function resolverSucursal(texto) {
  const t = nexus.normalizarTexto(texto);
  if (!t) return '';

  for (const oficial of nexus.sucursales()) {
    const n = nexus.normalizarTexto(oficial);
    // El nombre exacto completo alcanza siempre.
    if (t.includes(n)) return oficial;

    // Palabras significativas del nombre oficial (>= 4 letras, para que "cafe"
    // no matchee "cafeteria" por accidente ni al reves).
    const palabras = n
      .split(/[^A-Z0-9]+/)
      .filter((p) => p.length >= 4);
    if (palabras.length > 0 && palabras.every((p) => t.includes(p))) return oficial;
  }

  // Alias explicitos para las sucursales conocidas. Se evaluan al final para no
  // pisar una coincidencia exacta mas fuerte.
  const ALIAS = [
    [/CHICOLIN|CAFETERIA/, 'CAFETERIA CHICOLIN'],
    [/SAN\s*BENITO/, 'San Benito Cafe Resto Bar'],
  ];
  for (const [re, oficial] of ALIAS) {
    if (re.test(t)) {
      // Solo se acepta si la sucursal esta realmente en la lista configurada:
      // si no esta, no se inventa el valor.
      const lista = nexus.sucursales();
      const coincide = lista.find(
        (s) => nexus.normalizarTexto(s) === nexus.normalizarTexto(oficial)
      );
      if (coincide) return coincide;
    }
  }
  return '';
}

/** Indica si una sucursal es una de las configuradas. */
function sucursalValida(valor) {
  const n = nexus.normalizarTexto(valor);
  if (!n) return false;
  return nexus.sucursales().some((s) => nexus.normalizarTexto(s) === n);
}

/** Pide elegir la sucursal antes de tocar el stock. */
function pedirSucursal(chatId, datos) {
  const lista = nexus.sucursales();
  flujos.set(chatId, {
    chatId,
    esperandoSucursal: true,
    sucursales: lista,
    pendiente: datos,
    ultimo: Date.now(),
  });
  const opciones = lista.map((s, i) => `${i + 1}. ${limpiar(s)}`).join('\n');
  return `🏪 ¿En qué sucursal?\n\n${opciones}\n\nRespondé con el *número*.`;
}

/** Saca el formato de WhatsApp de un numero de opcion ("2", "2.", "la 2"). */
function opcionElegida(texto, total) {
  const t = String(texto || '').trim();
  const m = t.match(/^(\d{1,2})[).]?$/);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= total ? n : null;
}

/**
 * Procesa la respuesta del usuario a un pendiente.
 *
 * @param {string} chatId
 * @param {string} body Texto que escribio el usuario.
 * @param {object} ctx
 * @returns {Promise<{reply: string, estado: string}>} `estado` describe que paso,
 *   para que el llamador lo deje registrado en la bitacora.
 */
async function procesar(chatId, body, ctx = {}) {
  const flujo = flujos.get(chatId);
  if (!flujo) return { reply: '', estado: 'sin-flujo' };

  const texto = String(body || '').trim();
  flujo.ultimo = Date.now();

  // --- El usuario estaba eligiendo sucursal ---
  if (flujo.esperandoSucursal) {
    if (CANCELAR.test(texto)) {
      flujos.delete(chatId);
      return { reply: 'Cancelado. No se cargo nada.', estado: 'cancelado' };
    }
    const n = opcionElegida(texto, flujo.sucursales.length);
    if (n === null) {
      // Tambien acepta el nombre escrito: "en chicolin" vale igual que "2".
      const directa = resolverSucursal(texto);
      if (!directa) {
        return {
          reply: 'No reconocí la sucursal. Respondé con el *número* de la lista, o *no* para cancelar.',
          estado: 'sucursal-invalida',
        };
      }
      return resolverProducto(chatId, { ...flujo.pendiente, sucursal: directa });
    }
    return resolverProducto(chatId, {
      ...flujo.pendiente,
      sucursal: flujo.sucursales[n - 1],
    });
  }

  // --- El usuario estaba eligiendo entre candidatos ---
  if (flujo.esperandoEleccion) {
    if (CANCELAR.test(texto)) {
      flujos.delete(chatId);
      return { reply: 'Cancelado. No se cargo nada.', estado: 'cancelado' };
    }
    const n = opcionElegida(texto, flujo.candidatos.length);
    if (n === null) {
      return {
        reply: 'Respondé con el número de la lista, o *no* para cancelar.',
        estado: 'eleccion-invalida',
      };
    }
    const elegido = flujo.candidatos[n - 1];
    // Se reemplaza el flujo de eleccion por el de confirmacion del elegido.
    const pendiente = iniciar(chatId, {
      producto: elegido,
      cantidad: flujo.candidatosCantidad || 0,
      modo: flujo.candidatosModo || 'agregar',
      sucursal: flujo.sucursal || '',
    });
    return { reply: resumen(pendiente), estado: 'confirmacion' };
  }

  // --- Confirmacion simple: cancelar ---
  if (CANCELAR.test(texto)) {
    flujos.delete(chatId);
    return { reply: 'Cancelado. No se cargo nada.', estado: 'cancelado' };
  }

  // --- Confirmacion simple: no es un si ---
  if (!CONFIRMAR.test(texto)) {
    return {
      reply: 'No entendí. Respondé *si* para aplicar la carga o *no* para cancelar.',
      estado: 'confirmacion-invalida',
    };
  }

  // --- Confirmado: recien ahora se escribe ---
  // Se valida contra la lista antes de salir a la red: mandar un valor que
  // NexusOS no reconoce romperia el movimiento entero.
  const sucursal = flujo.sucursal || '';
  if (!sucursal || !sucursalValida(sucursal)) {
    flujos.delete(chatId);
    return { reply: mensajeDeError('SUCURSAL_REQUERIDA'), estado: 'sucursal-invalida' };
  }
  try {
    const data = await nexus.ajustarStock(
      {
        producto: flujo.productoNombre,
        cantidad: flujo.cantidad,
        modo: flujo.modo,
      },
      { sucursal, idempotencyKey: flujo.idempotencyKey }
    );

    flujos.delete(chatId);

    // Si NexusOS dice que ya lo aplico (mismo Idempotency-Key), no se vuelve a
    // escribir ni a informar como carga nueva.
    if (data && data.replayed === true) {
      return {
        reply: 'ℹ️ Ese ingreso ya estaba cargado. No lo sumé de nuevo.',
        estado: 'replay',
      };
    }

    const r = data && Array.isArray(data.resultados) ? data.resultados[0] : null;
    if (!r) {
      return {
        reply: '⚠️ NexusOS respondió sin detalle. Revisá el inventario.',
        estado: 'respuesta-vacia',
      };
    }
    return {
      reply: [
        '✅ *Stock actualizado*',
        '',
        `*${limpiar(r.nombre || flujo.productoNombre)}*`,
        `Cantidad: ${r.cantidad}`,
        `Antes: ${r.stockAnterior} → Ahora: ${r.stockResultante}`,
      ].join('\n'),
      estado: 'aplicado',
    };
  } catch (err) {
    // El pendiente se descarta: ante un error de red no se reintenta solo, para
    // no arriesgar una carga duplicada. El usuario vuelve a pedirla si quiere.
    flujos.delete(chatId);
    const code = err && err.code ? err.code : '';
    return { reply: mensajeDeError(code), estado: 'error' };
  }
}

/**
 * Punto de entrada desde la IA: busca el producto, resuelve la ambiguedad y
 * deja el pendiente listo para confirmar.
 *
 * @param {string} chatId
 * @param {{producto: string, cantidad: number, modo?: string, sucursal?: string}} data
 * @returns {Promise<{reply: string, estado: string}>}
 */
async function preparar(chatId, data) {
  const cantidad = Math.abs(Number(data && data.cantidad));
  if (!Number.isFinite(cantidad) || cantidad === 0) {
    return { reply: mensajeDeError('CANTIDAD_INVALIDA'), estado: 'error' };
  }
  const texto = String((data && data.producto) || '').trim();
  if (!texto) {
    return { reply: 'No me dijiste qué producto cargar.', estado: 'error' };
  }

  // La sucursal puede venir del mensaje ("en San Benito") o de la lista de
  // variables. Si no viene ninguna y hay MAS DE UNA configurada, se pregunta:
  // cargar en la sucursal equivocada no se nota hasta el conteo.
  const listaSucursales = nexus.sucursales();
  // Se resuelve SIEMPRE contra la lista configurada, aunque la IA haya dicho
  // una: manda el valor oficial, no el que interpreto el modelo. Y se busca en
  // todo el mensaje, asi "en chicolin" funciona aunque la IA dejo la sucursal
  // en null.
  const sucursal = resolverSucursal(`${(data && data.sucursal) || ''} ${texto}`);

  if (!sucursal && listaSucursales.length > 0) {
    return {
      reply: pedirSucursal(chatId, {
        producto: texto,
        cantidad,
        modo: (data && data.modo) || 'agregar',
      }),
      estado: 'eligiendo-sucursal',
    };
  }

  return resolverProducto(chatId, { producto: texto, cantidad, modo: data && data.modo, sucursal });
}

/**
 * Busca el producto en el catalogo y deja el pendiente listo para confirmar.
 * Se separa de `preparar` porque tambien se vuelve a llamar cuando el usuario
 * ya eligio la sucursal.
 */
async function resolverProducto(chatId, datos) {
  const texto = String(datos.producto || '').trim();
  const cantidad = Math.abs(Number(datos.cantidad));
  const modo = datos.modo || 'agregar';
  const sucursal = datos.sucursal || '';

  let items;
  try {
    items = await nexus.consultarStock(texto, { sucursal });
  } catch (err) {
    return { reply: mensajeDeError(err && err.code), estado: 'error' };
  }

  const eleccion = nexus.elegirProducto(items);

  if (!eleccion.ok && eleccion.motivo === 'NO_ENCONTRADO') {
    return {
      reply: 'No encontré ese producto. ¿Podés escribir el nombre exacto?',
      estado: 'no-encontrado',
    };
  }

  if (!eleccion.ok) {
    flujos.set(chatId, {
      chatId,
      esperandoEleccion: true,
      candidatos: eleccion.candidatos,
      candidatosCantidad: cantidad,
      candidatosModo: modo,
      sucursal,
      ultimo: Date.now(),
    });
    return { reply: pedirEleccion(chatId, eleccion.candidatos), estado: 'eligiendo' };
  }

  const pendiente = iniciar(chatId, {
    producto: eleccion.item,
    cantidad,
    modo,
    sucursal,
  });
  return { reply: resumen(pendiente), estado: 'confirmacion' };
}

module.exports = {
  iniciar,
  estaActivo,
  cancelar,
  obtener,
  procesar,
  preparar,
  resolverProducto,
  resumen,
  resolverSucursal,
  sucursalValida,
  mensajeDeError,
  CONFIRMAR,
  CANCELAR,
  TIMEOUT_MS,
};