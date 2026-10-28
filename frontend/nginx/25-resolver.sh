#!/bin/sh
# =============================================================================
# RESOLUTOR DNS PARA EL PROXY DE LA API.
#
# La imagen oficial de Nginx ejecuta al arrancar todo lo que encuentre en
# /docker-entrypoint.d/, en orden. Este guion corre DESPUES de
# `20-envsubst-on-templates.sh`, que es el que completa la plantilla.
#
# POR QUE HACE FALTA, y conviene entenderlo porque no es evidente.
#
# `default.conf.template` NO escribe la direccion de la API dentro de
# `proxy_pass`, sino en una VARIABLE de Nginx. Eso es deliberado:
#
#   proxy_pass http://nombre-fijo;   Nginx resuelve el nombre UNA VEZ, al
#                                    arrancar, y se queda con esa IP para
#                                    siempre.
#   proxy_pass http://$variable;     Nginx resuelve en CADA peticion, y respeta
#                                    el tiempo de validez del DNS.
#
# La diferencia importa en cualquier plataforma donde el backend cambie de
# direccion al redesplegarse —que es lo normal en la nube—. Con la primera
# forma, la web seguiria enviando peticiones a una IP que ya no existe y
# devolveria 502 hasta que alguien reiniciara el frontend, sin ninguna pista
# de por que. Con la segunda, se entera sola.
#
# El precio de la segunda forma es que Nginx EXIGE una directiva `resolver`: se
# niega a arrancar con «no resolver defined to resolve ...». Y la direccion del
# servidor DNS no se puede saber al construir la imagen, porque depende de donde
# se ejecute: en Docker Compose es el DNS interno de Docker, en una plataforma
# de nube es el suyo.
#
# Por eso se lee aqui, al arrancar, de /etc/resolv.conf, que es donde el motor
# de contenedores deja esa informacion.
#
# SI NO SE ENCUENTRA NINGUN SERVIDOR, este guion no escribe nada y Nginx no
# arranca, con su propio mensaje de error. Es lo correcto: es preferible que el
# despliegue falle de forma ruidosa a que arranque una web que no puede hablar
# con su API.
# =============================================================================
set -eu

DESTINO=/etc/nginx/conf.d/00-resolver.conf

# Solo servidores IPv4: una direccion IPv6 necesita corchetes en la directiva
# `resolver`, y mezclarlas sin cuidado produce un error de sintaxis al arrancar.
# Si algun dia hiciera falta IPv6, hay que envolver cada direccion en [].
SERVIDORES=$(awk '/^nameserver/ && $2 !~ /:/ { printf "%s ", $2 }' /etc/resolv.conf 2>/dev/null || true)

if [ -z "$SERVIDORES" ]; then
  echo "25-resolver.sh: no hay ningun nameserver IPv4 en /etc/resolv.conf;" >&2
  echo "25-resolver.sh: no se escribe $DESTINO y Nginx fallara al arrancar." >&2
  exit 0
fi

# `valid=10s` acota cuanto se recuerda una respuesta: suficiente para no
# consultar en cada peticion, y lo bastante corto para seguir un redespliegue
# del backend sin intervencion.
{
  echo "# Generado al arrancar por /docker-entrypoint.d/25-resolver.sh"
  echo "# a partir de /etc/resolv.conf. No editar a mano."
  echo "resolver ${SERVIDORES}valid=10s;"
  echo "resolver_timeout 5s;"
} > "$DESTINO"

echo "25-resolver.sh: resolver configurado con ${SERVIDORES}"
