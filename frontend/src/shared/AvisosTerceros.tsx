/**
 * Enlace visible a los avisos de terceros.
 *
 * POR QUE EXISTE. Cada visita descarga una copia del HTML, el CSS y el
 * JavaScript de esta aplicación, y ese JavaScript incluye código de terceros
 * bajo licencias que exigen conservar su atribución. Entregar el código sin
 * entregar los avisos incumple esas licencias.
 *
 * ALCANCE. El archivo enlazado cubre EXCLUSIVAMENTE lo que se envía al
 * navegador. El servidor web, sus módulos y los paquetes del sistema operativo
 * de la imagen se quedan en el servidor y tienen su propio aviso, que no se
 * expone aquí porque no se distribuye a quien visita.
 *
 * Es un ancla `<a>` corriente, no una ruta de React Router: el destino es un
 * archivo estático servido por nginx, no una vista de la aplicación.
 */

export const RUTA_AVISOS_TERCEROS = "/third-party-notices.txt";

export function AvisosTerceros({ className }: { className?: string }) {
  return (
    <a
      className={className}
      href={RUTA_AVISOS_TERCEROS}
      target="_blank"
      rel="noopener noreferrer"
      title="Licencias del software de terceros incluido en esta aplicación"
    >
      Avisos de terceros
    </a>
  );
}
