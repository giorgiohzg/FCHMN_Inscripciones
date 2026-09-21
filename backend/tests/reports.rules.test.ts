import { describe, it, expect } from "vitest";
import { mapIndividualRegistrationToRow, mapRelayRegistrationToRow, escapeCsvValue, rowsToCsv, groupReportByClubAndSwimmer, type SwimmerEventEntry } from "../src/modules/reports/reports.rules";

describe("reports.rules — mapIndividualRegistrationToRow", () => {
  it("formatea correctamente todas las columnas mínimas exigidas (sección 16)", () => {
    const row = mapIndividualRegistrationToRow({
      competitionName: "Campeonato Nacional Máster 2026",
      clubName: "Club Deportivo Delfines",
      personRun: "11.111.111-1",
      personFullName: "María José Pérez",
      personBirthDate: new Date("2000-03-15"),
      categoryName: "25-29",
      distanceMeters: 50,
      strokeName: "Libre",
      gender: "female",
      sessionDate: new Date("2026-08-15"),
      sessionTypeName: "Mañana",
      testTypeName: "Individual",
    });

    expect(row).toEqual({
      competencia: "Campeonato Nacional Máster 2026",
      club: "Club Deportivo Delfines",
      run: "11.111.111-1",
      nombreCompleto: "María José Pérez",
      fechaNacimiento: "15-03-2000",
      categoria: "25-29",
      prueba: "50m Libre",
      distancia: "50m",
      estilo: "Libre",
      genero: "Damas",
      fecha: "15-08-2026",
      jornada: "Mañana",
      tipoDePrueba: "Individual",
    });
  });

  it("traduce correctamente los tres valores de género", () => {
    const base = {
      competitionName: "C", clubName: "K", personRun: "1-9", personFullName: "N",
      personBirthDate: new Date("2000-01-01"), categoryName: "Cat", distanceMeters: 50,
      strokeName: "Libre", sessionDate: new Date("2026-01-01"), sessionTypeName: "Mañana", testTypeName: "Individual",
    };
    expect(mapIndividualRegistrationToRow({ ...base, gender: "male" }).genero).toBe("Varones");
    expect(mapIndividualRegistrationToRow({ ...base, gender: "female" }).genero).toBe("Damas");
    expect(mapIndividualRegistrationToRow({ ...base, gender: "mixed" }).genero).toBe("Mixto");
  });
});

describe("reports.rules — mapRelayRegistrationToRow", () => {
  it("formatea correctamente el equipo y sus 4 integrantes", () => {
    const row = mapRelayRegistrationToRow({
      competitionName: "Campeonato Nacional Máster 2026",
      clubName: "Club Deportivo Delfines",
      categoryName: "Relevo Mixto A",
      distanceMeters: 200,
      strokeName: "Libre",
      gender: "mixed",
      sessionDate: new Date("2026-08-15"),
      sessionTypeName: "Mañana",
      memberFullNames: ["Nadador 1", "Nadador 2", "Nadador 3", "Nadador 4"],
    });

    expect(row.equipoClub).toBe("Club Deportivo Delfines");
    expect(row.prueba).toBe("200m Libre");
    expect(row.integrante1).toBe("Nadador 1");
    expect(row.integrante4).toBe("Nadador 4");
  });

  it("no falla si por alguna razón llegan menos de 4 nombres (defensivo)", () => {
    const row = mapRelayRegistrationToRow({
      competitionName: "C", clubName: "K", categoryName: "Cat", distanceMeters: 200, strokeName: "Libre",
      gender: "mixed", sessionDate: new Date("2026-01-01"), sessionTypeName: "Mañana",
      memberFullNames: ["Solo Uno"],
    });
    expect(row.integrante1).toBe("Solo Uno");
    expect(row.integrante2).toBe("");
    expect(row.integrante4).toBe("");
  });
});

describe("reports.rules — escapeCsvValue / rowsToCsv", () => {
  it("no modifica valores simples sin caracteres especiales", () => {
    expect(escapeCsvValue("Club Delfines")).toBe("Club Delfines");
  });

  it("envuelve en comillas y escapa comillas internas si el valor contiene coma", () => {
    expect(escapeCsvValue("Pérez, María")).toBe('"Pérez, María"');
  });

  it('escapa comillas dobles duplicándolas', () => {
    expect(escapeCsvValue('Club "Los Delfines"')).toBe('"Club ""Los Delfines"""');
  });

  it("genera un CSV válido con encabezados y filas", () => {
    const csv = rowsToCsv(["Nombre", "Club"], [["María, Pérez", "Delfines"], ["Pedro", 'Club "Norte"']]);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("Nombre,Club");
    expect(lines[1]).toBe('"María, Pérez",Delfines');
    expect(lines[2]).toBe('Pedro,"Club ""Norte"""');
  });
});

describe("reports.rules — groupReportByClubAndSwimmer", () => {
  const cutoff = new Date("2026-12-31T00:00:00Z");

  function entry(overrides: Partial<SwimmerEventEntry> = {}): SwimmerEventEntry {
    return {
      personId: "p1",
      run: "11.111.111-1",
      fullName: "María Pérez",
      clubName: "Delfines",
      birthDate: new Date("2000-03-15T00:00:00Z"),
      gender: "female",
      categoryName: "25-29",
      eventNumber: 3,
      eventLabel: "50m Libre",
      timeLabel: "0:35,10",
      kind: "individual",
      ...overrides,
    };
  }

  it("agrupa por club como subtítulo y por nadador dentro de cada club", () => {
    const groups = groupReportByClubAndSwimmer([entry()], cutoff);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.clubName).toBe("Delfines");
    expect(groups[0]!.swimmers).toHaveLength(1);
    expect(groups[0]!.swimmers[0]!.run).toBe("11.111.111-1");
    expect(groups[0]!.swimmers[0]!.nombreCompleto).toBe("María Pérez");
  });

  it("calcula la edad respecto a la fecha de corte entregada, no a la fecha actual", () => {
    const groups = groupReportByClubAndSwimmer([entry({ birthDate: new Date("2000-03-15T00:00:00Z") })], cutoff);
    expect(groups[0]!.swimmers[0]!.edad).toBe(26); // cumplió 26 el 15-mar-2026, antes del corte 31-dic-2026
  });

  it("separa el número de prueba del texto (para mostrarlo en un círculo aparte), y el tiempo va con un espacio (no con guion)", () => {
    const groups = groupReportByClubAndSwimmer([entry({ eventNumber: 5, eventLabel: "50m Libre", timeLabel: "0:35,10" })], cutoff);
    expect(groups[0]!.swimmers[0]!.pruebas).toEqual([{ number: 5, text: "50m Libre 0:35,10" }]);
  });

  it("si no hay tiempo ingresado, no agrega espacio ni guion colgante", () => {
    const groups = groupReportByClubAndSwimmer([entry({ eventNumber: 5, eventLabel: "50m Libre", timeLabel: null })], cutoff);
    expect(groups[0]!.swimmers[0]!.pruebas).toEqual([{ number: 5, text: "50m Libre" }]);
  });

  it("si la prueba no tiene número asignado, el número queda en null (nunca se antepone entre paréntesis en el texto)", () => {
    const groups = groupReportByClubAndSwimmer([entry({ eventNumber: null, eventLabel: "50m Libre", timeLabel: "0:35,10" })], cutoff);
    expect(groups[0]!.swimmers[0]!.pruebas).toEqual([{ number: null, text: "50m Libre 0:35,10" }]);
  });

  it("combina en una sola línea por nadador sus pruebas individuales y sus relevos", () => {
    const groups = groupReportByClubAndSwimmer(
      [
        entry({ eventNumber: 1, eventLabel: "50m Libre", timeLabel: "0:35,10", kind: "individual" }),
        entry({ eventNumber: 4, eventLabel: "100m Espalda", timeLabel: null, kind: "individual" }),
        entry({ eventNumber: 12, eventLabel: "Relevo 100m Combinado (Mixto)", timeLabel: "5:10,00", kind: "relay" }),
      ],
      cutoff
    );
    expect(groups[0]!.swimmers).toHaveLength(1);
    const s = groups[0]!.swimmers[0]!;
    expect(s.pruebas).toEqual([
      { number: 1, text: "50m Libre 0:35,10" },
      { number: 4, text: "100m Espalda" },
    ]);
    expect(s.relevos).toEqual([{ number: 12, text: "Relevo 100m Combinado (Mixto) 5:10,00" }]);
  });

  it("prioriza la categoría de la prueba individual por sobre la del relevo cuando el nadador tiene ambas", () => {
    const groups = groupReportByClubAndSwimmer(
      [
        entry({ categoryName: "25-29", kind: "individual" }),
        entry({ categoryName: "80-99", kind: "relay" }), // categoría de equipo, por edad combinada
      ],
      cutoff
    );
    expect(groups[0]!.swimmers[0]!.categoria).toBe("25-29");
  });

  it("un nadador que solo aparece en relevos también recibe edad y género correctos", () => {
    const groups = groupReportByClubAndSwimmer(
      [entry({ kind: "relay", eventNumber: 12, eventLabel: "Relevo 100m Combinado (Mixto)", categoryName: "80-99", gender: "male" })],
      cutoff
    );
    expect(groups[0]!.swimmers[0]!.genero).toBe("Varones");
    expect(groups[0]!.swimmers[0]!.relevos).toEqual([{ number: 12, text: "Relevo 100m Combinado (Mixto) 0:35,10" }]);
    expect(groups[0]!.swimmers[0]!.pruebas).toEqual([]);
  });

  it("ordena los clubes alfabéticamente (los nadadores, en caso de empate de edad, se ordenan alfabéticamente)", () => {
    const groups = groupReportByClubAndSwimmer(
      [
        entry({ personId: "p1", fullName: "Zoe Soto", clubName: "Norte", run: "1" }),
        entry({ personId: "p2", fullName: "Ana Rojas", clubName: "Norte", run: "2" }),
        entry({ personId: "p3", fullName: "Bruno Díaz", clubName: "Austral", run: "3" }),
      ],
      cutoff
    );
    expect(groups.map((g) => g.clubName)).toEqual(["Austral", "Norte"]);
    expect(groups.find((g) => g.clubName === "Norte")!.swimmers.map((s) => s.nombreCompleto)).toEqual(["Ana Rojas", "Zoe Soto"]);
  });

  it("ordena a los nadadores del club por edad (de menor a mayor)", () => {
    const groups = groupReportByClubAndSwimmer(
      [
        entry({ personId: "p1", fullName: "Nadador Mayor", run: "1", birthDate: new Date("1980-01-01T00:00:00Z") }),
        entry({ personId: "p2", fullName: "Nadador Joven", run: "2", birthDate: new Date("2010-01-01T00:00:00Z") }),
        entry({ personId: "p3", fullName: "Nadador Medio", run: "3", birthDate: new Date("2000-01-01T00:00:00Z") }),
      ],
      cutoff
    );
    expect(groups[0]!.swimmers.map((s) => s.nombreCompleto)).toEqual(["Nadador Joven", "Nadador Medio", "Nadador Mayor"]);
    expect(groups[0]!.swimmers.map((s) => s.edad)).toEqual([16, 26, 46]);
  });

  it("calcula los totales del club: nadadores, pruebas individuales inscritas y equipos de relevo", () => {
    const groups = groupReportByClubAndSwimmer(
      [
        entry({ personId: "p1", fullName: "Ana Rojas", run: "1", kind: "individual" }),
        entry({ personId: "p1", fullName: "Ana Rojas", run: "1", eventNumber: 2, eventLabel: "100m Espalda", kind: "individual" }),
        entry({ personId: "p2", fullName: "Bruno Díaz", run: "2", kind: "individual" }),
      ],
      cutoff,
      new Map([["Delfines", 3]]) // 3 equipos de relevo del club, conteo real (no derivable de `relevos` por nadador)
    );
    const club = groups[0]!;
    expect(club.totalNadadores).toBe(2);
    expect(club.totalPruebasIndividuales).toBe(3);
    expect(club.totalRelevos).toBe(3);
  });

  it("el total de relevos es 0 si no se entrega el conteo por club", () => {
    const groups = groupReportByClubAndSwimmer([entry()], cutoff);
    expect(groups[0]!.totalRelevos).toBe(0);
  });
});
