/* Espelho simulado: aplica sobre o espelho CRU (sem correções) tudo o que a ferramenta e o app trazem
 *  - batidas do AFDT do app (gestores e home office), menos as que não devem entrar;
 *  - batidas aprovadas (AFDT complementar, intervalos de viagem, feriado, sábado/janta);
 *  - batidas a desconsiderar; escalas (nova carga prevista) e folgas;
 * e recalcula TRAB, saldo, HE e AT/SA como o Fortes deve calcular (tolerância de 10 min).
 * Também gera os intervalos de sábado/domingo e janta (regras do site da TI) direto do espelho — sem o AFDT completo.
 * O cálculo oficial continua sendo do Fortes: isto é a previsão, conferida depois com o espelho real.
 */
(function (root) {
  'use strict';
  const M = typeof module !== 'undefined' && module.exports ? require('./motor.js') : root.Motor;
  const { hm, fmt, dur, CAT } = M;
  const TOL = 10;

  // início do turno do dia (jornada prevista; sem ela, a 1ª batida do espelho, que o Fortes já lista na ordem do turno)
  const inicioTurno = (e, d) => { const ps = (e.prevSem[d.sem] || []).map(hm); return ps.length ? ps[0] : (d.bat[0] !== undefined ? d.bat[0] : 0); };
  const rel = (t, base) => (t < base - 360 ? t + 1440 : t);

  function simular({ espelho, itens = [], afdt = [], ignorar = [] }) {
    const ign = new Set(ignorar), pis2cod = {};
    for (const [c, e] of Object.entries(espelho)) if (e.pis) pis2cod[e.pis.slice(-11)] = c;
    const aprov = itens.filter(i => i.ok !== false);
    const chave = (c, d) => c + '|' + d, porDia = {};
    for (const it of aprov) (porDia[chave(it.cod, it.dia)] = porDia[chave(it.cod, it.dia)] || []).push(it);
    const naoInserir = new Set();
    for (const it of aprov) {
      for (const h of it.naoInserir || []) naoInserir.add(chave(it.cod, it.dia) + '|' + h);
      for (const [d, hs] of it.naoInserirDia || []) for (const h of hs) naoInserir.add(chave(it.cod, d) + '|' + h);
    }
    // batidas novas (AFDT do app + aprovadas), por empregado e data de calendário
    const novas = {};
    const nova = (cod, dia, t, origem, fixo) => { (novas[cod] = novas[cod] || []).push({ dia, t, origem, fixo }); };
    for (const a of afdt) { const cod = pis2cod[a.pis.slice(-11)]; if (cod && !ign.has(cod)) nova(cod, a.dia, hm(a.hora), a.origem === 'HO' ? 'home office' : 'gestor'); }
    for (const it of aprov) for (const h of [].concat(it.afdt || [])) nova(it.cod, it.dia, hm(h), it.trafego ? 'viagem' : (it.origemAfdt || 'ferramenta'), true);

    const out = {};
    for (const [cod, e] of Object.entries(espelho)) {
      if (ign.has(cod)) continue;
      out[cod] = { codigo: cod, nome: e.nome, cargo: e.cargo, dias: {} };
      // 1) batidas por dia: espelho + novas; batida de madrugada vai para o turno noturno do dia anterior
      const porData = {};
      for (const [k, d] of Object.entries(e.dias)) porData[k] = d.bat.map(t => ({ t, origem: 'espelho' }));
      const peso = n => (n.origem === 'gestor' ? 1 : 0) + (n.t < 720 ? 2 : 0);              // home office antes do gestor; madrugada por último
      const ns = (novas[cod] || []).slice().sort((a, b) => peso(a) - peso(b));
      for (const n of ns) {
        let dia = n.dia;
        const ant = porData[dia - 1] || [], hoje = porData[dia] || [];
        if (!n.fixo && n.t < 720 && ant.some(b => b.t >= 1080) && !hoje.some(b => b.t >= 720 && b.t < 1080)) dia = dia - 1;
        if (naoInserir.has(chave(cod, dia) + '|' + n.t) || naoInserir.has(chave(cod, n.dia) + '|' + n.t)) continue;
        const lst = porData[dia] = porData[dia] || [];
        const igual = lst.find(b => Math.abs(b.t - n.t) <= 1);
        if (igual) { if (igual.origem === 'espelho') igual.origem = n.origem; continue; }       // confirma batida que o espelho já tinha (ex.: pré-assinalada usada como real)
        // batida do gestor até 15 min de uma batida original: vale a original
        if (n.origem === 'gestor' && lst.some(b => b.origem !== 'gestor' && Math.abs(b.t - n.t) <= 15)) continue;
        lst.push({ t: n.t, origem: n.origem });
      }
      // 2) escala com Limite puxa as batidas da manhã seguinte para o turno (caso Weides)
      for (const it of aprov.filter(i => i.cod === cod && i.escala && i.escala.limite)) {
        const dia = it.escala.dia || it.dia, prox = porData[dia + 1] || [];
        const puxar = prox.filter(b => b.t <= it.escala.limite);
        porData[dia + 1] = prox.filter(b => b.t > it.escala.limite);
        porData[dia] = (porData[dia] || []).concat(puxar);
      }
      for (const [k, d] of Object.entries(e.dias)) {
        const dia = +k, its = porDia[chave(cod, dia)] || [];
        const ps = (e.prevSem[d.sem] || []).map(hm), preVals = ps.slice(1, -1);
        const esc = its.find(i => i.escala);
        const desc = new Set(its.flatMap(i => i.desc || []));
        const base = inicioTurno(e, d);
        // 3) pré-assinaladas: o Fortes só preenche o intervalo previsto que as batidas reais não cobrem
        const comEscala = esc && esc.escala.tipo === 'X';
        // intervalo previsto do dia: o da escala (marcado como intervalo depois) ou o da jornada
        const preDoDia = comEscala ? esc.escala.bat.slice(1, -1) : preVals;
        let reais = (porData[k] || []).filter(b => !(b.origem === 'espelho' && preVals.includes(b.t)) && !desc.has(b.t));
        let bats = reais.slice();
        // pré-assinaladas: o Fortes só preenche o que falta do intervalo previsto
        if (preDoDia.length && reais.length && reais.length < 4 && !/FERIADO|F[ÉE]RIAS|LICEN|AFAST/.test(d.det)) {
          const R = reais.map(b => rel(b.t, base)).sort((a, b) => a - b), ini = R[0], fim = R[R.length - 1];
          const dentro = preDoDia.filter(p => rel(p, base) > ini && rel(p, base) < fim && !R.some(r => Math.abs(r - rel(p, base)) <= 15));
          if (reais.length === 2) dentro.forEach(p => bats.push({ t: p, origem: 'automática' }));
          else if (reais.length === 3) {
            const meio = R.slice(1, -1);
            const p = dentro.slice().sort((a, b) => Math.min(...meio.map(m => Math.abs(m - rel(b, base)))) - Math.min(...meio.map(m => Math.abs(m - rel(a, base)))))[0];
            if (p !== undefined) bats.push({ t: p, origem: 'automática' });
          }
        }
        bats = bats.map(b => ({ ...b, r: rel(b.t, base) })).sort((a, b) => a.r - b.r);
        // 4) prevista e cálculo
        let prev = hm(d.prev) || 0, escTxt = '';
        if (comEscala) { const eb = esc.escala.bat; prev = 0; for (let i = 0; i + 1 < eb.length; i += 2) prev += (eb[i + 1] - eb[i] + 1440) % 1440; escTxt = eb.map(fmt).join(' / '); }
        else if (esc && esc.escala.tipo === 'F') { prev = 0; escTxt = 'FOLGA'; }
        const fer = /FERIADO/.test(d.det); if (fer) prev = 0;
        const par = bats.length % 2 === 0;
        let trab = 0; if (par) for (let i = 0; i + 1 < bats.length; i += 2) trab += bats[i + 1].r - bats[i].r;
        const afast = /F[ÉE]RIAS|LICEN|AFAST|ATEST/.test(d.det) && !bats.length;
        let he = 0, at = 0, situacao = 'ok';
        if (!par) situacao = 'batida faltando';
        else if (!bats.length) situacao = afast ? 'afastamento' : (escTxt === 'FOLGA' || /FOLGA/.test(d.det) ? 'folga' : prev ? 'falta' : 'sem jornada');
        else { const x = trab - prev; if (fer || !prev) he = trab; else if (x > TOL) he = x; else if (x < -TOL) at = -x; }
        const antes = d.bat.map(fmt).join(' '), depois = bats.map(b => fmt(b.t)).join(' ');
        out[cod].dias[dia] = {
          num: dia, sem: d.sem, det: d.det, antes, depois, bats, escala: escTxt,
          prevAntes: hm(d.prev) || 0, trabAntes: hm(d.trab) || 0, heAntes: hm(d.hExtra) || 0, atAntes: hm(d.atSa) || 0,
          prev, trab: par ? trab : null, he, at, feriado: fer, situacao,
          mudou: antes !== depois || !!escTxt || desc.size > 0
        };
      }
    }
    return out;
  }

  // Intervalos de sábado/domingo e janta — mesmas regras do site da TI, aplicadas ao dia já simulado
  function intervalosTI(sim, { comTrafego = new Set() } = {}) {
    const itens = [];
    for (const e of Object.values(sim)) for (const d of Object.values(e.dias)) {
      if (comTrafego.has(e.codigo + '|' + d.num) || d.trab === null || !d.bats.length) continue;
      const ini = d.bats[0].r, fim = d.bats[d.bats.length - 1].r;
      const base = { cat: CAT.IMPORTAR, cod: e.codigo, nome: e.nome, dia: d.num, sem: d.sem, espelho: d.antes, det: d.det, gestor: '', origemAfdt: 'intervalo (regra TI)' };
      if ((d.sem === 'SAB' || d.sem === 'DOM') && d.bats.length === 2) {
        const itv = d.trab > 480 ? 60 : d.trab > 360 ? 30 : 0; if (!itv) continue;
        let s = 720; if (s <= ini || s + itv >= fim) s = Math.floor((ini + fim - itv) / 2);
        itens.push({ ...base, tipo: 'Intervalo de sábado/domingo', acao: `Trabalhou ${dur(d.trab)} sem intervalo: AFDT ${fmt(s)} e ${fmt(s + itv)} (regra da TI: >6h 30 min, >8h 1h).`, afdt: [fmt(s), fmt(s + itv)] });
      } else if (d.sem !== 'SAB' && d.sem !== 'DOM' && ini >= 240 && ini <= 720 && fim > 1320) {
        const auto = d.bats.filter(b => b.origem === 'automática').map(b => fmt(b.t));
        itens.push({ ...base, tipo: 'Janta (jornada até depois das 22h)', acao: `Começou de manhã e saiu ${fmt(fim)}: AFDT janta 19:00 e 19:30${auto.length ? ' + automáticas ' + auto.join(', ') : ''} (regra da TI).`, afdt: [...auto, '19:00', '19:30'] });
      }
    }
    return itens;
  }

  // Conferência: espelho real novo × simulado
  function conferir(sim, espelhoReal, { ignorar = [] } = {}) {
    const ign = new Set(ignorar), difs = [];
    for (const [cod, e] of Object.entries(espelhoReal)) {
      if (ign.has(cod) || !sim[cod]) continue;
      for (const [k, d] of Object.entries(e.dias)) {
        const s = sim[cod].dias[k]; if (!s) continue;
        const real = { bat: d.bat.map(fmt).join(' '), trab: hm(d.trab) || 0, he: hm(d.hExtra) || 0, at: hm(d.atSa) || 0 };
        const p = [];
        if (s.trab !== null && Math.abs(real.trab - s.trab) > 1) p.push(`TRAB ${dur(real.trab)} (esperado ${dur(s.trab)})`);
        if (Math.abs(real.he - s.he) > 1) p.push(`HE ${dur(real.he)} (esperado ${dur(s.he)})`);
        if (Math.abs(real.at - s.at) > 1) p.push(`AT ${dur(real.at)} (esperado ${dur(s.at)})`);
        if (/AUS/.test(d.det) || d.bat.length % 2) p.push('ainda com batida faltando');
        if (p.length) difs.push({ cat: CAT.VOCE, cod, nome: e.nome, dia: +k, sem: d.sem, espelho: real.bat, det: d.det, gestor: '',
          tipo: 'Diferente do simulado', acao: `${p.join(' · ')}. Simulado: ${s.depois || '—'}${s.escala ? ' (escala ' + s.escala + ')' : ''}.` });
      }
    }
    return difs;
  }

  // Pendências do espelho cru que a própria simulação resolve (batidas do AFDT do app, escalas, folgas) saem da lista;
  // apontamentos de cálculo do Fortes em dias que vão mudar também saem (o Fortes vai recalcular).
  function filtrarResolvidos(itens, sim) {
    const PEND = /Batida faltando|Dia inteiro sem batida|Batida inexistente|Feriado sem saída/;
    return itens.filter(it => {
      const d = sim[it.cod] && sim[it.cod].dias[it.dia]; if (!d) return true;
      if (PEND.test(it.tipo) && !it.escala && !it.afdt) {
        if (d.situacao === 'batida faltando') return true;
        if (/Dia inteiro/.test(it.tipo)) return !(d.bats.length || d.situacao === 'folga' || d.situacao === 'afastamento');
        return false;
      }
      if (/^5/.test(it.cat) && d.mudou) return false;
      return true;
    });
  }

  const api = { simular, intervalosTI, conferir, filtrarResolvidos };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Simulacao = api;
})(typeof window !== 'undefined' ? window : globalThis);
