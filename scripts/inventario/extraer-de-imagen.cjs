"use strict";
/*  Extrae de UNA imagen todo lo necesario para redactar su aviso de terceros:
    paquetes Node con su texto de licencia, paquetes del sistema desde la base
    de apk, y los componentes sueltos que la imagen base aporta.

    Se ejecuta DENTRO de la imagen. Solo lectura y sin red.
    Argumentos: <artefacto> [rutas de node_modules...]
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

function leerPaquetesNode(base) {
    const salida = [];
    let raiz = [];
    try { raiz = fs.readdirSync(base); } catch (e) { return salida; }
    for (const entrada of raiz) {
        if (entrada.startsWith(".")) continue;
        const ruta = path.join(base, entrada);
        let st; try { st = fs.statSync(ruta); } catch (e) { continue; }
        if (!st.isDirectory()) continue;
        const hijos = entrada.startsWith("@")
            ? fs.readdirSync(ruta).map((n) => ({ nombre: entrada + "/" + n, ruta: path.join(ruta, n) }))
            : [{ nombre: entrada, ruta }];
        for (const h of hijos) {
            const pj = path.join(h.ruta, "package.json");
            if (!fs.existsSync(pj)) continue;
            let meta = {};
            try { meta = JSON.parse(fs.readFileSync(pj, "utf8")); } catch (e) { meta = {}; }
            const archivos = archivosLicencia(h.ruta);
            const textos = archivos.map((f) => {
                let contenido = "";
                try { contenido = fs.readFileSync(path.join(h.ruta, f), "utf8"); } catch (e) { contenido = ""; }
                return { archivo: f, sha256: sha256(contenido), bytes: Buffer.byteLength(contenido, "utf8"), texto: contenido };
            });
            let autor = null;
            if (typeof meta.author === "string") autor = meta.author;
            else if (meta.author && meta.author.name) autor = meta.author.name;
            salida.push({
                nombre: h.nombre,
                version: meta.version || null,
                expresion: normalizarExpresion(meta.license || meta.licenses),
                autor,
                repositorio: meta.repository ? (typeof meta.repository === "string" ? meta.repository : meta.repository.url || null) : null,
                base,
                archivosLicencia: archivos,
                tieneNotice: archivos.some((f) => f.toUpperCase().startsWith("NOTICE")),
                textos,
            });
        }
    }
    return salida.sort((a, b) => a.nombre.localeCompare(b.nombre));
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
