/**
 * `setupFiles` de la suite de integración: se ejecuta dentro de CADA worker,
 * antes de importar los archivos de prueba.
 *
 * El `globalSetup` corre en otro proceso, así que sus variables de entorno no
 * llegan hasta aquí: hay que volver a cargar `.env.test` y revalidar el
 * destino antes de que cualquier prueba importe `src/shared/prisma.client`.
 */
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { assertDisposableDatabase } from "./testDb";

loadEnv({ path: resolve(__dirname, "../../.env.test"), override: true });
assertDisposableDatabase();
