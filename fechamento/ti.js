/* Leitor de AFDT com sugestão de intervalos — réplica das regras do site da TI (http://10.85.0.22/Ponto_AFD/).
 * Regras ("Ver Regras" do site, documentadas em Leitor_AFDT_Observacoes.md):
 *  - Filtros: quantidade de batidas (par/ímpar/todas) e período de início (Manhã 04:00–12:00, Tarde 12:01–18:00, Noite 18:01–23:59).
 *  - Sábado e domingo: se já tem S01 e E02, nada. Até 6h: nada. >6h e ≤8h: 30 min. >8h: 1h.
 *    Tenta 12:00; se não couber, centraliza na jornada; sempre entre a 1ª e a última batida.
 *  - Segunda a sexta: jornada que começa de Manhã e termina depois das 22:00 → janta 19:00–19:30
 *    e inclusão de todas as batidas automáticas (pré-assinaladas) do dia.
 *  - Exporta só as correções aprovadas; uma linha por horário (PIS 11 + DDMMAAAA + HHMM).
 * AFDT do Fortes: registro 1 = cabeçalho (CNPJ, razão social, período, geração);
 * registro 2 = marcação: NSR(9) tipo(1) data(8) hora(4) PIS(12) REP(17) marcação(3: E01,S01,D01…) fonte(1: O original, I incluída, P automática).
 */
(function (root) {
  'use strict';
  const SEM = ['DOM', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SAB'];
  const FONTE = { O: 'original', I: 'incluída', P: 'automática' };
  const fmt = v => String(Math.floor(v / 60) % 24).padStart(2, '0') + ':' + String(v % 60).padStart(2, '0');
  const turno = m => (m >= 240 && m <= 720 ? 'Manhã' : m > 720 && m <= 1080 ? 'Tarde' : m > 1080 ? 'Noite' : '');

  function lerAFDTCompleto(texto) {
    const cab = {}, porPis = {};
    for (const l of texto.split(/\r?\n/)) {
      const tipo = l[9];
      if (tipo === '1') {
        cab.cnpj = l.slice(11, 25); cab.empresa = l.slice(37, 187).trim();
        const r = l.slice(187).trim();
        cab.ini = r.slice(0, 8); cab.fim = r.slice(8, 16); cab.geracao = r.slice(16, 28);
      } else if (tipo === '2' && l.length >= 55) {
        const marc = l.slice(51, 54);
        if (marc[0] === 'D') continue;                               // desconsiderada no Fortes
        const d = l.slice(10, 18), h = +l.slice(18, 20) * 60 + +l.slice(20, 22);
        const pis = l.slice(22, 34).replace(/^0/, '');
        const ts = Date.UTC(+d.slice(4), +d.slice(2, 4) - 1, +d.slice(0, 2)) / 60000 + h;
        (porPis[pis] = porPis[pis] || []).push({ ts, h, data: d, fonte: l[54], marc });
      }
    }
    // agrupa em jornadas pelo número da marcação do Fortes (turno da noite fica junto)
    const jornadas = [];
    for (const [pis, bs] of Object.entries(porPis)) {
      bs.sort((a, b) => a.ts - b.ts);
      let atual = null;
      for (const b of bs) {
        // o Fortes numera as marcações da jornada (E01, S01, E02…): cada E01 abre uma jornada nova
        if (!atual || b.marc === 'E01' || b.ts - atual.bat[atual.bat.length - 1].ts > 960) { atual = { pis, bat: [] }; jornadas.push(atual); }
        atual.bat.push(b);
      }
    }
    for (const j of jornadas) {
      const p = j.bat[0];
      j.data = p.data; j.dia = +p.data.slice(0, 2); j.mes = +p.data.slice(2, 4); j.ano = +p.data.slice(4);
      j.sem = SEM[new Date(Date.UTC(j.ano, j.mes - 1, j.dia)).getUTCDay()];
      j.turno = turno(p.h);
      j.trab = 0; for (let i = 0; i + 1 < j.bat.length; i += 2) j.trab += j.bat[i + 1].ts - j.bat[i].ts;
      j.correcoes = sugerir(j);
    }
    jornadas.sort((a, b) => a.pis.localeCompare(b.pis) || a.bat[0].ts - b.bat[0].ts);
    return { cab, jornadas };
  }

  function sugerir(j) {
    const ini = j.bat[0].ts, fim = j.bat[j.bat.length - 1].ts, base = Date.UTC(j.ano, j.mes - 1, j.dia) / 60000;
    if (j.sem === 'SAB' || j.sem === 'DOM') {
      if (j.bat.length >= 4) return [];                                // já tem S01 e E02
      const itv = j.trab > 480 ? 60 : j.trab > 360 ? 30 : 0;
      if (!itv) return [];
      let s = base + 720;
      if (s <= ini || s + itv >= fim) s = Math.floor((ini + fim - itv) / 2);
      return [s, s + itv].map(t => ({ h: fmt(t - base < 0 ? t - base + 1440 : t - base), ts: t, tipo: 'intervalo' }));
    }
    const ultima = fim - base;
    if (j.turno === 'Manhã' && ultima > 1320) {
      const auto = j.bat.filter(b => b.fonte === 'P').map(b => ({ h: fmt(b.h), ts: b.ts, tipo: 'automática' }));
      return [...auto, { h: '19:00', ts: base + 1140, tipo: 'janta' }, { h: '19:30', ts: base + 1170, tipo: 'janta' }];
    }
    return [];
  }

  // Linhas do AFDT tratado (só as aprovadas)
  function gerarTratado(jornadas) {
    const out = [];
    for (const j of jornadas.filter(x => x.aprovado && x.correcoes.length))
      for (const c of j.correcoes) {
        const d = new Date(c.ts * 60000);
        out.push(j.pis.padStart(11, '0').slice(-11) + String(d.getUTCDate()).padStart(2, '0') + String(d.getUTCMonth() + 1).padStart(2, '0') + d.getUTCFullYear() + c.h.replace(':', ''));
      }
    return out.join('\r\n') + (out.length ? '\r\n' : '');
  }
  const nomeArquivo = (cab, filial) => `AFDT_TRATADO_${filial}_${cab.ini}_${cab.fim}.txt`;

  const api = { lerAFDTCompleto, gerarTratado, nomeArquivo, FONTE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LeitorTI = api;
})(typeof window !== 'undefined' ? window : globalThis);
