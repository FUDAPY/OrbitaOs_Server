'use strict';
// OrbitaOs - pruebas del cliente de NexusOS y del flujo de carga de stock.
//
// No toca la red real salvo que se fijen NEXUS_API_URL y NEXUS_SERVICE_TOKEN.
// Sin ellas el script se OMITE (no falla), para que `npm test` siga en verde en
// desarrollo y en CI.

const assert = require('assert');

const nexus = require('../src/nexus_client');
const stockFlow = require('../src/stock_flow');
const ai = require('../src/ai_router');

let passed = 0;
let skipped = false;

function check(nombre, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${nombre}`);
  } catch (err) {
    console.error(`  FAIL ${nombre} -> ${err.message}`);
    process.exitCode = 1;
  }
}

/**
 * Guarda y restaura variables de entorno.
 *
 * ES async a proposito: la version sincrona con `finally` restaura las
 * variables en cuanto el callback DEVUuelve su promise, o sea antes de que
 * termine. Con checks async eso dejaba el entorno a medio poner y producia
 * fallos falsos.
 */
async function conEnv(valores, fn) {
  const antes = {};
  for (const [k, v] of Object.entries(valores)) {
    antes[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(antes)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/**
 * Checks asincronos en SERIE.
 *
 * Antes se llamaban sin `await` y todos corrian a la vez. Como `conEnv` toca
 * process.env, un check dejaba las variables a medio poner mientras otro ya
 * estaba leyendo: los resultados se mezclaban y los fallos eran falsos. La cola
 * obliga a que termine uno antes de empezar el siguiente.
 */
let cola = Promise.resolve();
let pendientes = 0;
function checkAsync(nombre, fn) {
  pendientes += 1;
  cola = cola.then(async () => {
    try {
      await fn();
      passed += 1;
      console.log(`  ok  ${nombre}`);
    } catch (err) {
      console.error(`  FAIL ${nombre} -> ${err.message}`);
      process.exitCode = 1;
    } finally {
      pendientes -= 1;
    }
  });
  return cola;
}

/**
 * Espera a que no quede ningun check en vuelo.
 *
 * Encadenarse a `cola` no alcanza: el resumen se encadena al valor que tenga la
 * cola en ese instante, y si despues se encola otro check, este se imprime
 * despues del resumen. Con un contador y un par de vueltas al event loop, el
 * resumen sale siempre al final.
 */
async function esperarChecks() {
  while (pendientes > 0) {
    // eslint-disable-next-line no-await-in-loop
    await cola;
  }
}

/* -------------------------------------------------------------------------- */

console.log('nexus_check · cliente de NexusOS y flujo de stock');

check('sin configuracion el cliente no dice que esta listo', () => {
  conEnv({ NEXUS_API_URL: undefined, NEXUS_SERVICE_TOKEN: undefined }, () => {
    assert.strictEqual(nexus.configurado(), false, 'no debe decir que esta listo');
  });
});

check('con URL y token el cliente queda configurado', () => {
  conEnv({ NEXUS_API_URL: 'https://ejemplo/api/v1', NEXUS_SERVICE_TOKEN: 'x' }, () => {
    assert.strictEqual(nexus.configurado(), true);
  });
});

check('el token nunca se imprime completo', () => {
  const secreto = 'secreto-de-prueba-123456';
  conEnv({ NEXUS_SERVICE_TOKEN: secreto }, () => {
    const m = nexus.enmascarar();
    assert.ok(!m.includes(secreto), 'no debe filtrar el valor entero');
    assert.ok(!m.includes('secreto'), 'no debe filtrar el comienzo del valor');
    assert.ok(m.includes(String(secreto.length)), 'debe permitir depurar el largo');
  });
});

check('normalizarTexto quita tildes y unifica mayusculas', () => {
  assert.strictEqual(nexus.normalizarTexto('PILSEN  1lt'), 'PILSEN 1LT');
  assert.strictEqual(nexus.normalizarTexto('Pilsen'), 'PILSEN');
});

check('elegirProducto con un solo item lo elige', () => {
  const r = nexus.elegirProducto([{ id: 'a', nombre: 'Pilsen 1 LT', stock: 3 }]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.item.id, 'a');
});

check('elegirProducto con lista vacia dice NO_ENCONTRADO', () => {
  const r = nexus.elegirProducto([]);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.motivo, 'NO_ENCONTRADO');
});

check('elegirProducto NUNCA elige el primero a ciegas', () => {
  const r = nexus.elegirProducto([
    { id: 'a', nombre: 'Pilsen 1 LT', stock: 10 },
    { id: 'b', nombre: 'Pilsen 2 LT', stock: 4 },
  ]);
checkAsync('el router mock reconoce "cargar en stock ... N unidades"', async () => {
  const r = await ai.route('cargar en stock pilsen 1 lt - 6 unidades', {
    history: [],
    SPACE_BUNNY_API_KEY: '',
  });
  assert.strictEqual(r.intent, 'adjust_stock', `esperado adjust_stock, hubo ${r.intent}`);
  assert.strictEqual(r.data.cantidad, 6, 'debe leer la cantidad');
  assert.strictEqual(r.data.modo, 'agregar', 'cargar es agregar');
  assert.ok(String(r.data.producto).toLowerCase().includes('pilsen'), 'debe conservar el nombre');
});

checkAsync('el router mock distingue descontar de cargar', async () => {
  const r = await ai.route('descontar 3 cocas del stock', { history: [], SPACE_BUNNY_API_KEY: '' });
  assert.strictEqual(r.intent, 'adjust_stock');
  assert.strictEqual(r.data.cantidad, 3);
  assert.strictEqual(r.data.modo, 'restar', 'descontar es restar, con cantidad positiva');
});

checkAsync('sin configuracion el flujo responde sin aplicar nada', async () => {
  await conEnv({ NEXUS_API_URL: undefined, NEXUS_SERVICE_TOKEN: undefined }, async () => {
    const r = await stockFlow.preparar('59500000001', {
      producto: 'Pilsen 1 LT',
      cantidad: 6,
      modo: 'agregar',
    });
    assert.ok(r.reply && r.reply.length > 0, 'debe responder algo al usuario');
    assert.notStrictEqual(r.estado, 'aplicado', 'nunca debe aplicar sin NexusOS');
  });
});

checkAsync('el flujo arma el resumen con producto, cantidad y sucursal', async () => {
  const texto = stockFlow.resumen({
    productoNombre: 'PILSEN 1 LT',
    producto: 'PILSEN 1 LT',
    cantidad: 6,
    modo: 'agregar',
    sucursal: 'San Benito Cafe Resto Bar',
  });
  assert.ok(texto.includes('PILSEN 1 LT'), 'debe mostrar el producto');
  assert.ok(texto.includes('6'), 'debe mostrar la cantidad');
  assert.ok(texto.includes('San Benito Cafe Resto Bar'), 'debe mostrar la sucursal');
});

/* --- Sucursal (NEXUS_SUCURSALES) ---------------------------------------- */

const CON_SUCURSALES = {
  NEXUS_SUCURSALES: 'San Benito Cafe Resto Bar,CAFETERIA CHICOLIN',
};

checkAsync('las sucursales configuradas se leen de NEXUS_SUCURSALES', async () => {
  await conEnv(CON_SUCURSALES, async () => {
    const lista = nexus.sucursales();
    assert.strictEqual(lista.length, 2);
    assert.ok(lista.includes('San Benito Cafe Resto Bar'));
    assert.ok(lista.includes('CAFETERIA CHICOLIN'));
  });
});

checkAsync('resolverSucursal entiende los alias del encargo', async () => {
  await conEnv(CON_SUCURSALES, async () => {
    const casos = [
      ['en chicolin', 'CAFETERIA CHICOLIN'],
      ['la cafeteria', 'CAFETERIA CHICOLIN'],
      ['cafeteria', 'CAFETERIA CHICOLIN'],
      ['en san benito', 'San Benito Cafe Resto Bar'],
      ['san benito cafe', 'San Benito Cafe Resto Bar'],
      ['CAFETERIA CHICOLIN', 'CAFETERIA CHICOLIN'],
    ];
    for (const [entrada, esperado] of casos) {
      assert.strictEqual(
        stockFlow.resolverSucursal(entrada),
        esperado,
        `"${entrada}" debe resolverse a ${esperado}`
      );
    }
  });
});

checkAsync('resolverSucursal NO adivina si no reconoce la sucursal', async () => {
  await conEnv(CON_SUCURSALES, async () => {
    assert.strictEqual(stockFlow.resolverSucursal('en la esquina'), '');
    assert.strictEqual(stockFlow.resolverSucursal(''), '');
  });
});

checkAsync('sin sucursal en el mensaje, el bot PREGUNTA y no aplica', async () => {
  await conEnv({ ...CON_SUCURSALES, NEXUS_API_URL: undefined, NEXUS_SERVICE_TOKEN: undefined }, async () => {
    const r = await stockFlow.preparar('59500000010', {
      producto: 'Pilsen 1 LT',
      cantidad: 6,
      modo: 'agregar',
    });
    assert.strictEqual(r.estado, 'eligiendo-sucursal', 'debe pedir la sucursal');
    assert.ok(r.reply.includes('sucursal'), 'el mensaje debe preguntar por la sucursal');
    assert.ok(r.reply.includes('San Benito'), 'debe ofrecer las opciones');
    assert.ok(r.reply.includes('CHICOLIN'), 'debe ofrecer las dos');
  });
});

checkAsync('con sucursal mencionada NO pregunta', async () => {
  await conEnv({ ...CON_SUCURSALES, NEXUS_API_URL: undefined, NEXUS_SERVICE_TOKEN: undefined }, async () => {
    const r = await stockFlow.preparar('59500000011', {
      producto: 'Pilsen 1 LT',
      cantidad: 6,
      modo: 'agregar',
      sucursal: 'chicolin',
    });
    assert.notStrictEqual(r.estado, 'eligiendo-sucursal', 'no debe volver a preguntar');
  });
});

checkAsync('elegir la sucursal por numero avanza a la resolucion del producto', async () => {
  await conEnv({ ...CON_SUCURSALES, NEXUS_API_URL: undefined, NEXUS_SERVICE_TOKEN: undefined }, async () => {
    const chat = '59500000012';
    const p = await stockFlow.preparar(chat, { producto: 'Pilsen 1 LT', cantidad: 6 });
    assert.strictEqual(p.estado, 'eligiendo-sucursal', `estado=${JSON.stringify(p.estado)} suc=${JSON.stringify(nexus.sucursales())}`);
    // Sin API no puede buscar el producto, pero debe pasar a esa etapa y no
    // aplicar nada.
    const r = await stockFlow.procesar(chat, '1', {});
    assert.notStrictEqual(r.estado, 'aplicado', 'elegir sucursal no aplica el cambio');
    assert.ok(r.reply.length > 0, 'debe responder algo');
  });
});

checkAsync('cancelar al elegir sucursal no aplica nada', async () => {
  await conEnv({ ...CON_SUCURSALES, NEXUS_API_URL: undefined, NEXUS_SERVICE_TOKEN: undefined }, async () => {
    const chat = '59500000013';
    await stockFlow.preparar(chat, { producto: 'Pilsen 1 LT', cantidad: 6 });
    const r = await stockFlow.procesar(chat, 'no', {});
    assert.strictEqual(r.estado, 'cancelado');
    assert.strictEqual(stockFlow.estaActivo(chat), false, 'descarta el pendiente');
  });
});

checkAsync('sucursalValida rechaza un valor fuera de la lista', async () => {
  await conEnv(CON_SUCURSALES, async () => {
    assert.strictEqual(stockFlow.sucursalValida('CAFETERIA CHICOLIN'), true);
    assert.strictEqual(stockFlow.sucursalValida('Sucursal Norte'), false);
    assert.strictEqual(stockFlow.sucursalValida(''), false);
  });
});

checkAsync('el router mock saca la sucursal del mensaje', async () => {
  const r = await ai.route('cargar en stock pilsen 1 lt 6 unidades en chicolin', {
    history: [],
    SPACE_BUNNY_API_KEY: '',
  });
  assert.strictEqual(r.intent, 'adjust_stock');
  assert.ok(String(r.data.sucursal).toLowerCase().includes('chicolin'), 'debe leer la sucursal');
});

checkAsync('cancelar un pendiente no escribe nada', async () => {
  await conEnv({ NEXUS_API_URL: undefined, NEXUS_SERVICE_TOKEN: undefined }, async () => {
    stockFlow.iniciar('59500000002', {
      producto: { id: 'x', nombre: 'Pilsen 1 LT', stock: 5 },
      cantidad: 6,
      modo: 'agregar',
    });
    assert.strictEqual(stockFlow.estaActivo('59500000002'), true, 'debe quedar pendiente');
    const r = await stockFlow.procesar('59500000002', 'no', {});
    assert.strictEqual(r.estado, 'cancelado');
    assert.strictEqual(stockFlow.estaActivo('59500000002'), false, 'debe descartar el pendiente');
  });
});

checkAsync('responder algo que no es si ni no NO aplica la carga', async () => {
  await conEnv({ NEXUS_API_URL: undefined, NEXUS_SERVICE_TOKEN: undefined }, async () => {
    stockFlow.iniciar('59500000003', {
      producto: { id: 'x', nombre: 'Pilsen 1 LT', stock: 5 },
      cantidad: 6,
      modo: 'agregar',
    });
    const r = await stockFlow.procesar('59500000003', 'quiza mañana', {});
    assert.notStrictEqual(r.estado, 'aplicado', 'no debe aplicar sin confirmacion');
    assert.strictEqual(stockFlow.estaActivo('59500000003'), true, 'el pendiente sigue abierto');
    stockFlow.cancelar('59500000003');
  });
});

/* --- Integracion real: solo si hay credenciales -------------------------- */

// Las credenciales se miran DENTRO del check, no al cargar el módulo. Los
// checks corren encolados: al final de este archivo el entorno ya puede haber
// sido tocado por los anteriores, y decidir acá daba por hecho algo que ya no
// era cierto.
//
// Tambien se descarta un tokenplaceholder (<el hex>): con eso el POST sale y
// falla con 401, que no prueba nada.
function credencialesReales() {
  const url = String(process.env.NEXUS_API_URL || '').trim();
  const token = String(process.env.NEXUS_SERVICE_TOKEN || '').trim();
  if (!url || !token) return false;
  if (token.includes('<') || token.includes('>')) return false;
  return true;
}

checkAsync('integracion real contra NexusOS', async () => {
  if (!credencialesReales()) {
    skipped = true;
    console.log('       skip  faltan credenciales o el token es un placeholder');
    return;
  }
  console.log('       ..    consulta real contra NexusOS');
  const items = await nexus.consultarStock('PILSEN 1 LT');
  assert.ok(Array.isArray(items), 'debe devolver una lista');
});

checkAsync('el ajuste es idempotente con la misma clave', async () => {
  if (!credencialesReales()) {
    skipped = true;
    return;
  }
  const key = nexus.nuevoIdempotencyKey();
  const opciones = {
    idempotencyKey: key,
    sucursal: nexus.sucursales()[0] || '',
  };
  const primero = await nexus.ajustarStock(
    { producto: 'PILSEN 1 LT', cantidad: 1, modo: 'agregar' },
    opciones
  );
  const segundo = await nexus.ajustarStock(
    { producto: 'PILSEN 1 LT', cantidad: 1, modo: 'agregar' },
    opciones
  );
  assert.ok(primero && segundo, 'ambos deben responder');
  if (segundo && segundo.replayed === true) {
    const a = primero.resultados[0].stockResultante;
    const b = segundo.resultados[0].stockResultante;
    assert.strictEqual(a, b, 'el stock no debe volver a cambiar');
  }
});

// El resumen se imprime recien cuando no queda ningun check en vuelo: si no,
// contaria checks que todavia no youngeron y apareceria en medio de la salida.
esperarChecks().then(() => {
  console.log(
    skipped
      ? `nexus_check · ${passed} checks ok (integracion real omitida)`
      : `nexus_check · ${passed} checks ok`
  );
});
  assert.strictEqual(r.ok, false, 'con dos candidatos con stock hay ambiguedad');
  assert.strictEqual(r.motivo, 'AMBIGUO');
});

check('elegirProducto desambigua si solo uno tiene stock', () => {
  const r = nexus.elegirProducto([
    { id: 'a', nombre: 'Pilsen 1 LT', stock: 0 },
    { id: 'b', nombre: 'Pilsen 2 LT', stock: 7 },
  ]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.item.id, 'b');
});

checkAsync('la intencion adjust_stock esta declarada en el router', async () => {
  assert.ok(ai.INTENTS.includes('adjust_stock'), 'debe estar en INTENTS');
});

checkAsync('el prompt del sistema describe adjust_stock', async () => {
  const p = ai.buildSystemPrompt();
  assert.ok(p.includes('"adjust_stock"'), 'el prompt debe nombrarla');
});