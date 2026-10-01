'use strict';
// OrbitaOs - parche de compatibilidad para whatsapp-web.js.
//
// En whatsapp-web.js 1.34.7 (la ultima estable) contra el WhatsApp Web actual,
// enviar un mensaje tira:
//
//   window.require(...).canCheckStatusRankingPosterGating is not a function
//
// La causa esta en el codigo que la libreria inyecta en el navegador:
// `getIsBroadcast(chat)` devuelve true para chats normales, con lo cual se toma
// el camino de "estado" y se llama a una funcion que WhatsApp Web ya no expone.
// Como el parche no esta upstream, se corrige el archivo en node_modules.
//
// El script es idempotente: si ya esta aplicado no hace nada, asi se puede
// ejecutar en cada arranque y en cada build sin riesgo.
//
// Uso: node scripts/patch_whatsapp.js

const fs = require('fs');
const path = require('path');

const OBJETIVO = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js', 'src', 'util', 'Injected', 'Utils.js');

// 1) isStatus mal calculado: lo marca como estado a un chat normal.
const VIEJO_IS_STATUS = '        const isStatus = getIsBroadcast(chat);';
const NUEVO_IS_STATUS = `        // Parche OrbitaOs: getIsBroadcast() devuelve true para chats normales en el
        // WhatsApp Web actual y eso manda el mensaje por el camino de "estado".
        // Un bot de atencion nunca publica estados, asi que solo se considera
        // estado si el chat es realmente una difusion.
        const chatIdStr = String(
            (chat && (chat.id?.toString?.() || chat.id?._serialized || chat.id)) || '',
        );
        const isStatus =
            getIsBroadcast(chat) && /@(broadcast|newsletter)/i.test(chatIdStr);`;

// 2) La funcion de WhatsApp Web que ya no existe.
const VIEJO_GATING = `                    cannotBeRanked: window
                        .require('WAWebStatusGatingUtils')
                        .canCheckStatusRankingPosterGating(),`;
const NUEVO_GATING = `                    // Parche OrbitaOs: canCheckStatusRankingPosterGating ya no existe en
                    // WhatsApp Web. Si falta, el mensaje se manda igual, solo
                    // sin la marca de "no clasificable" para el ranking.
                    cannotBeRanked: (() => {
                        try {
                            const mod = window.require('WAWebStatusGatingUtils');
                            return typeof mod.canCheckStatusRankingPosterGating ===
                                'function'
                                ? mod.canCheckStatusRankingPosterGating()
                                : false;
                        } catch (e) {
                            return false;
                        }
                    })(),`;

const PARCHES = [
  { nombre: 'isStatus', viejo: VIEJO_IS_STATUS, nuevo: NUEVO_IS_STATUS },
  { nombre: 'canCheckStatusRankingPosterGating', viejo: VIEJO_GATING, nuevo: NUEVO_GATING },
];

function aplicar() {
  if (!fs.existsSync(OBJETIVO)) {
    console.log('[parche] whatsapp-web.js no instalado: se omite.');
    return 0;
  }

  let src = fs.readFileSync(OBJETIVO, 'utf8');
  let aplicados = 0;

  for (const parche of PARCHES) {
    if (src.includes(parche.nuevo)) continue; // ya aplicado
    if (!src.includes(parche.viejo)) {
      console.error(`[parche] no se encontro el texto de "${parche.nombre}".`);
      console.error('[parche] La version de whatsapp-web.js cambio: revisar a mano.');
      continue;
    }
    src = src.replace(parche.viejo, parche.nuevo);
    aplicados += 1;
  }

  if (aplicados) {
    fs.writeFileSync(OBJETIVO, src);
  }
  console.log(`[parche] whatsapp-web.js: ${aplicados} parche(s) aplicado(s).`);
  return 0;
}

aplicar();