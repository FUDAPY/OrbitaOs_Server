'use strict';
// OrbitaOs - pruebas del layout del panel.
//
// El menu paso de ser una barra superior a una lateral fija. Estos checks
// evitan que un cambio futuro vuelva a tapar el contenido, deje el menu
// inutil en el celular o rompa la navegacion.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const raiz = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(raiz, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(raiz, 'app.css'), 'utf8');
const js = fs.readFileSync(path.join(raiz, 'app.js'), 'utf8');

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

console.log('\nEstructura del panel');

check('el menu es una lateral fija', () => {
  assert.ok(html.includes('<aside class="lateral"'), 'debe existir el aside');
  assert.ok(html.includes('id="lateral"'), 'debe tener id para controlarlo');
  assert.ok(css.includes('position: fixed'), 'debe ser fijo');
  assert.ok(css.includes('bottom: 0'), 'debe ocupar toda la altura');
});

check('no queda la barra superior', () => {
  assert.ok(!html.includes('class="barra"'), 'no debe quedar en el HTML');
  // Ojo: .grafico .barra es la barra del grafico y no tiene que eliminarse.
  assert.ok(!/\n\.barra \{/.test(css), 'no debe quedar su CSS');
});

check('el contenido no queda detras de la lateral', () => {
  // Este es el error clasico de un sidebar: el contenido arranca en 0 y el
  // menu lo tapa. El margen tiene que igualar el ancho de la lateral.
  assert.ok(css.includes('--lateral-ancho'), 'el ancho debe ser una variable');
  assert.ok(
    /\.contenido \{[\s\S]*?margin-left: var\(--lateral-ancho\)/.test(css),
    'el contenido debe correrse con el ancho de la lateral'
  );
});

check('las ocho secciones siguen en el menu', () => {
  const secciones = (html.match(/data-vista=/g) || []).length;
  assert.strictEqual(secciones, 8, 'deben seguir las ocho vistas');
  for (const v of ['panel', 'calendario', 'tablero', 'mensajes',
    'contactos', 'usuarios', 'programados', 'consumo']) {
    assert.ok(html.includes(`data-vista="${v}"`), `falta ${v}`);
  }
});

check('cada seccion tiene su icono', () => {
  assert.strictEqual((html.match(/<symbol id=/g) || []).length, 8, 'ocho simbolos');
  assert.strictEqual(
    (html.match(/pestana-icono/g) || []).length,
    8,
    'ocho usos de icono'
  );
  // Los simbolos no se ven: solo existen para referenciarlos.
  assert.ok(css.includes('.sprite { display: none; }'), 'el sprite debe ocultarse');
});

check('el menu queda bien en el celular', () => {
  // El panel se usa mucho desde el celu: la lateral se convierte en cajon.
  assert.ok(css.includes('@media (max-width: 900px)'), 'debe haber regla movil');
  assert.ok(css.includes('.lateral.abierta'), 'debe poder deslizarse');
  assert.ok(
    /@media \(max-width: 900px\)[\s\S]*?\.contenido \{[\s\S]*?margin-left: 0/.test(css),
    'el contenido debe ocupar todo el ancho'
  );
  // En escritorio el boton hamburguesa no debe existir.
  assert.ok(
    css.includes('.menu-movil, .tapa-menu { display: none; }'),
    'el boton de menu se oculta en escritorio'
  );
});

console.log('\nComportamiento del menu');

check('se puede abrir y cerrar', () => {
  assert.ok(js.includes('function alternarMenu'), 'debe existir la funcion');
  assert.ok(
    js.includes("$('#menu-movil').addEventListener('click', () => alternarMenu())"),
    'el boton debe alternar'
  );
  assert.ok(
    js.includes("$('#tapa-menu').addEventListener('click', () => alternarMenu(false))"),
    'la tapa debe cerrar'
  );
  assert.ok(js.includes("ev.key === 'Escape'"), 'Escape debe cerrar');
});

check('al elegir seccion se cierra en el celular', () => {
  // Si no se cierra, el menu tapa justo la vista que se acaba de abrir.
  const fn = js.slice(js.indexOf('function irAVista'), js.indexOf('function irAVista') + 900);
  assert.ok(
    fn.includes('if (window.innerWidth <= 900) alternarMenu(false)'),
    'debe cerrarse al navegar'
  );
  // Y la navegacion de siempre no se rompe.
  assert.ok(
    fn.includes("v.classList.toggle('activa', v.id === `vista-${nombre}`)"),
    'debe seguir cambiando de vista'
  );
  assert.ok(fn.includes("p.classList.toggle('activa', activa)"), 'debe marcar la pestana');
});

check('la seccion actual queda marcada para accesibilidad', () => {
  assert.ok(js.includes("setAttribute('aria-current'"), 'debe marcar aria-current');
  assert.ok(html.includes('aria-expanded="false"'), 'el boton declara su estado');
});

check('el scroll de la pagina se libera al cerrar', () => {
  // Sin esto, en el celular la pagina queda bloqueada para siempre.
  assert.ok(js.includes('document.body.style.overflow'), 'debe liberar el scroll');
});

console.log(`\n${passed} comprobaciones OK\n`);