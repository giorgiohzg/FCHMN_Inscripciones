/**
 * RUN SINTÉTICOS válidos para las pruebas: el cuerpo que se indique con su dígito verificador
 * (módulo 11), ya normalizado (sin puntos ni guion). Se reimplementa aquí a propósito, sin
 * importar `shared/run.util`, para que la prueba no dependa del código que comprueba.
 */
export function runValido(cuerpo: number | string): string {
  const digitos = String(cuerpo);
  let suma = 0;
  let factor = 2;
  for (let i = digitos.length - 1; i >= 0; i--) {
    suma += Number(digitos[i]) * factor;
    factor = factor === 7 ? 2 : factor + 1;
  }
  const resto = 11 - (suma % 11);
  const dv = resto === 11 ? "0" : resto === 10 ? "K" : String(resto);
  return `${digitos}${dv}`;
}

/** El mismo RUN con puntos y guion, como lo escribiría una persona. */
export function conFormato(run: string): string {
  const cuerpo = run.slice(0, -1).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${cuerpo}-${run.slice(-1)}`;
}
