/**
 * Reporte GENERAL «Clubes y nadadores» (exclusivo de administración): consulta y archivos.
 * Las reglas (qué entra, orden, filas, paginación del PDF) están en `clubesYNadadores.rules.ts`.
 *
 * No recibe ni consulta ninguna competencia. Tres consultas en total, sin una por club.
 */
import { Prisma } from "@prisma/client";
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import { prisma } from "../../shared/prisma.client";
import { ForbiddenError } from "../../shared/errors";
import type { ActorContext } from "../../shared/actorContext";
import { hoyEnZonaDelNegocio } from "../../shared/fecha.util";
import { whereSinClubAsignable } from "../swimmer-assignment/assignment.service";
import {
  armarReporte,
  celdasSeguras,
  ENCABEZADOS,
  filasDelReporte,
  paginarPdf,
  resumenDeTotales,
  type LineaDelPdf,
  type ReporteClubesYNadadores,
} from "./clubesYNadadores.rules";

/** Segunda barrera, además de `requireRole("admin")` en la ruta (igual que el resumen por club). */
function exigirAdministracion(actor: ActorContext): void {
  if (actor.scope.kind !== "admin") throw new ForbiddenError("Este reporte es exclusivo de administración.");
}

const CAMPOS_DE_PERSONA = { id: true, run: true, fullName: true, firstName: true, paternalLastName: true, maternalLastName: true } as const;

const comoPersona = (p: {
  id: string;
  run: string;
  fullName: string;
  firstName: string | null;
  paternalLastName: string | null;
  maternalLastName: string | null;
}) => ({
  personId: p.id,
  run: p.run, // solo para desempatar el orden; no sale en el reporte
  fullName: p.fullName,
  firstName: p.firstName,
  paternalLastName: p.paternalLastName,
  maternalLastName: p.maternalLastName,
});

/**
 * LECTURA COHERENTE: las tres consultas (clubes, membresías activas y personas sin club) se
 * leen en UNA transacción `REPEATABLE READ` y de solo lectura. En PostgreSQL ese nivel toma una
 * única instantánea con la primera consulta y todas las siguientes ven ese mismo momento: una
 * asignación, una baja o un traslado confirmados entre medias no se ven a medias (una persona
 * omitida o en dos grupos). Con el nivel predeterminado (`READ COMMITTED`) cada consulta tendría
 * su propia instantánea, aunque estuvieran en la misma transacción.
 */
export async function obtenerClubesYNadadores(actor: ActorContext): Promise<ReporteClubesYNadadores> {
  exigirAdministracion(actor);
  const { clubes, membresias, sinClub } = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      const clubes = await tx.club.findMany({ where: { deletedAt: null }, select: { id: true, name: true, code: true, status: true } });
      const membresias = await tx.clubSwimmer.findMany({
        where: { status: "active", person: { deletedAt: null } },
        select: { clubId: true, club: { select: { name: true, code: true, deletedAt: true } }, person: { select: CAMPOS_DE_PERSONA } },
      });
      const sinClub = await tx.person.findMany({ where: whereSinClubAsignable(), select: CAMPOS_DE_PERSONA });
      return { clubes, membresias, sinClub };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 30_000 }
  );
  return armarReporte({
    clubes,
    membresiasActivas: membresias.map((m) => ({
      clubId: m.clubId,
      club: { name: m.club.name, code: m.club.code, eliminado: m.club.deletedAt !== null },
      persona: comoPersona(m.person),
    })),
    sinClub: sinClub.map(comoPersona),
  });
}

export const NOMBRE_DE_ARCHIVO = "Clubes_y_nadadores";

export async function xlsxDelReporte(r: ReporteClubesYNadadores): Promise<Buffer> {
  const libro = new ExcelJS.Workbook();
  const hoja = libro.addWorksheet("Clubes y nadadores");
  hoja.addRow([...ENCABEZADOS]).font = { bold: true };
  for (const fila of filasDelReporte(r)) hoja.addRow(celdasSeguras(fila));
  hoja.columns = [{ width: 24 }, { width: 36 }, { width: 10 }, { width: 6 }, { width: 48 }];
  hoja.views = [{ state: "frozen", ySplit: 1 }];
  return Buffer.from(await libro.xlsx.writeBuffer());
}

/**
 * MEDIDAS DEL PDF (puntos). Cada línea se mide con `heightOfString`, con la MISMA fuente, tamaño
 * y ancho con que se dibuja, de modo que un nombre o un club largos ocupan las líneas que
 * realmente necesitan: no se recortan ni se montan sobre la siguiente.
 */
const MARGEN = 40;
const PIE = 18; // espacio reservado para «Página N de M» dentro del área útil
const SANGRIA = 14;
const RELLENO_LINEA = 3;
const RELLENO_ENCABEZADO = 8;
const ESTILO = {
  nadador: { fuente: "Helvetica", tamano: 9.5 },
  vacio: { fuente: "Helvetica-Oblique", tamano: 9.5 },
  encabezado: { fuente: "Helvetica-Bold", tamano: 10.5 },
} as const;
const COLOR_ENCABEZADO = { club: "#dfe5ef", sinClub: "#dfe5ef", revision: "#f6e3c8" } as const;

export function pdfDelReporte(r: ReporteClubesYNadadores, ahora: Date = new Date()): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: MARGEN, size: "A4", autoFirstPage: true });
    const chunks: Buffer[] = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const ancho = doc.page.width - 2 * MARGEN;
    const anchoTexto = (l: LineaDelPdf) => (l.tipo === "encabezado" ? ancho - 2 * RELLENO_ENCABEZADO : ancho - SANGRIA);
    const fijarEstilo = (l: LineaDelPdf) => doc.font(ESTILO[l.tipo].fuente).fontSize(ESTILO[l.tipo].tamano);
    const medir = (l: LineaDelPdf) => {
      fijarEstilo(l);
      const texto = doc.heightOfString(l.texto, { width: anchoTexto(l) });
      return Math.ceil(texto + 2 * (l.tipo === "encabezado" ? RELLENO_ENCABEZADO : RELLENO_LINEA));
    };

    // Cabecera de la primera página: título y totales (que también pueden ocupar dos líneas).
    const titulo = "Clubes y nadadores";
    const resumen = `Pertenencia vigente al ${hoyEnZonaDelNegocio(ahora).split("-").reverse().join("-")} · ${resumenDeTotales(r)}`;
    doc.font("Helvetica-Bold").fontSize(16);
    const altoTitulo = doc.heightOfString(titulo, { width: ancho });
    doc.font("Helvetica").fontSize(9);
    const altoResumen = doc.heightOfString(resumen, { width: ancho });
    const altoCabecera = Math.ceil(altoTitulo + 6 + altoResumen + 16);

    const util = doc.page.height - 2 * MARGEN - PIE;
    const paginas = paginarPdf(r, { altoPrimera: util - altoCabecera, alto: util, medir });

    paginas.forEach((lineas, i) => {
      if (i > 0) doc.addPage();
      let y = MARGEN;
      if (i === 0) {
        doc.font("Helvetica-Bold").fontSize(16).fillColor("#000").text(titulo, MARGEN, y, { width: ancho });
        doc
          .font("Helvetica")
          .fontSize(9)
          .text(resumen, MARGEN, y + altoTitulo + 6, { width: ancho });
        y += altoCabecera;
      }
      for (const { linea: l, alto } of lineas) {
        if (l.tipo === "encabezado") {
          // Banda de fondo del alto real del encabezado: legible al imprimir aunque ocupe dos líneas.
          doc.rect(MARGEN, y + 1, ancho, alto - 2).fill(l.continuacion ? "#eef1f6" : COLOR_ENCABEZADO[l.grupo]);
          fijarEstilo(l)
            .fillColor("#0b2545")
            .text(l.texto, MARGEN + RELLENO_ENCABEZADO, y + RELLENO_ENCABEZADO, { width: anchoTexto(l) });
        } else {
          fijarEstilo(l)
            .fillColor(l.tipo === "vacio" ? "#555" : "#000")
            .text(l.texto, MARGEN + SANGRIA, y + RELLENO_LINEA, { width: anchoTexto(l) });
        }
        doc.fillColor("#000");
        y += alto;
      }
      // El pie va dentro del margen inferior: sin bajarlo, pdfkit abriría una página nueva.
      const margenInferior = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc
        .font("Helvetica")
        .fontSize(8)
        .fillColor("#555")
        .text(`Página ${i + 1} de ${paginas.length}`, MARGEN, doc.page.height - MARGEN + 4, {
          width: ancho,
          align: "right",
          lineBreak: false,
        });
      doc.fillColor("#000");
      doc.page.margins.bottom = margenInferior;
    });
    doc.end();
  });
}
