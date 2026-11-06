#!/bin/sh
# =============================================================================
# VALIDA `CSP_CONNECT_SRC` ANTES DE QUE NGINX ARRANQUE.
#
# La imagen oficial de Nginx ejecuta al arrancar todo lo que haya en
# /docker-entrypoint.d/, en orden. Este guion corre ANTES de
# `20-envsubst-on-templates.sh`, que es el que escribe la configuración.
#
# POR QUÉ HACE FALTA. `CSP_CONNECT_SRC` se copia TAL CUAL dentro de la cabecera
# `Content-Security-Policy`. Un valor mal escrito no hace fallar a Nginx: produce
# una política distinta de la prevista, o ninguna, y el síntoma es el peor
# posible: una web que carga y cuyas llamadas a la API el navegador bloquea sin
# más pista que la consola. Es preferible que el contenedor NO arranque, con un
# mensaje que diga qué corregir.
#
# QUÉ SE ACEPTA. Una lista, separada por espacios, de:
#   - `'self'` (con sus comillas simples);
#   - orígenes `http://`, `https://`, `ws://` o `wss://` con host y, si hace
#     falta, puerto. Sin ruta, sin consulta, sin comodines.
#
# QUÉ SE RECHAZA, con mensaje: valor vacío, `*`, `'unsafe-*'`, `data:`, `blob:`,
# `'none'`, esquemas sueltos, rutas, comillas dobles, `;`, `$`, barras invertidas
# y saltos de línea.
#
# COHERENCIA CON EL BUNDLE. `VITE_API_URL` se compila DENTRO del JavaScript; la
# imagen conserva su valor en `API_URL_COMPILADA`. Si es una dirección absoluta,
# su origen debe estar en `CSP_CONNECT_SRC`; si es relativa (`/api`) o vacía,
# debe estar `'self'`. De lo contrario el navegador bloquearía todas las
# llamadas a la API.
# =============================================================================
set -eu
# Sin expansión de nombres de archivo: `for token in $CSP` dejaría que un `*` se
# sustituyera por el contenido del directorio actual y el mensaje de error
# hablaría de archivos que nadie escribió.
set -f

CSP="${CSP_CONNECT_SRC-}"
COMPILADA="${API_URL_COMPILADA-}"
PREFIJO="18-validar-csp.sh:"

falla() {
  echo "$PREFIJO CSP_CONNECT_SRC no es válido: $1" >&2
  echo "$PREFIJO valor recibido: [$CSP]" >&2
  echo "$PREFIJO ejemplos válidos: 'self'   |   'self' https://api.ejemplo.cl" >&2
  exit 1
}

[ -n "$CSP" ] || falla "está vacío. Use 'self' si la API va bajo el mismo origen."

# Caracteres que romperían la cabecera o la plantilla de Nginx.
case "$CSP" in
  *\"* | *\;* | *\$* | *\\* | *\`*) falla "contiene comillas dobles, punto y coma, signo de dólar, barra invertida o acento grave." ;;
esac
LF="$(printf '\nx')"; LF="${LF%x}"
CR="$(printf '\rx')"; CR="${CR%x}"
case "$CSP" in
  *"$LF"* | *"$CR"*) falla "contiene saltos de línea." ;;
esac

TIENE_SELF=no
ORIGENES=" "
for token in $CSP; do
  case "$token" in
    "'self'") TIENE_SELF=si ;;
    *"*"*) falla "no admite comodines ($token)." ;;
    "'unsafe-"* | "'none'" | "'strict-dynamic'") falla "no admite $token." ;;
    data: | blob: | filesystem: | https: | http: | ws: | wss:) falla "no admite el esquema abierto $token." ;;
    http://* | https://* | ws://* | wss://*)
      resto="${token#*://}"
      case "$resto" in
        */* | *\?* | *\#*) falla "$token lleva ruta, consulta o fragmento: use solo el origen (esquema://host[:puerto])." ;;
      esac
      if ! printf '%s\n' "$resto" | grep -Eq '^([A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*(:[0-9]{1,5})?$|^\[[0-9A-Fa-f:]+\](:[0-9]{1,5})?$'; then
        falla "$token no es un origen válido."
      fi
      ORIGENES="$ORIGENES$token "
      ;;
    *) falla "no entiendo $token. Cada elemento debe ser 'self' o un origen http(s)/ws(s)." ;;
  esac
done

# Coherencia con la dirección de la API compilada en el bundle.
case "$COMPILADA" in
  "" | /*)
    [ "$TIENE_SELF" = si ] || falla "el bundle llama a la API por una ruta del mismo origen (VITE_API_URL=[$COMPILADA]) y falta 'self'."
    ;;
  http://* | https://*)
    origen="$(printf '%s\n' "$COMPILADA" | sed -E 's#^([A-Za-z]+://[^/?\#]+).*$#\1#')"
    case "$ORIGENES" in
      *" $origen "*) ;;
      *) falla "el bundle llama a la API en $origen (VITE_API_URL) y ese origen no figura en CSP_CONNECT_SRC: el navegador bloquearía todas las llamadas." ;;
    esac
    ;;
  *)
    falla "VITE_API_URL compilada no es una ruta ni un origen http(s): [$COMPILADA]."
    ;;
esac

echo "$PREFIJO CSP_CONNECT_SRC válido: $CSP"
