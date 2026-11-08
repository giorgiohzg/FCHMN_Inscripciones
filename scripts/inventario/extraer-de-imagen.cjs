"use strict";
/*  Extrae de UNA imagen todo lo necesario para redactar su aviso de terceros:
    paquetes Node con su texto de licencia, paquetes del sistema desde la base
    de apk, y los componentes sueltos que la imagen base aporta.

    Se ejecuta DENTRO de la imagen. Solo lectura y sin red.
    Argumentos: <artefacto> [rutas de node_modules...]

    Recorre cada raiz declarada Y los node_modules ANIDADOS de sus paquetes (solo
    <paquete>/node_modules, con o sin ambito), sin salir de la raiz. Las copias de un
    mismo paquete y version se agrupan en una entrada con todas sus `rutas`.
*/
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const artefacto = process.argv[2];
const basesNode = process.argv.slice(3);

const NOMBRES_LICENCIA = ["LICENSE", "LICENCE", "COPYING", "NOTICE", "COPYRIGHT"];

function sha256(s) { return crypto.createHash("sha256").update(s, "utf8").digest("hex"); }

function archivosLicencia(dir) {
    let entradas = [];
    try { entradas = fs.readdirSync(dir); } catch (e) { return []; }
    return entradas.filter((f) => {
        const M = f.toUpperCase();
        return NOMBRES_LICENCIA.some((n) => M === n || M.startsWith(n + "."));
    }).sort();
}

function normalizarExpresion(lic) {
    if (!lic) return null;
    if (typeof lic === "string") return lic;
    if (typeof lic === "object" && lic.type) return lic.type;
    if (Array.isArray(lic) && lic.length && lic[0].type) return lic.map((l) => l.type).join(" OR ");
    return null;
}

/* Tope de profundidad de anidamiento. Un arbol real de npm no pasa de media docena de
   niveles; el tope existe para que un arbol corrupto o malicioso no pueda alargar el
   recorrido sin limite, y se informa por stderr si alguna rama lo alcanza. */
const PROFUNDIDAD_MAXIMA = 32;

function esDirectorio(ruta) {
    try { return fs.statSync(ruta).isDirectory(); } catch (e) { return false; }
}

/* LICENCIA EN EL README. Caso ACOTADO y explicito, no un detector generico: hay paquetes
   publicados sin archivo de licencia cuyo README trae la licencia completa. Solo los de
   esta tabla (nombre Y version exactos) se leen asi, y solo cuando el paquete NO trae
   ningun archivo de licencia. Un paquete que no este aqui sigue sin texto y exige su
   entrada en notices/excepciones.json. Cada caso se verifica a mano contra el lanzamiento
   exacto antes de entrar en la tabla. */
const LICENCIA_EN_README = [
    { nombre: "isarray", version: "1.0.0", archivo: "README.md", seccion: "License" },
];

/* Devuelve, TAL CUAL (byte a byte), el texto desde la linea de encabezado de la seccion hasta
   el siguiente encabezado del mismo nivel o superior, o hasta el final del archivo.
   Devuelve null si no hay un encabezado con ese titulo exacto. */
function seccionDeReadme(contenido, titulo) {
    const lineas = contenido.split("\n");
    let inicio = -1, nivel = 0, desplazamiento = 0, desde = 0, enCodigo = false;
    for (let i = 0; i < lineas.length; i++) {
        if (/^\s*```/.test(lineas[i])) enCodigo = !enCodigo; // un # dentro de un bloque de codigo no es un encabezado
        const m = enCodigo ? null : /^(#{1,6})[ \t]+(.*?)[ \t]*$/.exec(lineas[i].replace(/\r$/, ""));
        if (inicio < 0 && m && m[2] === titulo) { inicio = i; nivel = m[1].length; desde = desplazamiento; }
        else if (inicio >= 0 && m && m[1].length <= nivel) return contenido.slice(desde, desplazamiento);
        desplazamiento += lineas[i].length + 1;
    }
    return inicio < 0 ? null : contenido.slice(desde);
}

function textoDesdeReadme(nombre, version, dir) {
    const regla = LICENCIA_EN_README.find((r) => r.nombre === nombre && r.version === version);
    if (!regla) return [];
    let contenido;
    try { contenido = fs.readFileSync(path.join(dir, regla.archivo), "utf8"); } catch (e) { return []; }
    const texto = seccionDeReadme(contenido, regla.seccion);
    if (texto === null || texto.trim() === "") return [];
    return [{ archivo: regla.archivo, seccion: regla.seccion, sha256: sha256(texto), bytes: Buffer.byteLength(texto, "utf8"), texto }];
}

/* Lee UN paquete (su directorio y su package.json). Devuelve null si no es un paquete. */
function leerPaquete(nombre, dir, base, rutaRelativa) {
    const pj = path.join(dir, "package.json");
    if (!fs.existsSync(pj)) return null;
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(pj, "utf8")); } catch (e) { meta = {}; }
    const archivos = archivosLicencia(dir);
    let textos = archivos.map((f) => {
        let contenido = "";
        try { contenido = fs.readFileSync(path.join(dir, f), "utf8"); } catch (e) { contenido = ""; }
        return { archivo: f, sha256: sha256(contenido), bytes: Buffer.byteLength(contenido, "utf8"), texto: contenido };
    });
    if (textos.length === 0) textos = textoDesdeReadme(nombre, meta.version, dir);
    let autor = null;
    if (typeof meta.author === "string") autor = meta.author;
    else if (meta.author && meta.author.name) autor = meta.author.name;
    return {
        nombre,
        version: meta.version || null,
        expresion: normalizarExpresion(meta.license || meta.licenses),
        autor,
        repositorio: meta.repository ? (typeof meta.repository === "string" ? meta.repository : meta.repository.url || null) : null,
        base,
        rutas: [rutaRelativa],
        archivosLicencia: archivos,
        tieneNotice: archivos.some((f) => f.toUpperCase().startsWith("NOTICE")),
        textos,
    };
}

/* Recorre UN directorio node_modules y, por cada paquete que contiene, SOLO su
   subdirectorio `node_modules` (nunca el resto de carpetas del paquete). Incluye los
   paquetes con ambito (@ambito/paquete).

   Limites del recorrido:
     - nunca sale de la raiz autorizada: cada paquete se resuelve con realpath y debe
       quedar dentro de la raiz real; un enlace simbolico hacia fuera se ignora;
     - nunca visita dos veces el mismo directorio real (evita ciclos de enlaces);
     - profundidad maxima PROFUNDIDAD_MAXIMA. */
function recorrer(dirNodeModules, base, raizReal, prefijo, visitados, salida, profundidad) {
    if (profundidad > PROFUNDIDAD_MAXIMA) {
        process.stderr.write("AVISO: profundidad maxima alcanzada en " + dirNodeModules + String.fromCharCode(10));
        return;
    }
    let entradas = [];
    try { entradas = fs.readdirSync(dirNodeModules).sort(); } catch (e) { return; }
    for (const entrada of entradas) {
        if (entrada.startsWith(".")) continue;
        const ruta = path.join(dirNodeModules, entrada);
        if (!esDirectorio(ruta)) continue;
        const hijos = entrada.startsWith("@")
            ? fs.readdirSync(ruta).sort().map((n) => ({ nombre: entrada + "/" + n, ruta: path.join(ruta, n) }))
            : [{ nombre: entrada, ruta }];
        for (const h of hijos) {
            if (h.nombre.startsWith("@") && h.nombre.split("/")[1].startsWith(".")) continue;
            if (!esDirectorio(h.ruta)) continue;
            let real;
            try { real = fs.realpathSync(h.ruta); } catch (e) { continue; }
            if (real !== raizReal && !real.startsWith(raizReal + path.sep)) continue; // fuera de la raiz autorizada
            if (visitados.has(real)) continue; // ciclo o duplicado por enlace
            const rel = prefijo + h.nombre;
            const paquete = leerPaquete(h.nombre, h.ruta, base, rel);
            if (!paquete) continue;
            visitados.add(real);
            salida.push(paquete);
            const anidado = path.join(h.ruta, "node_modules");
            if (esDirectorio(anidado)) recorrer(anidado, base, raizReal, rel + "/node_modules/", visitados, salida, profundidad + 1);
        }
    }
}

/* DUPLICADOS. El mismo paquete en la misma version aparece en varios sitios del arbol
   (por ejemplo, glob 7.2.3 bajo dos paquetes distintos). Se agrupan en UNA entrada con
   todas sus `rutas`, de modo que no se pierde ninguna ubicacion y el aviso no repite el
   mismo texto. La clave incluye la raiz, la expresion y los textos de licencia: dos copias
   que se llamen igual y tengan la misma version pero distinta licencia NO se fusionan.
   Versiones distintas son siempre entradas distintas. */
function agrupar(paquetes) {
    const porClave = new Map();
    for (const p of paquetes) {
        const clave = JSON.stringify([p.base, p.nombre, p.version, p.expresion, p.textos.map((t) => t.archivo + ":" + t.sha256)]);
        const existente = porClave.get(clave);
        if (existente) existente.rutas.push(...p.rutas);
        else porClave.set(clave, p);
    }
    const lista = [...porClave.values()];
    for (const p of lista) p.rutas.sort();
    const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    return lista.sort((a, b) =>
        a.nombre.localeCompare(b.nombre) ||
        cmp(a.version || "", b.version || "") ||
        cmp(a.base, b.base) ||
        cmp(a.rutas[0], b.rutas[0]));
}

function leerPaquetesNode(base) {
    let raizReal;
    try { raizReal = fs.realpathSync(base); } catch (e) { return []; }
    const salida = [];
    recorrer(base, base, raizReal, "", new Set(), salida, 0);
    return agrupar(salida);
}

function leerApk() {
    const RUTA = "/lib/apk/db/installed";
    if (!fs.existsSync(RUTA)) return [];
    const crudo = fs.readFileSync(RUTA, "utf8");
    const pk = []; let a = null;
    for (const l of crudo.split("\n")) {
        if (l === "") { if (a && a.nombre) pk.push(a); a = null; continue; }
        if (!a) a = {};
        const k = l.slice(0, 1), v = l.slice(2);
        if (k === "P") a.nombre = v;
        else if (k === "V") a.version = v;
        else if (k === "L") a.expresion = v;
        else if (k === "o") a.origen = v;
        else if (k === "U") a.url = v;
        // `c:` es el COMMIT DE APORTS con el que se construyo ESTE binario, y
        // `t:` su fecha. Es el dato decisivo para la fuente correspondiente:
        // la rama sigue avanzando, de modo que consultar hoy que version
        // publica la rama NO identifica el codigo del binario distribuido.
        // Aqui viene conservado dentro del propio artefacto.
        else if (k === "c") a.commit = v;
        else if (k === "t") a.construido = v;
    }
    if (a && a.nombre) pk.push(a);
    return pk.map((p) => ({
        nombre: p.nombre, version: p.version || null,
        expresion: (p.expresion && p.expresion.trim()) ? p.expresion : null,
        origen: p.origen || p.nombre, url: p.url || null,
        commit: p.commit || null,
        construido: p.construido ? new Date(Number(p.construido) * 1000).toISOString() : null,
    })).sort((x, y) => x.nombre.localeCompare(y.nombre));
}

// Componentes sueltos que aportan las imagenes base y que no estan ni en
// node_modules ni en la base de apk.
function leerSueltos() {
    const candidatos = [
        { componente: "Node.js", ruta: "/usr/local/LICENSE", nota: "licencia combinada de Node.js; enumera sus componentes de terceros" },
        { componente: "Yarn", ruta: "/opt/yarn-v1.22.22/LICENSE", nota: "Yarn viene incluido en la imagen base de Node" },
        { componente: "nginx", ruta: "/usr/share/licenses/nginx/COPYRIGHT", nota: "paquete de nginx.org, no de aports" },
        { componente: "nginx-module-njs", ruta: "/usr/share/licenses/nginx-module-njs/COPYRIGHT", nota: "paquete de nginx.org" },
        { componente: "nginx-module-geoip", ruta: "/usr/share/licenses/nginx-module-geoip/COPYRIGHT", nota: "paquete de nginx.org" },
        { componente: "nginx-module-xslt", ruta: "/usr/share/licenses/nginx-module-xslt/COPYRIGHT", nota: "paquete de nginx.org" },
        { componente: "nginx-module-image-filter", ruta: "/usr/share/licenses/nginx-module-image-filter/COPYRIGHT", nota: "paquete de nginx.org" },
        // Nuevo con Nginx 1.30 (AUD-B): la imagen oficial incorpora el modulo ACME de nginx.org, que trae su propio texto.
        { componente: "nginx-module-acme", ruta: "/usr/share/licenses/nginx-module-acme/COPYRIGHT", nota: "paquete de nginx.org" },
    ];
    const out = [];
    for (const c of candidatos) {
        if (!fs.existsSync(c.ruta)) continue;
        const texto = fs.readFileSync(c.ruta, "utf8");
        out.push({ ...c, sha256: sha256(texto), bytes: Buffer.byteLength(texto, "utf8"), texto });
    }
    return out;
}

const paquetesNode = [];
for (const b of basesNode) { paquetesNode.push(...leerPaquetesNode(b)); }

process.stdout.write(JSON.stringify({
    artefacto,
    sistema: leerApk(),
    node: paquetesNode,
    sueltos: leerSueltos(),
}, null, 2) + "\n");
