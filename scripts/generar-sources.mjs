#!/usr/bin/env node
/*
 * GENERADOR DE notices/sources.json
 *
 * Relaciona cada componente copyleft o Apache distribuido con su fuente EXACTA
 * y con el mecanismo previsto para ponerla a disposición.
 *
 * DE DÓNDE SALE EL COMMIT. Del campo `c:` de `/lib/apk/db/installed`, que apk
 * conserva dentro del propio artefacto: es el commit de aports con el que se
 * construyó ESE binario. No se consulta qué versión publica hoy la rama,
 * porque la rama sigue avanzando y una versión posterior no es el código
 * fuente correspondiente al binario que se distribuye.
 *
 * Determinista y sin red: lee notices/inventario/*.json y nada más.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(RAIZ, "notices");

const ARTEFACTOS = [
  { nombre: "frontend-image", rama: "3.21-stable" },
  { nombre: "backend", rama: "3.24-stable" },
  { nombre: "migrate", rama: "3.24-stable" },
];

const esCopyleft = (e) => /GPL|MPL/i.test(e || "");
const esApache = (e) => /Apache/i.test(e || "");

const fuentes = new Map();
for (const art of ARTEFACTOS) {
  const inv = JSON.parse(readFileSync(path.join(DIR, "inventario", `${art.nombre}.json`), "utf8"));
  for (const p of inv.sistema) {
    if (!esCopyleft(p.expresion) && !esApache(p.expresion)) continue;
    const clave = `${art.rama}|${p.origen}|${p.version}`;
    if (!fuentes.has(clave)) {
      fuentes.set(clave, {
        ramaAports: art.rama,
        paqueteFuente: p.origen,
        versionDistribuida: p.version,
        expresion: p.expresion,
        clase: esCopyleft(p.expresion) ? "copyleft" : "apache",
        proyectoUpstream: p.url || null,
        binarios: [],
        artefactos: [],
        // El commit del artefacto es la fuente de verdad.
        commitAports: p.commit,
        construido: p.construido,
        resuelto: Boolean(p.commit),
        apkbuild: p.commit
          ? `https://gitlab.alpinelinux.org/alpine/aports/-/blob/${p.commit}/main/${p.origen}/APKBUILD`
          : null,
        arbolDeAports: p.commit
          ? `https://gitlab.alpinelinux.org/alpine/aports/-/tree/${p.commit}/main/${p.origen}`
          : null,
        espejoOficial: p.commit
          ? `https://github.com/alpinelinux/aports/tree/${p.commit}/main/${p.origen}`
          : null,
        nota: p.commit
          ? "Commit tomado del campo `c:` de la base de apk del propio artefacto: identifica el codigo con el que se construyo ESTE binario."
          : "SIN COMMIT DE APORTS: el paquete no procede de aports.",
      });
    }
    const f = fuentes.get(clave);
    if (!f.binarios.includes(p.nombre)) f.binarios.push(p.nombre);
    if (!f.artefactos.includes(art.nombre)) f.artefactos.push(art.nombre);
  }
}

const lista = [...fuentes.values()].sort((a, b) =>
  (a.ramaAports + a.paqueteFuente).localeCompare(b.ramaAports + b.paqueteFuente));
for (const f of lista) { f.binarios.sort(); f.artefactos.sort(); }

const sinResolver = lista.filter((f) => !f.resuelto);
const corpus = JSON.parse(readFileSync(path.join(DIR, "corpus.json"), "utf8"));
const corpusSinResolver = corpus.licencias.filter((l) => !l.resuelto);

const avisosFuente = JSON.parse(readFileSync(path.join(DIR, "avisos-fuente.json"), "utf8"));
const noVerificables = avisosFuente.paquetes.filter((p) => p.estado === "no-verificable");

/*  HITOS que no dependen de los manifiestos sino del estado del proyecto. Se
    declaran aqui para que el bloqueo no pueda levantarse solo, por el mero
    hecho de resolver los manifiestos: mientras no existan las candidatas
    finales verificadas y el archivo de fuentes, la entrega externa sigue
    prohibida. Se cambian a mano, y a conciencia. */
const HITOS = {
  candidatasFinalesConstruidasYVerificadas: false,
  archivoDeFuentesCorrespondienteCreado: false,
};

const bloqueos = [];
for (const f of sinResolver) {
  bloqueos.push(`fuente sin resolver: ${f.paqueteFuente}@${f.versionDistribuida} (${f.artefactos.join(", ")})`);
}
for (const l of corpusSinResolver) {
  bloqueos.push(`texto de licencia sin resolver: ${l.identificador} en ${(l.paquetesAfectados || []).join(", ")}`);
}
if (noVerificables.length > 0) {
  bloqueos.push(
    `${noVerificables.length} paquetes fuente cuyos avisos de copyright NO pudieron verificarse: su fuente exacta se publica solo como tarball. No se afirma que carezcan de aviso; se afirma que no se comprobo.`);
}
if (!HITOS.candidatasFinalesConstruidasYVerificadas) {
  bloqueos.push("las candidatas finales no se han construido ni verificado");
}
if (!HITOS.archivoDeFuentesCorrespondienteCreado) {
  bloqueos.push("no existe archivo de fuentes correspondiente para una eventual entrega externa");
}

const salida = {
  proposito: "Relaciona cada componente copyleft o Apache distribuido en las imagenes con su fuente exacta y con el mecanismo previsto para ponerla a disposicion. Es un registro de PROCEDENCIA y de PLAN, no una declaracion de disponibilidad.",
  revisado: "2026-09-20",
  generadoPor: "scripts/generar-sources.mjs a partir de notices/inventario/*.json",
  origenDeLosCommits: {
    campo: "c: de /lib/apk/db/installed",
    porQue: "apk conserva dentro del artefacto el commit de aports con el que se construyo cada binario. Es la fuente correspondiente exacta. Consultar que version publica hoy la rama NO sirve: en la resolucion del 2026-09-20, 27 de 87 paquetes ya tenian en su rama una version posterior a la distribuida.",
    prioridadSeguida: [
      "1. metadatos conservados en la base de apk instalada (campo c:) -- USADA",
      "2. historial del espejo oficial de aports -- no necesaria",
      "3. archivo oficial de Alpine -- no necesaria",
    ],
  },
  estadoDeDisponibilidad: {
    archivoDeFuentesCreado: false,
    ofertaEscritaPublicada: false,
    nota: "Todavia NO existe archivo de fuentes correspondiente ni oferta publicada. Este manifiesto no debe citarse como prueba de disponibilidad hasta que ese material exista.",
  },
  entregaExterna: {
    bloqueada: bloqueos.length > 0,
    hitos: HITOS,
    motivos: bloqueos,
    nota: "Mientras exista un solo motivo en esta lista, las imagenes NO pueden entregarse fuera de FCHMN.",
  },
  escenarioActual: {
    repositorio: "privado",
    uso: "interno de FCHMN",
    imagenesEntregadasFueraDeFCHMN: false,
    frontendEntregadoANavegadores: true,
    consecuencia: "Las obligaciones de ofrecer fuente por distribucion externa no se activan todavia. Esto NO elimina las condiciones de atribucion: los avisos se incorporan igualmente, como politica conservadora de cumplimiento y para dejar el proyecto listo para una entrega externa futura.",
  },
  mecanismoPrevisto: {
    preferido: "archivo-de-fuentes-acompanante",
    descripcion: "Cada version publicada de las imagenes se acompanara de un archivo con la fuente correspondiente a ESAS versiones exactas: el APKBUILD y los parches de aports en el commit registrado aqui, mas los tarballs upstream que ese APKBUILD declara en `source=`.",
    porQueNoOfertaEscrita: "Una oferta escrita depende de una promesa operativa posterior y de enlaces que caducan: dl-cdn.alpinelinux.org retira las ramas al terminar su soporte, de modo que las versiones exactas dejan de estar disponibles. Acompanar la fuente elimina esa dependencia.",
    lgpl: {
      mecanismoDeEnlace: "enlace dinamico contra bibliotecas compartidas del sistema",
      consecuencia: "El destinatario puede sustituir la biblioteca reemplazando el objeto compartido dentro de la imagen. Esta condicion es la que hace admisible el enlace y se declara en el aviso.",
      pendienteDeVerificar: "Confirmar el enlace dinamico sobre las candidatas finales, no sobre las imagenes actuales.",
    },
    mpl: {
      alcance: "MPL-2.0 cubre archivos concretos, no la obra entera.",
      queRecibeElDestinatario: "La ubicacion de la fuente de los archivos cubiertos y el aviso de que estan bajo MPL-2.0, con derecho a obtenerlos en forma de codigo fuente.",
    },
  },
  fuentesNoAlpine: [
    {
      componente: "nginx y sus modulos (geoip, image-filter, njs, xslt)",
      expresion: "2-clause BSD-like license",
      clase: "permisiva",
      origen: "paquetes publicados por nginx.org e instalados por la imagen base oficial nginx",
      proyectoUpstream: "https://nginx.org/",
      avisoIncluidoEnLaImagen: "/usr/share/licenses/<paquete>/COPYRIGHT",
      nota: "No proceden de aports: su registro en la base de apk no lleva campo `c:`. No requieren oferta de fuente por ser permisiva, y su texto exacto ya viaja en la imagen.",
    },
    {
      componente: "Node.js",
      origen: "imagen base oficial node",
      avisoIncluidoEnLaImagen: "/usr/local/LICENSE",
      nota: "Licencia combinada que enumera 43 componentes de terceros, entre ellos OpenSSL, V8, ICU, libuv y zlib. Ya viaja en la imagen y el aviso la reproduce.",
    },
    {
      componente: "Yarn",
      expresion: "BSD-2-Clause",
      origen: "imagen base oficial node",
      avisoIncluidoEnLaImagen: "/opt/yarn-v1.22.22/LICENSE",
      nota: "Viaja en backend y migrate aunque el proyecto no lo usa. Candidato a retirada en una revision posterior del Dockerfile.",
    },
  ],
  avisosDeCopyright: {
    manifiesto: "notices/avisos-fuente.json",
    paquetesFuente: avisosFuente.resumen.paquetesFuente,
    conAvisoPropio: avisosFuente.resumen.conAvisoPropio,
    verificadoAusente: avisosFuente.resumen.verificadoAusente,
    noVerificable: avisosFuente.resumen.noVerificable,
  },
  totalComponentes: lista.length,
  componentesSinResolver: sinResolver.length,
  componentes: lista,
};

writeFileSync(path.join(DIR, "sources.json"), JSON.stringify(salida, null, 2) + "\n");

console.log(`componentes copyleft/apache : ${lista.length}`);
console.log(`  copyleft                  : ${lista.filter((f) => f.clase === "copyleft").length}`);
console.log(`  apache                    : ${lista.filter((f) => f.clase === "apache").length}`);
console.log(`  con commit exacto         : ${lista.filter((f) => f.resuelto).length}`);
console.log(`  SIN resolver              : ${sinResolver.length}`);
console.log(`entrega externa bloqueada   : ${salida.entregaExterna.bloqueada}`);
for (const m of bloqueos) console.log(`    - ${m}`);
