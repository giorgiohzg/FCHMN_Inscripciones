/**
 * C-02: claves del limitador de login y origen para límites, sin base de datos.
 * Direcciones SINTÉTICAS de documentación (192.0.2.0/24, 2001:db8::/32).
 */
import { describe, it, expect } from "vitest";
import {
  PERFIL,
  TECNICO,
  claveDe,
  claveDeBloqueo,
  clavesDeIntento,
  fragmentoDe,
  huellaDelSecreto,
  recursoDeFragmento,
} from "../src/modules/auth/limitadorClaves";
import { origenParaLimites } from "../src/shared/ipCliente";

const S = "secreto-sintetico-de-prueba-con-32-caracteres-o-mas";

describe("claves del limitador", () => {
  it("separan el propósito: el mismo texto da huellas distintas en cada tipo", () => {
    const valor = "192.0.2.10";
    const origen = claveDe(S, "origen", [valor]);
    const cuenta = claveDe(S, "cuenta", [valor]);
    expect(origen.equals(cuenta)).toBe(false);
  });

  it("el par depende de ambos valores y no se confunde al mover el separador", () => {
    const a = clavesDeIntento(S, "ana", "4:192.0.2.10");
    const b = clavesDeIntento(S, "ana4", ":192.0.2.10");
    expect(a.par.equals(b.par)).toBe(false);
    expect(a.cuenta.equals(clavesDeIntento(S, "ana", "4:192.0.2.99").cuenta), "la cuenta no depende del origen").toBe(true);
  });

  it("dependen del secreto y no contienen el valor en claro", () => {
    const a = claveDe(S, "cuenta", ["ana"]);
    const b = claveDe(`${S}-otro`, "cuenta", ["ana"]);
    expect(a.equals(b)).toBe(false);
    expect(a.toString("utf8")).not.toContain("ana");
    expect(a.length).toBe(32);
  });

  it("la huella identifica el secreto sin revelarlo", () => {
    expect(huellaDelSecreto(S).equals(huellaDelSecreto(S))).toBe(true);
    expect(huellaDelSecreto(S).equals(huellaDelSecreto(`${S}x`))).toBe(false);
    expect(huellaDelSecreto(S).length).toBe(8);
  });

  it("bloqueo y fragmento son estables y están en rango", () => {
    const c = claveDe(S, "par", ["ana", "4:192.0.2.10"]);
    expect(claveDeBloqueo(c)).toBe(claveDeBloqueo(Buffer.from(c)));
    const f = fragmentoDe(c);
    expect(f).toBeGreaterThanOrEqual(0);
    expect(f).toBeLessThan(TECNICO.fragmentos);
    expect(recursoDeFragmento(3)).toBe("claves:03");
  });

  it("el perfil aprobado (política B) es el que se aplica", () => {
    expect(PERFIL).toMatchObject({
      parMaxFallos: 5,
      parVentanaMs: 15 * 60_000,
      origenMaxFallos: 50,
      origenVentanaMs: 60 * 60_000,
      cuentaUmbralProteccion: 20,
      cuentaVentanaMs: 60 * 60_000,
      proteccionMs: 60 * 60_000,
      esperaProtegidaMs: 15 * 60_000,
    });
  });
});

describe("origenParaLimites", () => {
  it("IPv4 tal cual, y la IPv4 mapeada como IPv4", () => {
    expect(origenParaLimites("192.0.2.10", { fuente: "cf-connecting-ip" })).toBe("4:192.0.2.10");
    expect(origenParaLimites("::ffff:192.0.2.10", { fuente: "socket" })).toBe("4:192.0.2.10");
  });

  it("IPv6 agrupada por /64", () => {
    const a = origenParaLimites("2001:db8:1:2:aaaa::1", { fuente: "cf-connecting-ip" });
    const b = origenParaLimites("2001:DB8:1:2:ffff:ffff:ffff:ffff", { fuente: "cf-connecting-ip" });
    const otro = origenParaLimites("2001:db8:1:3::1", { fuente: "cf-connecting-ip" });
    expect(a).toBe("6:2001:db8:1:2::/64");
    expect(b, "el mismo /64 es el mismo origen").toBe(a);
    expect(otro).not.toBe(a);
  });

  it("el respaldo es UN origen compartido, sin valores del cliente", () => {
    expect(origenParaLimites("10.0.0.5", { fuente: "respaldo", motivo: "ausente" })).toBe("respaldo");
    expect(origenParaLimites("172.18.0.3", { fuente: "respaldo", motivo: "repetida" })).toBe("respaldo");
  });

  it("una dirección no analizable cae en otro origen compartido", () => {
    expect(origenParaLimites(undefined, undefined)).toBe("desconocido");
    expect(origenParaLimites("no-es-ip", undefined)).toBe("desconocido");
  });
});
