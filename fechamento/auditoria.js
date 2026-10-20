/* Auditoria de cálculo do espelho (HE, AT/SA, Ad.Not, TRAB, faixas de HE).
 * Regras: SKILL conferidor de ponto + decisões do fechamento REC set/2026.
 * Depende do motor.js (Motor.hm/fmt/dur/CAT).
 */
(function (root) {
  'use strict';
  const M = typeof module !== 'undefined' && module.exports ? require('./motor.js') : root.Motor;
  const { hm, fmt, dur, CAT } = M;

  // Faixas de HE por filial. Chave = sigla escolhida na tela.
  const FAIXAS_HE = {
    REC: { ate2h: 50, exc: 70, excMot: 75 },
    ARU: { ate2h: 50, exc: 100, excMot: 100 },
    THE: { unica: 60 },
    NAT: { unica: 50, domingo: 100 },
    MOS: { unica: 50, domingo: 100 },
    OUTRA: { unica: 50 }
  };
  CAT.CALCULO = '5. Cálculo do Fortes';

  // Ad.Not sem hora reduzida: 22:00–05:00 de relógio + prorrogação após 05:00.
  // O Fortes só prorroga se a entrada foi até 22:00 (Paulo Ricardo 04/09 e Anderson 25/09/2026).
  function adNotEsperado(b, comoFortes = true) {
    if (b.length < 2 || b.length % 2) return null;
    const lin = []; let base = b[0];
    for (let i = 0; i < b.length; i += 2) {
      let a = b[i], f = b[i + 1];
      while (a < base) a += 1440;
      while (f < a) f += 1440;
      lin.push([a, f]); base = f;
    }
    let ini = 1320, fim = 1740;
    if (lin[0][0] < 300) { ini = -120; fim = 300; }
    const podeProrrogar = !comoFortes || lin[0][0] <= 1320 || lin[0][0] < 300;
    if (podeProrrogar && lin.some(([a, f]) => a < fim && f >= fim)) fim = Math.max(fim, lin[lin.length - 1][1]);
    return lin.reduce((s, [a, f]) => s + Math.max(0, Math.min(f, fim) - Math.max(a, ini)), 0);
  }

  function auditar(espelho, { filial = 'REC', ignorar = [] } = {}) {
    const faixa = FAIXAS_HE[filial] || FAIXAS_HE.OUTRA, ign = new Set(ignorar), itens = [];
    const add = (cat, e, d, tipo, acao, extra = {}) => itens.push({
      cat, cod: e.codigo, nome: e.nome, dia: d ? d.num : 0, sem: d ? d.sem : '',
      espelho: d ? d.txt : '', det: d ? d.det : '', tipo, acao, gestor: '', ...extra
    });
    for (const e of Object.values(espelho)) {
      if (ign.has(e.codigo)) continue;
      const mot = /MOT/i.test(e.cargo || '');
      const soma = { trab: 0, he: 0, at: 0, adn: 0 };
      let exp50 = 0, expExc = 0, expUnica = 0;
      for (const d of Object.values(e.dias)) {
        const v = k => hm(d[k]) || 0;
        const prev = v('prev'), trab = v('trab'), he = v('hExtra'), at = v('atSa'), ab = v('abono'), adn = v('adNot');
        soma.trab += trab; soma.he += he; soma.at += at; soma.adn += adn;
        const fer = /FERIADO/.test(d.det), b = d.bat, pct = String(d.hExtra || '').match(/\((\d+)%\)/);
        const nums = `PREV ${d.prev || '-'} · TRAB ${d.trab || '-'} · HE ${d.hExtra || '-'} · AT ${d.atSa || '-'} · Ad.Not ${d.adNot || '-'}`;

        if (b.length >= 2 && b.length % 2 === 0) {
          let calc = 0;
          for (let i = 0; i < b.length; i += 2) calc += (b[i + 1] - b[i] + 1440) % 1440;
          if (Math.abs(calc - trab) > 1) add(CAT.CALCULO, e, d, 'TRAB diferente das batidas', `Fortes ${dur(trab)} × batidas ${dur(calc)}. Reprocessar o dia.`, { nums });
          const an = adNotEsperado(b, true), anLegal = adNotEsperado(b, false);
          if (an !== null && Math.abs(an - adn) > 5) add(CAT.CALCULO, e, d, 'Adicional noturno diferente', `Esperado ${dur(an)}, Fortes ${dur(adn)}.`, { nums });
          else if (anLegal !== null && anLegal - adn > 5) add(CAT.CALCULO, e, d, 'Adicional noturno sem prorrogação', `Entrada depois das 22:00: o Fortes não prorrogou. Com prorrogação seriam ${dur(anLegal)} (Fortes ${dur(adn)}). Decidir se corrige com escala (entrada 22:00).`, { nums });
        }
        if (fer) {
          if (trab && !he) add(CAT.CALCULO, e, d, 'Feriado trabalhado sem HE', `Esperado HE 100% = ${dur(trab)}.`, { nums });
          else if (he && (!pct || pct[1] !== '100')) add(CAT.CALCULO, e, d, 'Feriado com HE diferente de 100%', 'Conferir o cadastro do feriado e reprocessar.', { nums });
          continue;
        }
        if (!trab && !prev) continue;
        const x = trab - prev;
        if (prev && trab) {
          if (x > 10 && Math.abs(he - x) > 1) {
            if (he > x && d.sem === 'SAB' && b.length === 4) {
              // sábado: bloco fora da janela pago como HE cheia → escala que fecha a PREV (skill fortes-ponto-correcao-he-escala)
              const s2 = b[2] + (prev - (b[1] - b[0]));
              const escala = { tipo: 'X', bat: [b[0], b[1], b[2], s2] };
              add(CAT.IMPORTAR, e, d, 'HE de sábado acima do saldo', `HE ${dur(he)}, correta ${dur(x)}. Escala do mês: ${escala.bat.map(fmt).join(' / ')} (fecha a PREV ${dur(prev)}). Marcar E1/S2 flexíveis e S1/E2 como intervalo.`, { nums, escala });
            } else add(CAT.CALCULO, e, d, he > x ? 'HE paga a mais' : 'HE paga a menos', `Saldo ${dur(x)}, HE ${dur(he)}.`, { nums });
          }
          if (x < -10 && at && Math.abs(at - (-x)) > 1 && !(ab && Math.abs(at - ab) <= 1)) add(CAT.CALCULO, e, d, 'AT/SA diferente do saldo', `Saldo ${dur(x)}, AT ${dur(at)}.`, { nums });
          if (he && at) add(CAT.CALCULO, e, d, 'HE e AT no mesmo dia', 'Indício de batida duplicada ou fora de ordem.', { nums });
          if (at >= 120 && b.some((t, i) => i && (t - b[i - 1] + 1440) % 1440 <= 15)) add(CAT.CALCULO, e, d, 'Atraso grande com batida duplicada', 'Provável batida duplicada — não é atraso real.', { nums });
        }
        if (he && (!pct || pct[1] !== '100')) {
          if (faixa.unica) expUnica += he;
          else { exp50 += Math.min(he, 120); expExc += Math.max(0, he - 120); }
        }
      }
      // calibração: soma dos dias × rodapé
      const T = e.tot || {};
      for (const [k, s] of [['Trabalhadas', 'trab'], ['Horas Extras(Total)', 'he'], ['Atrasos e SA', 'at'], ['Adicionais Noturnos', 'adn']])
        if (k in T && Math.abs(T[k] - soma[s]) > 2) add(CAT.CALCULO, e, null, 'Leitura do PDF não fecha', `${k}: soma dos dias ${dur(soma[s])} × rodapé ${dur(T[k])}. Não confiar nos apontamentos deste empregado.`);
      // faixas de HE da filial
      const h = p => T['Horas Extras(' + p + '%)'] || 0;
      if (faixa.unica) {
        if (Math.abs(h(faixa.unica) - expUnica) > 2) add(CAT.CALCULO, e, null, 'Faixa de HE errada', `Esperado ${faixa.unica}% = ${dur(expUnica)}; rodapé ${dur(h(faixa.unica))}.`);
      } else {
        const pe = mot ? faixa.excMot : faixa.exc;
        if (Math.abs(h(50) - exp50) > 2 || Math.abs(h(pe) - expExc) > 2)
          add(CAT.CALCULO, e, null, 'Faixa de HE errada', `Esperado 50% = ${dur(exp50)} e ${pe}% = ${dur(expExc)}${mot ? ' (motorista)' : ''}; rodapé 50% = ${dur(h(50))}, ${pe}% = ${dur(h(pe))}.`);
      }
    }
    return itens;
  }

  const api = { auditar, adNotEsperado, FAIXAS_HE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Auditoria = api;
})(typeof window !== 'undefined' ? window : globalThis);
