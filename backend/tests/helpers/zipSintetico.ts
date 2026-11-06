import { deflateRawSync } from "node:zlib";

/**
 * Constructor de ZIP para las pruebas de la carga masiva: arma archivos que ninguna
 * biblioteca generaría, con tamaños declarados falsos y cabeceras a medida.
 * El CRC queda en cero: ni la inspección ni JSZip (con las opciones de ExcelJS) lo miran.
 */
export interface EntradaSintetica {
  nombre: string | Buffer;
  /** Nombre del encabezado LOCAL, que es el que lee JSZip; por omisión, el mismo. */
  nombreLocal?: string | Buffer;
  contenido: Buffer | string;
  /** Sin comprimir. */
  almacenada?: boolean;
  /** Tamaño descomprimido que se DECLARA; por omisión, el real. */
  tamDeclarado?: number;
  metodo?: number;
  bandera?: number;
  extra?: Buffer;
  /** Recorta los datos comprimidos, para simular un archivo dañado. */
  truncar?: number;
}

export interface OpcionesZip {
  comentario?: Buffer;
  antes?: Buffer;
  despues?: Buffer;
  totalEntradas?: number;
}

export function construirZip(entradas: EntradaSintetica[], opciones: OpcionesZip = {}): Buffer {
  const locales: Buffer[] = [];
  const centrales: Buffer[] = [];
  let offset = 0;

  for (const e of entradas) {
    const real = Buffer.isBuffer(e.contenido) ? e.contenido : Buffer.from(e.contenido, "utf8");
    const comprimido = e.almacenada ? real : deflateRawSync(real);
    const datos = e.truncar ? comprimido.subarray(0, e.truncar) : comprimido;
    const metodo = e.metodo ?? (e.almacenada ? 0 : 8);
    const nombre = Buffer.from(e.nombre as string, "utf8");
    const nombreLocal = e.nombreLocal === undefined ? nombre : Buffer.from(e.nombreLocal as string, "utf8");
    const extra = e.extra ?? Buffer.alloc(0);
    const declarado = e.tamDeclarado ?? real.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(e.bandera ?? 0, 6);
    local.writeUInt16LE(metodo, 8);
    local.writeUInt32LE(datos.length, 18);
    local.writeUInt32LE(declarado, 22);
    local.writeUInt16LE(nombreLocal.length, 26);
    locales.push(local, nombreLocal, datos);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(e.bandera ?? 0, 8);
    central.writeUInt16LE(metodo, 10);
    central.writeUInt32LE(datos.length, 20);
    central.writeUInt32LE(declarado, 24);
    central.writeUInt16LE(nombre.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE(offset, 42);
    centrales.push(central, nombre, extra);

    offset += local.length + nombreLocal.length + datos.length;
  }

  const directorio = Buffer.concat(centrales);
  const comentario = opciones.comentario ?? Buffer.alloc(0);
  const total = opciones.totalEntradas ?? entradas.length;
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0);
  fin.writeUInt16LE(total, 8);
  fin.writeUInt16LE(total, 10);
  fin.writeUInt32LE(directorio.length, 12);
  fin.writeUInt32LE(offset, 16);
  fin.writeUInt16LE(comentario.length, 20);

  return Buffer.concat([opciones.antes ?? Buffer.alloc(0), ...locales, directorio, fin, comentario, opciones.despues ?? Buffer.alloc(0)]);
}

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** Las partes mínimas de un .xlsx que ExcelJS abre. */
export function partesDeLibro(hojas: { nombre: string; xml: string }[], extraLibro = ""): EntradaSintetica[] {
  const declaraHojas = hojas.map((h, i) => `<sheet name="${h.nombre}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("");
  const relaciones = hojas.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("");
  return [
    {
      nombre: "[Content_Types].xml",
      contenido:
        '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>',
    },
    {
      nombre: "_rels/.rels",
      contenido: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      nombre: "xl/workbook.xml",
      contenido: `<?xml version="1.0"?><workbook ${NS} xmlns:r="${REL}"><sheets>${declaraHojas}</sheets>${extraLibro}</workbook>`,
    },
    {
      nombre: "xl/_rels/workbook.xml.rels",
      contenido: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relaciones}</Relationships>`,
    },
    ...hojas.map((h, i) => ({ nombre: `xl/worksheets/sheet${i + 1}.xml`, contenido: h.xml })),
  ];
}

/** Una hoja con `cuerpo` dentro de `<sheetData>`, `antes` delante y `despues` detrás. */
export const hojaXml = (cuerpo: string, despues = "", antes = "") => `<?xml version="1.0"?><worksheet ${NS}>${antes}<sheetData>${cuerpo}</sheetData>${despues}</worksheet>`;

/** Un libro de una hoja `Personas` construido a mano. */
export const libroCrudo = (cuerpo: string, despues = "", antes = "", extraLibro = "") => construirZip(partesDeLibro([{ nombre: "Personas", xml: hojaXml(cuerpo, despues, antes) }], extraLibro));
