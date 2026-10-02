'use strict';
// OrbitaOs - pruebas de la politica de reintentos contra la IA.
//
// El fallo real en produccion era un "Upstream error: Provider returned an
// empty response" con status 400, que parece definitivo pero es transitorio.
// Estas pruebas comprueban la politica (puro) y que route() la cumpla de
// verdad, simulando la respuesta del proveedor.

const assert = require('assert');
const retry = require('../src/ai_retry');

let passed = 0;

// Se guarda la consola real: las pruebas apagan console.error para tapar el
// ruido del camino de fallo, y un FAIL tapado seria el peor fallo posible.
const report = console.error;

// Las comprobaciones se encolan y se corren de UNA en una. Correrlas en
// paralelo rompe: cada caso simula el proveedor pisando globalThis.fetch, y
// al solaparse un caso usaria la respuesta del otro.
const cola = [];

async function correr({ name, fn, antes }) {
  try {
    // El estado se prepara aqui y no al encolar: encolar solo apila, y las
    // comprobaciones asincronas se ejecutan todas juntas al final. Si se
    // preparara al encolar, el circuito quedaria reiniciado siete veces antes
    // de que corra ninguna y los casos se contaminarian entre si.
    if (antes) antes();
    // Se espera el resultado: una comprobacion asincrona que no se espera
    // marcaria "ok" aunque fallara.
    await Promise.resolve(fn());
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    report(`  FAIL ${name}: ${err.message}`);
    process.exitCode = 1;
  }
}

function check(name, fn, opciones = {}) {
  cola.push({ name, fn, antes: opciones.antes });
}

/** Ejecuta la cola en orden. */
async function correrTodo() {
  for (const caso of cola) {
    await correr(caso); // en serie a proposito: ver la nota de arriba
  }
}

const VAZIO =
  '{"error":{"message":"Upstream error: Provider returned an empty response",' +
  '"type":"invalid_request_error","code":null}}';

console.log('\nQue merece reintento');

check('un 400 normal NO se reintenta (el pedido esta mal)', () => {
  assert.strictEqual(
    retry.esReintentable(400, '{"error":{"message":"model not found"}}'),
    false
  );
});

check('el 400 de upstream vacio SI se reintenta', () => {
  // Este es el caso que fallo en produccion.
  assert.strictEqual(retry.esReintentable(400, VAZIO), true);
  assert.strictEqual(retry.esUpstreamVacio(VAZIO), true);
});

check('una clave invalida NO se reintenta', () => {
  // Reintentar un 401 solo gasta tiempo y se acerca al limite de peticiones.
  assert.strictEqual(retry.esReintentable(401, '{"error":"unauthorized"}'), false);
  assert.strictEqual(retry.esReintentable(403, '{}'), false);
});

check('un 429 o un 503 SI se reintenta', () => {
  assert.strictEqual(retry.esReintentable(429, '{}'), true);
  assert.strictEqual(retry.esReintentable(503, '{}'), true);
  assert.strictEqual(retry.esReintentable(500, '{}'), true);
  assert.strictEqual(retry.esReintentable(502, '{}'), true);
  assert.strictEqual(retry.esReintentable(504, '{}'), true);
});

check('un fallo de red SI se reintenta', () => {
  assert.strictEqual(retry.esReintentable(null, null), true);
  assert.strictEqual(retry.esReintentable(undefined, undefined), true);
});

check('cualquier otro 5xx se reintenta', () => {
  assert.strictEqual(retry.esReintentable(507, '{}'), true);
  assert.strictEqual(retry.esReintentable(599, '{}'), true);
});

console.log('\nLa espera entre intentos');

check('la espera crece y tiene tope', () => {
  process.env.AI_RETRY_BASE_MS = '1000';
  process.env.AI_RETRY_MAX_MS = '4000';
  try {
    assert.strictEqual(retry.espera(0), 1000);
    assert.strictEqual(retry.espera(1), 2000);
    assert.strictEqual(retry.espera(2), 4000);
    // Del tope no se pasa: golpear mas fuerte no ayuda.
    assert.strictEqual(retry.espera(5), 4000);
  } finally {
    delete process.env.AI_RETRY_BASE_MS;
    delete process.env.AI_RETRY_MAX_MS;
  }
});

check('los intentos se pueden configurar y se acotan', () => {
  process.env.AI_RETRY_INTENTOS = '5';
  try {
    assert.strictEqual(retry.intentosTotales(), 5);
    process.env.AI_RETRY_INTENTOS = '99';
    // Un numero absurdo de intentos seria una tormenta contra el proveedor.
    assert.strictEqual(retry.intentosTotales(), 6);
    process.env.AI_RETRY_INTENTOS = 'basura';
    assert.strictEqual(retry.intentosTotales(), 3, 'valores raros van al valor seguro');
  } finally {
    delete process.env.AI_RETRY_INTENTOS;
  }
});
console.log('\nLa politica se cumple de verdad en route()');

/** Simula la API: devuelve las respuestas pedidas, una por llamada. */
function simularApi(respuestas) {
  const original = globalThis.fetch;
  let i = 0;
  let llamadas = 0;
  globalThis.fetch = async () => {
    const r = respuestas[Math.min(i, respuestas.length - 1)];
    i += 1;
    llamadas += 1;
    return {
      ok: r.status < 400,
      status: r.status,
      text: async () => r.cuerpo,
      json: async () => JSON.parse(r.cuerpo),
    };
  };
  return { restaurar: () => { globalThis.fetch = original; }, llamadas: () => llamadas };
}

const OK = JSON.stringify({
  choices: [{ message: { content: '{"intent":"chat","response_text":"hola","data":{}}' } }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
});

(async () => {
  process.env.SPACE_BUNNY_API_KEY = 'sb_test';
  process.env.AI_RETRY_INTENTOS = '3';
  process.env.AI_RETRY_BASE_MS = '1';
  process.env.AI_RETRY_MAX_MS = '2';
  delete process.env.SPACE_BUNNY_DAILY_CAP;

  const ai = require('../src/ai_router');
  const errorReal = console.error;
  const warnReal = console.warn;
  console.error = () => {}; // el ruido del camino de fallo no interesa aca
  console.warn = () => {};

  // Cada caso arranca con el circuito cerrado: si no, los fallos acumulados
  // del caso anterior harian que este se comportara distinto por su cuenta.
  const CIRCUITO_CERO = { antes: () => ai.reiniciarCircuito() };

  // El fallo real: un vacio de upstream que en el segundo intento responde.
  check('un fallo vacio de upstream se reintenta y sale bien', async () => {
    const api = simularApi([
      { status: 400, cuerpo: VAZIO },
      { status: 200, cuerpo: OK },
    ]);
    try {
      const r = await ai.route('hola', { history: [] });
      assert.strictEqual(api.llamadas(), 2, 'debe haber reintentado una vez');
      assert.ok(!r.fallback_reason, 'no debe caer a mock');
      assert.strictEqual(r.response_text, 'hola');
    } finally {
      api.restaurar();
    }
  }, CIRCUITO_CERO);

  check('sin reintento el mismo caso caia a mock', async () => {
    // El contraste: con un solo intento se perdia la respuesta real.
    process.env.AI_RETRY_INTENTOS = '1';
    const api = simularApi([{ status: 400, cuerpo: VAZIO }]);
    try {
      const r = await ai.route('hola', { history: [] });
      assert.strictEqual(api.llamadas(), 1, 'un solo intento');
      assert.ok(r.fallback_reason, 'debe caer a mock y avisar por que');
    } finally {
      api.restaurar();
      process.env.AI_RETRY_INTENTOS = '3';
    }
  }, CIRCUITO_CERO);

  check('una clave invalida NO se reintenta', async () => {
    const api = simularApi([{ status: 401, cuerpo: '{"error":"unauthorized"}' }]);
    try {
      const r = await ai.route('hola', { history: [] });
      assert.strictEqual(api.llamadas(), 1, 'no debe insistir con un 401');
      assert.ok(/401/.test(r.fallback_reason), 'el motivo debe estar');
    } finally {
      api.restaurar();
    }
  }, CIRCUITO_CERO);

  check('un 429 se reintenta hasta agotar intentos', async () => {
    const api = simularApi([{ status: 429, cuerpo: '{"error":"rate"}' }]);
    try {
      const r = await ai.route('hola', { history: [] });
      assert.strictEqual(api.llamadas(), 3, 'debe intentar las 3 veces');
      assert.ok(r.fallback_reason, 'agotados los intentos cae a mock');
    } finally {
      api.restaurar();
    }
  }, CIRCUITO_CERO);

  check('las metricas cuentan los reintentos', async () => {
    const antes = ai.getUsage();
    const api = simularApi([
      { status: 500, cuerpo: '{"error":"boom"}' },
      { status: 200, cuerpo: OK },
    ]);
    try {
      await ai.route('hola', { history: [] });
    } finally {
      api.restaurar();
    }
    const despues = ai.getUsage();
    assert.ok(despues.reintentos > antes.reintentos, 'debe contar el reintento');
    assert.strictEqual(typeof despues.omitidas, 'number', 'debe exponer omitidas');
  }, CIRCUITO_CERO);

  check('el circuito corta cuando el proveedor esta caido', async () => {
    // Con el proveedor abajo, cada mensaje hacia 3 intentos con esperas: el
    // usuario recibia la respuesta mock varios segundos tarde. Tras varios
    // fallos seguidos se omite la llamada.
    process.env.AI_CIRCUITO_FALLOS = '2';
    process.env.AI_CIRCUITO_MS = '60000';
    const respuestas = [{ status: 503, cuerpo: '{"error":"caido"}' }];
    try {
      const api = simularApi(respuestas);
      try {
        // Umbral 2: el intento 1 falla (fallo 1) y el intento 2 falla (fallo 2), que
        // abre el circuito. El intento 3 ya no sale. Con el circuito abierto
        // solo pasaria una sonda por ventana, asi que la mayoria de las
        // llamadas ni se hacen: eso es justo lo que se quiere evitar.
        await ai.route('hola', { history: [] });
        const trasElPrimero = api.llamadas();
        assert.strictEqual(trasElPrimero, 2, 'corta al abrirse, no agota intentos');

        await ai.route('hola', { history: [] }); // una sonda
        await ai.route('hola', { history: [] }); // ya gastada: ni una llamada
        assert.strictEqual(
          api.llamadas(),
          trasElPrimero + 1,
          'con el circuito abierto solo pasa una sonda por ventana'
        );
        assert.ok(ai.getUsage().omitidas > 0, 'debe contar las omitidas');
      } finally {
        api.restaurar();
      }
    } finally {
      delete process.env.AI_CIRCUITO_FALLOS;
      delete process.env.AI_CIRCUITO_MS;
      ai.reiniciarCircuito();
    }
  }, CIRCUITO_CERO);

  // Tras abrirse, una sola llamada de sonda debe recuperar el servicio: si
// no, el proveedor podria haberse recuperado y todos seguirian viendo mock
// durante el resto de la ventana.
  check('una sonda detecta que el proveedor se recupero', async () => {
    process.env.AI_CIRCUITO_FALLOS = '2';
    process.env.AI_CIRCUITO_MS = '60000';
    try {
      const caido = simularApi([{ status: 503, cuerpo: '{"error":"caido"}' }]);
      await ai.route('hola', { history: [] }); // abre el circuito
      caido.restaurar();

      // La ventana sigue vigente, pero el proveedor ya responde: la sonda lo ve.
      const sano = simularApi([{ status: 200, cuerpo: OK }]);
      try {
        const r = await ai.route('hola', { history: [] });
        assert.ok(!r.fallback_reason, 'la sonda debe recuperar la respuesta real');
        assert.ok(sano.llamadas() > 0, 'debe haber consultado al proveedor');
        assert.strictEqual(r.response_text, 'hola');
      } finally {
        sano.restaurar();
      }
    } finally {
      delete process.env.AI_CIRCUITO_FALLOS;
      delete process.env.AI_CIRCUITO_MS;
      ai.reiniciarCircuito();
    }
  }, CIRCUITO_CERO);

  // Tras una ventana sin fallos se vuelve a llamar con normalidad: si no, el
  // corte seria definitivo aunque el proveedor este sano.
  check('expirada la ventana se vuelve a llamar', async () => {
    process.env.AI_CIRCUITO_FALLOS = '2';
    process.env.AI_CIRCUITO_MS = '1'; // ventana de 1 ms: ya expira
    try {
      const caido = simularApi([{ status: 503, cuerpo: '{"error":"caido"}' }]);
      await ai.route('hola', { history: [] });
      caido.restaurar();
      await new Promise((r) => setTimeout(r, 5));

      const sano = simularApi([{ status: 200, cuerpo: OK }]);
      try {
        const r = await ai.route('hola', { history: [] });
        assert.ok(!r.fallback_reason, 'pasada la ventana debe volver a funcionar');
        assert.ok(sano.llamadas() > 0, 'debe haber consultado al proveedor');
      } finally {
        sano.restaurar();
      }
    } finally {
      delete process.env.AI_CIRCUITO_FALLOS;
      delete process.env.AI_CIRCUITO_MS;
      ai.reiniciarCircuito();
    }
  }, CIRCUITO_CERO);

  // Las llamadas pasan por correrTodo(): el registro solo encola.
  await correrTodo();
  console.error = errorReal;
  console.warn = warnReal;
  console.log(`\n${passed} comprobaciones OK\n`);
  if (process.exitCode) {
    console.error('FALLARON comprobaciones\n');
  }
})();
