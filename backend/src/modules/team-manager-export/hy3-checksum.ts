/**
 * Checksum de línea del formato Hy-Tek HY3 (usado por Team Manager / Meet
 * Manager). El algoritmo se verificó empíricamente contra una exportación
 * real de Hy-Tek: sus 121 líneas de datos coincidieron exactamente con este
 * cálculo.
 *
 * El fixture que se conserva en el repositorio (`tests/fixtures/sample.hy3`)
 * es SINTÉTICO: mantiene la estructura, los anchos y la codificación del
 * formato, pero sus personas, club y competencia son inventados. Las líneas
 * de encabezado que no contienen ningún dato de persona no se tocaron, así
 * que su checksum sigue siendo el que escribió Hy-Tek: son ellas las que
 * sostienen la verificación en `tests/hy3-checksum.test.ts`.
 *
 * Cada línea HY3 tiene 130 caracteres: 128 de contenido + 2 dígitos de
 * checksum, terminada en CRLF.
 *
 * Algoritmo:
 *  1. Sumar los valores ASCII de los caracteres en posiciones PARES (0-indexado).
 *  2. Sumar el DOBLE de los valores ASCII de los caracteres en posiciones IMPARES.
 *  3. sum = sumaPares + sumaImpares
 *  4. resultado = floor(sum / 21)
 *  5. sum2 = resultado + 205
 *  6. checksum = dígito de unidades de sum2, seguido del dígito de decenas
 *     (orden invertido respecto al número normal).
 */
export const HY3_CONTENT_LENGTH = 128;
export const HY3_LINE_LENGTH = 130;

export function computeHy3Checksum(content: string): string {
  if (content.length !== HY3_CONTENT_LENGTH) {
    throw new Error(`El contenido debe tener exactamente ${HY3_CONTENT_LENGTH} caracteres (recibidos: ${content.length})`);
  }

  let sumEven = 0;
  let sumOdd = 0;
  for (let i = 0; i < content.length; i++) {
    const code = content.charCodeAt(i);
    if (i % 2 === 0) sumEven += code;
    else sumOdd += code * 2;
  }

  const total = sumEven + sumOdd;
  const result = Math.floor(total / 21);
  const sum2 = result + 205;
  const ones = sum2 % 10;
  const tens = Math.floor(sum2 / 10) % 10;

  return `${ones}${tens}`;
}

/** Construye una línea HY3 completa (130 chars, con checksum) a partir del contenido de 128 chars. */
export function buildHy3Line(content128: string): string {
  const padded = content128.padEnd(HY3_CONTENT_LENGTH, " ").slice(0, HY3_CONTENT_LENGTH);
  return padded + computeHy3Checksum(padded);
}
