/**
 * Parser del formato Hy-Tek ".hyv" ("Meet Events", variante sin comprimir).
 *
 * CÓMO SE DECODIFICÓ, porque el alcance de lo que sigue depende de ello.
 *
 * No viene de documentación de terceros ni de suposiciones. Se obtuvo un
 * `.hyv` real y el `.ev3` del MISMO evento, exportados por la misma
 * instalación de Meet Manager (ambos declaran la versión `7.0Gb`). Los dos
 * archivos numeran las mismas 24 pruebas en el mismo orden, así que cada línea
 * de uno tiene su pareja exacta en el otro y la correspondencia de campos se
 * obtiene por alineación, no por conjetura. Ninguno de los dos archivos entra
 * al repositorio: contienen el nombre de un evento y un recinto reales. El
 * fixture que sí se conserva es SINTÉTICO y reproduce esta gramática con una
 * competencia inventada.
 *
 * LÍMITE DE VALIDEZ, y es una regla de funcionamiento, no una nota al pie:
 * todo lo de abajo se verificó contra la versión `7.0Gb` y un único evento, y
 * **solo esa versión y esa disposición se aceptan**. Si el encabezado no trae
 * exactamente 11 campos, si alguna línea de prueba no trae exactamente 18, o
 * si el archivo declara otra versión del exportador, la importación se
 * RECHAZA y no se crea ninguna competencia.
 *
 * Antes esto era un aviso y el archivo se interpretaba igual por posición. Es
 * una tentación razonable —quizá acierte— pero el modo de fallar es pésimo: si
 * el layout cambió, las pruebas entran con distancias o estilos equivocados,
 * la competencia se ve completa, y el aviso queda perdido entre otros. Un
 * rechazo es recuperable en un minuto (se exporta el `.ev3`); una competencia
 * mal importada que parece correcta puede llegar hasta las inscripciones.
 *
 * Las validaciones de VALOR son otra cosa y siguen siendo tolerantes: un
 * código de estilo o de género desconocido salta esa prueba con un aviso que
 * lo nombra, y la importación continúa marcada como parcial. Ahí el layout es
 * el correcto y el problema está acotado a una línea.
 *
 * ---------------------------------------------------------------------------
 * GRAMÁTICA
 *
 * Texto CP1252 (ISO-8859-1), líneas CRLF, campos separados por punto y coma.
 * A diferencia del `.ev3`, las líneas **no** terminan en `*>` y **no** hay
 * suma de control por línea. Esa ausencia de `*>` es lo que separa los dos
 * formatos en `meet-file-detector.ts`.
 *
 * ENCABEZADO — 11 campos:
 *   [0]  nombre de la competencia
 *   [1]  fecha de inicio        (MM/DD/AAAA)
 *   [2]  fecha de término       (MM/DD/AAAA)
 *   [3]  fecha de corte de edad (MM/DD/AAAA) — mismo concepto que
 *        `Competition.ageCutoffDate` (RB-05); idéntica al campo [4] del `.ev3`
 *   [4]  código de una letra, sin identificar ("S" en la muestra; el `.ev3`
 *        lleva "SO" en la posición equivalente)
 *   [5]  recinto
 *   [6]  vacío
 *   [7]  identificador del fabricante ("Hy-Tek Sports Software")
 *   [8]  versión del exportador ("7.0Gb")
 *   [9]  código de dos letras, sin identificar ("CN" en la muestra)
 *   [10] serie o suma de control ("4138I"; el `.ev3` del mismo evento lleva
 *        "5186I"). NO se valida a propósito: calcularla mal rechazaría
 *        archivos buenos, y no aporta nada que el resto del parseo no cubra.
 *
 * LÍNEA DE PRUEBA — 18 campos:
 *   [0]  número de la prueba (orden en el programa)
 *   [1]  constante "F" en las 24 líneas. **NO es el género.** Se deja anotado
 *        porque es una trampa real: un parser que busque "el primer campo que
 *        valga F o M" leería esta columna y daría todas las pruebas como
 *        femeninas. El `.ev3` tiene el mismo constante "F", desplazado, en [2].
 *   [2]  género: "F" (damas) o "M" (varones). Alinea con "W"/"M" del `.ev3` en
 *        las 24 pruebas, 12 y 12. Ojo con la diferencia entre formatos: aquí
 *        las damas son "F", en el `.ev3` son "W".
 *   [3]  "I" (individual) o "R" (relevo) — alinea con [4] del `.ev3` en las 24
 *   [4]  "0" constante, sin identificar
 *   [5]  "0" constante, sin identificar
 *   [6]  distancia TOTAL en metros — alinea con [8] del `.ev3` en las 24,
 *        incluidos los relevos (200 para un 4×50), de acuerdo con la
 *        convención de `shared/relayDistance.util.ts`
 *   [7]  estilo, código numérico (ver abajo)
 *   [8]  [9] [10] vacíos
 *   [11] "0" constante, sin identificar
 *   [12]..[17] vacíos
 *
 * LO QUE ESTE FORMATO NO TRAE, comprobado y no supuesto:
 *
 *   - **Ni el día ni la jornada de cada prueba.** Se compararon las 12 pruebas
 *     del primer día contra las 12 del segundo buscando cualquier campo que
 *     las separase: en el `.ev3` hay tres ([21], [23] y la hora [24]); en el
 *     `.hyv`, ninguno. Y el evento SÍ tenía sesiones configuradas —el `.ev3`
 *     del mismo evento trae sus horas—, así que la omisión es del formato y no
 *     de una competencia mal armada. Por eso `sessionTime` queda siempre
 *     vacío: el importador lo traduce a una jornada sin especificar, con
 *     aviso, en vez de repartir las pruebas entre Mañana y Tarde inventando el
 *     dato.
 *   - **El número de postas de un relevo.** El `.ev3` lo trae en [29] (vale 4);
 *     en el `.hyv` no hay ningún campo que valga 4 en ninguna línea de relevo.
 *     Un total de 200 podría ser 4×50 o 2×100 en aritmética pura. Ver la nota
 *     sobre relevos en `meet-import.service.ts`, donde se explica por qué el
 *     modelo admite una sola lectura y cómo se avisa de ella.
 *   - **El rango de edad por prueba.** El `.ev3` lleva `0;109` (abierto) en
 *     cada línea; los campos equivalentes del `.hyv` valen `0;0`. Con una
 *     competencia de rango uniforme NO se puede determinar si el formato lo
 *     omite o lo codifica de otra forma. Queda sin resolver; hoy no afecta,
 *     porque el importador tampoco lee el rango del `.ev3`.
 *   - Piscina (SC/LC), club organizador, ciudad y país, que el `.ev3` sí trae.
 *     Ninguno se lee hoy en ninguno de los dos formatos.
 */

import { ValidationError } from "../../shared/errors";
import { parseUsDate, type ParsedGender, type ParsedMeet, type ParsedMeetEvent } from "./ev3-parser";

/**
 * Los fallos de este parser se lanzan como `ValidationError`, y no como
 * `Error` corriente, por una razón concreta: `describirFallo` en
 * `meet-import.service.ts` solo conserva el mensaje de un `ValidationError` al
 * anotar el intento fallido en `audit_logs`. De cualquier otro error guarda
 * únicamente la clase, porque un error de Prisma o del sistema de archivos
 * traería la consulta, los valores o rutas del servidor.
 *
 * Con `Error` corriente, el rechazo de un `.hyv` de otra versión llegaba bien
 * al usuario pero se registraba con `reason: null`: el día que aparezca ese
 * archivo, el registro no diría por qué se rechazó, que es exactamente el dato
 * que haría falta para incorporar su formato.
 *
 * Estos mensajes son texto escrito aquí, no contenido ajeno reproducido en
 * bruto: lo único que se interpola del archivo son cantidades de campos y la
 * versión declarada, que pasa antes por `valorEcoable`.
 */

/**
 * Prepara un valor leído del archivo para incluirlo en un mensaje que se
 * mostrará y se guardará. Acota la longitud y descarta caracteres de control:
 * el archivo lo sube el usuario, y `audit_logs` se expone por la API y se
 * exporta a planilla.
 */
function valorEcoable(valor: string): string {
  // Se filtra por punto de código y no con una expresión regular: escribir
  // caracteres de control dentro de un regex es justo lo que `no-control-regex`
  // señala como sospechoso, y aquí la intención se lee mejor así.
  const limpio = [...valor]
    .filter((caracter) => {
      const codigo = caracter.codePointAt(0)!;
      return codigo > 0x1f && codigo !== 0x7f;
    })
    .join("")
    .trim();
  return limpio.length > 40 ? `${limpio.slice(0, 40)}…` : limpio;
}

/** Única versión de Meet Manager contra la que se verificó esta gramática. */
export const HYV_VERSION_VERIFICADA = "7.0Gb";

/**
 * Cantidad EXACTA de campos de cada tipo de línea en el formato verificado.
 * No son un mínimo ni una orientación: un archivo que no los cumpla se
 * rechaza.
 */
export const CAMPOS_ENCABEZADO = 11;
export const CAMPOS_PRUEBA = 18;

/**
 * Qué hacer cuando el archivo no coincide con lo verificado.
 *
 * El mensaje va al usuario que subió el archivo, así que tiene que decir tres
 * cosas: qué se encontró, por qué no se importa, y qué puede hacer ahora. La
 * salida inmediata —exportar el mismo programa como `.ev3`— existe siempre,
 * porque Meet Manager ofrece los dos formatos.
 */
function rechazarPorDisposicion(queSeEncontro: string): never {
  throw new ValidationError(
    `${queSeEncontro} No se importó nada. ` +
      `El formato .hyv solo se ha verificado contra Meet Manager ${HYV_VERSION_VERIFICADA}, y leer una disposición distinta ` +
      "por posición produciría pruebas con distancias o estilos equivocados sin que se note. " +
      "Exporte el mismo programa como .ev3 (o el .zip que lo contiene), que sí se importa, " +
      "o informe este archivo al administrador para incorporar su formato."
  );
}

/**
 * Consulta una tabla de códigos SIN heredar de `Object.prototype`.
 *
 * Con `tabla[codigo]` a secas, un campo que valga "constructor" o "toString"
 * devuelve la propiedad heredada —una función, que es un valor verdadero— y el
 * código pasa por reconocido. El dato viene de un archivo subido, así que la
 * forma directa convierte un campo cualquiera en un estilo o un género
 * inventado. Se comprueba la propiedad propia antes de leerla.
 */
function buscar<T>(tabla: Record<string, T>, codigo: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(tabla, codigo) ? tabla[codigo] : undefined;
}

/**
 * Estilos. Los cinco códigos salen de alinear las 24 pruebas con el `.ev3`
 * pareado; cada uno quedó confirmado en al menos cuatro pruebas y en más de
 * una distancia, y la correspondencia es inyectiva (no hay dos letras en el
 * mismo número). Los nombres son los mismos que usa `ev3-parser.ts`, a
 * propósito: las dos rutas tienen que producir el mismo catálogo.
 */
const STROKE_CODE_TO_NAME: Record<string, string> = {
  "1": "Libre", // ↔ "A" del .ev3 — 8 pruebas, en 50, 100 y 200 m
  "2": "Espalda", // ↔ "B" — 4 pruebas, en 50 y 100 m
  "3": "Pecho", // ↔ "C" — 4 pruebas, en 50 y 100 m
  "4": "Mariposa", // ↔ "D" — 4 pruebas, en 50 y 100 m
  "5": "Combinado", // ↔ "E" — 4 pruebas, en 100 y 200 m
};

/**
 * Géneros. Solo se observaron estos dos, 12 pruebas cada uno.
 *
 * NO se agrega un código especulativo para "mixto". El `ev3-parser` contempla
 * una "X" que tampoco observó, y prefiero no repetir eso aquí: si aparece un
 * relevo mixto con un código desconocido, la prueba se salta con un aviso que
 * NOMBRA el código, que es justo lo que hace falta para aprenderlo del primer
 * archivo que lo traiga. Saltar una prueba deja la importación marcada como
 * parcial y es recuperable a mano; adivinar el significado, no.
 */
const GENDER_CODE_TO_VALUE: Record<string, ParsedGender> = {
  F: "female",
  M: "male",
};

/**
 * Parsea el contenido completo de un `.hyv` (ya leído como texto latin1).
 *
 * Mismo contrato que `parseEv3File`: lanza si el encabezado es ilegible —sin
 * encabezado no hay competencia que crear—, y ante una línea de prueba con
 * datos que no encajan la omite con una advertencia en vez de abortar el
 * archivo entero.
 */
export function parseHyvFile(content: string): ParsedMeet {
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) {
    throw new ValidationError("El archivo .hyv está vacío.");
  }

  const headerFields = lines[0]!.split(";");

  /**
   * La disposición se comprueba ANTES que cualquier dato.
   *
   * Si el encabezado no tiene la forma verificada, los valores que se leerían
   * de él no significan necesariamente lo que creemos, así que ni siquiera
   * tiene sentido informar sobre ellos.
   */
  if (headerFields.length !== CAMPOS_ENCABEZADO) {
    rechazarPorDisposicion(
      `El encabezado del archivo .hyv trae ${headerFields.length} campos y el formato verificado tiene ${CAMPOS_ENCABEZADO}.`
    );
  }

  const versionDeclarada = (headerFields[8] ?? "").trim();
  if (versionDeclarada !== HYV_VERSION_VERIFICADA) {
    const eco = valorEcoable(versionDeclarada);
    rechazarPorDisposicion(
      `El archivo .hyv declara la versión ${eco ? `"${eco}"` : "(ninguna)"} del exportador de Meet Manager.`
    );
  }

  const name = (headerFields[0] ?? "").trim();
  const startDate = parseUsDate(headerFields[1] ?? "");
  const endDate = parseUsDate(headerFields[2] ?? "");
  const ageCutoffDate = parseUsDate(headerFields[3] ?? "");

  const warnings: string[] = [];
  if (!name) warnings.push("No se pudo leer el nombre de la competencia desde el encabezado.");
  if (!startDate) {
    throw new ValidationError(`No se pudo leer la fecha de inicio de la competencia (valor: "${valorEcoable(headerFields[1] ?? "")}").`);
  }
  if (!endDate) {
    throw new ValidationError(`No se pudo leer la fecha de fin de la competencia (valor: "${valorEcoable(headerFields[2] ?? "")}").`);
  }
  if (!ageCutoffDate) {
    throw new ValidationError(`No se pudo leer la fecha de corte de edad (valor: "${valorEcoable(headerFields[3] ?? "")}").`);
  }

  const events: ParsedMeetEvent[] = [];

  for (let i = 1; i < lines.length; i++) {
    const fields = lines[i]!.split(";");
    const lineNumber = i + 1;

    /**
     * Basta UNA línea con otra disposición para rechazar el archivo entero.
     *
     * No se salta la línea y se sigue: si una tiene un número de campos
     * distinto, lo que cambió es la gramática, y las demás —que sí cuadran en
     * cantidad— podrían estar igual de desplazadas en significado sin que
     * nada lo delate.
     */
    if (fields.length !== CAMPOS_PRUEBA) {
      rechazarPorDisposicion(
        `La línea ${lineNumber} del archivo .hyv trae ${fields.length} campos y el formato verificado tiene ${CAMPOS_PRUEBA}.`
      );
    }

    const eventNumber = Number(fields[0]);
    const genderCode = fields[2];
    const typeFlag = fields[3];
    const distanceMeters = Number(fields[6]);
    const strokeCode = (fields[7] ?? "").trim();

    if (!fields[0]?.trim() || !Number.isFinite(eventNumber) || !Number.isInteger(eventNumber) || eventNumber <= 0) {
      warnings.push(`Línea ${lineNumber}: número de prueba ilegible ("${fields[0] ?? ""}"), se omite.`);
      continue;
    }
    if (typeFlag !== "I" && typeFlag !== "R") {
      warnings.push(`Prueba ${eventNumber}: tipo "${typeFlag ?? ""}" no reconocido (se esperaba I o R), se omite.`);
      continue;
    }
    const gender = genderCode ? buscar(GENDER_CODE_TO_VALUE, genderCode) : undefined;
    if (!gender) {
      warnings.push(
        `Prueba ${eventNumber}: género "${genderCode ?? ""}" no reconocido (se esperaba F o M), se omite. ` +
          "Cárguela manualmente e informe este código para incorporarlo."
      );
      continue;
    }
    if (!fields[6]?.trim() || !Number.isFinite(distanceMeters) || !Number.isInteger(distanceMeters) || distanceMeters <= 0) {
      warnings.push(`Prueba ${eventNumber}: distancia "${fields[6] ?? ""}" inválida, se omite.`);
      continue;
    }
    const strokeName = strokeCode ? buscar(STROKE_CODE_TO_NAME, strokeCode) : undefined;
    if (!strokeName) {
      warnings.push(
        `Prueba ${eventNumber}: código de estilo "${strokeCode}" no reconocido (se esperaba 1 a 5), se omite. ` +
          "Cárguela manualmente e informe este código para incorporarlo."
      );
      continue;
    }

    events.push({
      eventNumber,
      isRelay: typeFlag === "R",
      gender,
      distanceMeters,
      strokeName,
      /**
       * Vacío SIEMPRE, y es un dato, no una carencia del parser: se comprobó
       * campo por campo que este formato no lleva la hora ni nada que separe
       * una jornada de otra. El importador lo traduce a la jornada sin
       * especificar, con aviso.
       */
      sessionTime: "",
      /**
       * Por el mismo motivo se deja `eventDate` sin definir: no hay de dónde
       * sacarlo. `evaluarAsignacionPorDia` lo verá y mandará todas las pruebas
       * al primer día, avisando.
       */
    });
  }

  if (events.length === 0) {
    warnings.push("No se pudo interpretar ninguna prueba del archivo.");
  }

  return { name, startDate, endDate, ageCutoffDate, events, warnings };
}
