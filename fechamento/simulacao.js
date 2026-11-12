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

  // Ordem das batidas dentro do turno:
  //  - batidas do espelho: o Fortes já lista na ordem do turno → cada vez que o relógio "volta", virou o dia (off + 1);
  //  - batida nova puxada do dia seguinte para o turno (madrugada): off = 1;
  //  - batida nova no próprio dia: regra antiga (antes do início do turno − 6h = madrugada seguinte).
  // Antes tudo usava só a jornada cadastrada como referência: num turno da noite com jornada diurna, a batida das 02:00–07:00
  // ia para o COMEÇO do dia (pares trocados) e saía no AFDT com a data do dia anterior.
  const comOffsets = bat => { let off = 0, ant = -1; return bat.map(t => { if (t < ant) off++; ant = t; return { t, origem: 'espelho', off, esp: true }; }); };

  function simular({ espelho, itens = [], afdt = [], ignorar = [] }) {
    afdt = M.filtrarMes ? M.filtrarMes(afdt, espelho) : afdt;
    const p11 = M.pis11 || (s => String(s).slice(-11));
    const ign = new Set(ignorar), pis2cod = {};
    for (const [c, e] of Object.entries(espelho)) if (e.pis) pis2cod[p11(e.pis)] = c;
    const aprov = itens.filter(i => i.ok !== false);
    const chave = (c, d) => c + '|' + d, porDia = {};
    for (const it of aprov) (porDia[chave(it.cod, it.dia)] = porDia[chave(it.cod, it.dia)] || []).push(it);
    const naoInserir = new Set();
    for (const it of aprov) {
      for (const h of it.naoInserir || []) naoInserir.add(chave(it.cod, it.dia) + '|' + h);
      for (const [d, hs] of it.naoInserirDia || []) for (const h of hs) naoInserir.add(chave(it.cod, d) + '|' + h);
    }
    // empregado em turno da noite o mês todo com jornada diurna (a jornada vai ser trocada): as batidas do gestor não entram
    const trocaNoturno = new Set(aprov.filter(i => i.trocaJornada === 'noturno').map(i => i.cod));
    const trocaTarde = new Set(aprov.filter(i => i.trocaJornada === 'tarde').map(i => i.cod));
    // batidas novas (AFDT do app + aprovadas), por empregado e data de calendário
    const novas = {};
    const nova = (cod, dia, t, origem, fixo) => { (novas[cod] = novas[cod] || []).push({ dia, t, origem, fixo }); };
    for (const a of afdt) { const cod = pis2cod[p11(a.pis)]; if (cod && !ign.has(cod) && !trocaNoturno.has(cod)) nova(cod, a.dia, hm(a.hora), a.origem === 'HO' ? 'home office' : 'gestor'); }
    for (const it of aprov) for (const h of [].concat(it.afdt || [])) nova(it.cod, it.dia, hm(h), it.trafego ? 'viagem' : (it.origemAfdt || 'ferramenta'), true);

    const out = {};
    for (const [cod, e] of Object.entries(espelho)) {
      if (ign.has(cod)) continue;
      out[cod] = { codigo: cod, nome: e.nome, cargo: e.cargo, dias: {} };
      const troca = trocaNoturno.has(cod);
      // 1) batidas por dia: espelho + novas; batida de madrugada vai para o turno noturno do dia anterior
      const porData = {};
      for (const [k, d] of Object.entries(e.dias)) porData[k] = comOffsets(d.bat);
      if (troca) {
        // como vai ficar depois da troca de jornada: a batida da manhã (saída real) volta para o turno que começou na noite anterior;
        // as pré-assinaladas da jornada diurna somem
        for (const k of Object.keys(e.dias).map(Number).sort((x, y) => x - y)) {
          const d = e.dias[k], pre = new Set((e.prevSem[d.sem] || []).map(hm).slice(1, -1));
          let lst = porData[k].filter(b => !pre.has(b.t));
          const iN = lst.findIndex(b => b.t >= 1080);
          const lead = (iN < 0 ? lst : lst.slice(0, iN)).filter(b => b.t < 720 && b.off === 0);
          const antTemNoite = (porData[k - 1] || []).some(b => b.t >= 1080 && b.off === 0);
          if (lead.length && antTemNoite) {
            lst = lst.filter(b => !lead.includes(b));
            porData[k - 1].push(...lead.map(b => ({ ...b, off: 1, mov: true })));
          }
          let off = 0, ant = -1; for (const b of lst) { if (b.t < ant) off++; ant = b.t; b.off = off; }
          porData[k] = lst;
        }
      }
      const peso = n => (n.origem === 'gestor' ? 1 : 0) + (n.t < 720 ? 2 : 0);              // home office antes do gestor; madrugada por último
      const ns = (novas[cod] || []).slice().sort((a, b) => peso(a) - peso(b));
      for (const n of ns) {
        let dia = n.dia, off = 0;
        const ant = porData[dia - 1] || [], hoje = porData[dia] || [];
        // turno da noite = o turno do dia anterior COMEÇOU à noite (1ª batida da linha do Fortes, ou jornada noturna)
        const dAnt = e.dias[dia - 1], psAnt = dAnt ? (e.prevSem[dAnt.sem] || []).map(hm) : [];
        const comecouNoite = (ant[0] && ant[0].t >= 1080) || (psAnt[0] !== undefined && psAnt[0] >= 1080);
        if (!n.fixo && n.t < 720 && comecouNoite && !hoje.some(b => b.t >= 720 && b.t < 1080)) { dia = dia - 1; off = 1; }
        if (naoInserir.has(chave(cod, dia) + '|' + n.t) || naoInserir.has(chave(cod, n.dia) + '|' + n.t)) continue;
        const lst = porData[dia] = porData[dia] || [];
        const igual = lst.find(b => Math.abs(b.t - n.t) <= 1);
        if (igual) { if (igual.origem === 'espelho') igual.origem = n.origem; continue; }       // confirma batida que o espelho já tinha (ex.: pré-assinalada usada como real)
        // batida do gestor até 15 min de uma batida original: vale a original
        if (n.origem === 'gestor' && lst.some(b => b.origem !== 'gestor' && Math.abs(b.t - n.t) <= 15)) continue;
        // cal = dia de calendário da batida em relação ao dia do turno (0 = mesmo dia, 1 = dia seguinte). O AFDT sai com a data
        // REAL da batida do app; antes a data era deduzida da ordem no turno e uma batida do gestor às 00:00 mudava de dia.
        lst.push({ t: n.t, origem: n.origem, off, novo: true, cal: n.fixo ? undefined : n.dia - dia });
      }
      // 2) escala com Limite puxa as batidas da manhã seguinte para o turno (saída real depois do previsto)
      for (const it of aprov.filter(i => i.cod === cod && i.escala && i.escala.limite)) {
        const dia = it.escala.dia || it.dia, prox = porData[dia + 1] || [];
        const puxar = prox.filter(b => !b.off && b.t <= it.escala.limite);
        if (!puxar.length) continue;
        porData[dia + 1] = prox.filter(b => !puxar.includes(b));
        porData[dia] = (porData[dia] || []).concat(puxar.map(b => ({ ...b, off: 1, mov: true, cal: b.novo && b.cal !== undefined ? b.cal + 1 : b.cal })));
        porData[dia + 1].mexido = true;
      }
      for (const [k, d] of Object.entries(e.dias)) {
        const dia = +k, its = porDia[chave(cod, dia)] || [];
        const ps = (e.prevSem[d.sem] || []).map(hm), preVals = ps.slice(1, -1);
        const esc = its.find(i => i.escala);
        const desc = new Set(its.flatMap(i => i.desc || []));
        const base = inicioTurno(e, d);
        const lista = porData[k] || [];
        // (linha do espelho com as primeiras casas vazias — ex.: [----- 00:01 02:08 06:31] em jornada noturna — não mostra a virada: vale também a regra da jornada)
        const rDe = b => (b.novo && !b.off) ? rel(b.t, base) : b.t + 1440 * Math.max(b.off || 0, !b.mov && b.t < base - 360 ? 1 : 0);
        // dia em que NADA muda (sem batida nova, sem desconsiderar, sem escala): fica exatamente como o Fortes mostra.
        // Antes a simulação tirava as pré-assinaladas e refazia o intervalo também nesses dias — um dia com batida faltando
        // podia virar "ok" (e sumir das pendências) e um dia de licença com batidas mudava de trabalhado.
        const tocado = troca || !!esc || desc.size > 0 || lista.mexido || lista.length !== d.bat.length || lista.some(b => b.origem !== 'espelho' || b.mov);
        // 3) pré-assinaladas: o Fortes só preenche o intervalo previsto que as batidas reais não cobrem
        const comEscala = esc && esc.escala.tipo === 'X';
        // intervalo previsto do dia: o da escala (marcado como intervalo depois) ou o da jornada
        const preDoDia = troca ? [] : comEscala ? esc.escala.bat.slice(1, -1) : preVals;
        let bats;
        if (!tocado) bats = lista.map(b => ({ ...b, r: rDe(b), pre: preVals.includes(b.t) }));
        else {
          const reais = lista.filter(b => !(b.origem === 'espelho' && !b.mov && preVals.includes(b.t)) && !desc.has(b.t)).map(b => ({ ...b, r: rDe(b) }));
          bats = reais.slice();
          // (vale também para home office só com batidas do app: em set/2026 o Fortes pré-assinalou o intervalo do caso em 01 e 25/09)
          if (preDoDia.length && reais.length && reais.length < 4 && !/FERIADO|F[ÉE]RIAS|LICEN|AFAST/.test(d.det)) {
            const R = reais.map(b => b.r).sort((a, b) => a - b), ini = R[0], fim = R[R.length - 1];
            const rp = p => (p < ini ? p + 1440 : p);
            const dentro = preDoDia.filter(p => rp(p) > ini && rp(p) < fim && !R.some(r => Math.abs(r - rp(p)) <= 15));
            if (reais.length === 2) dentro.forEach(p => bats.push({ t: p, origem: 'automática', r: rp(p) }));
            else if (reais.length === 3) {
              const meio = R.slice(1, -1);
              const p = dentro.slice().sort((a, b) => Math.min(...meio.map(m => Math.abs(m - rp(b)))) - Math.min(...meio.map(m => Math.abs(m - rp(a)))))[0];
              if (p !== undefined) bats.push({ t: p, origem: 'automática', r: rp(p) });
            }
          }
        }
        bats.sort((a, b) => a.r - b.r);
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
        else if (troca) situacao = 'trocar jornada';            // HE/atraso só depois da jornada nova
        else { const x = trab - prev; if (fer || !prev) he = trab; else if (x > TOL) he = x; else if (x < -TOL) at = -x; }
        let trabFinal = par ? trab : null;
        if (!tocado && bats.length) {
          // nada muda neste dia: valem os números e a situação do próprio Fortes
          const falta = d.vazios.length > 0 || /AUS[ÊE]NCIA DE BATIDA/.test(d.det) || (!par && !/LICEN|AFAST|F[ÉE]RIAS|ATEST/.test(d.det));
          situacao = falta ? 'batida faltando' : 'ok';
          trabFinal = falta ? null : (hm(d.trab) || 0); he = falta ? 0 : (hm(d.hExtra) || 0); at = falta ? 0 : (hm(d.atSa) || 0);
        }
        if (trocaTarde.has(cod) && bats.length) { situacao = 'trocar jornada'; he = 0; at = 0; trabFinal = par ? trab : null; }
        const antes = d.bat.map(fmt).join(' '), depois = bats.map(b => fmt(b.t)).join(' ');
        out[cod].dias[dia] = {
          num: dia, sem: d.sem, det: d.det, antes, depois, bats, escala: escTxt,
          prevAntes: hm(d.prev) || 0, trabAntes: hm(d.trab) || 0, heAntes: hm(d.hExtra) || 0, atAntes: hm(d.atSa) || 0,
          prev, trab: trabFinal, he, at, feriado: fer, situacao,
          mudou: antes !== depois || !!escTxt || desc.size > 0
        };
      }
    }
    return out;
  }

  // Intervalos de sábado/domingo e janta — mesmas regras do site da TI, aplicadas ao dia já simulado
  function intervalosTI(sim, { comTrafego = new Set(), semJanta = new Set() } = {}) {
    const itens = [];
    for (const e of Object.values(sim)) for (const d of Object.values(e.dias)) {
      // feriado tem regra própria (motor: intervalo de feriado sem escala); dias sem cálculo ficam de fora
      if (comTrafego.has(e.codigo + '|' + d.num) || d.trab === null || !d.bats.length || d.feriado || d.situacao === 'trocar jornada') continue;
      const ini = d.bats[0].r, fim = d.bats[d.bats.length - 1].r, iniRelogio = d.bats[0].t;
      const base = { cat: CAT.IMPORTAR, cod: e.codigo, nome: e.nome, dia: d.num, sem: d.sem, espelho: d.antes, det: d.det, gestor: '', origemAfdt: 'intervalo (regra TI)' };
      if ((d.sem === 'SAB' || d.sem === 'DOM') && d.bats.length === 2) {
        const itv = d.trab > 480 ? 60 : d.trab > 360 ? 30 : 0; if (!itv) continue;
        let s = 720; if (s <= ini || s + itv >= fim) s = Math.floor((ini + fim - itv) / 2);
        itens.push({ ...base, tipo: 'Intervalo de sábado/domingo', acao: `Trabalhou ${dur(d.trab)} sem intervalo: AFDT ${fmt(s)} e ${fmt(s + itv)} (regra da TI: >6h 30 min, >8h 1h).`, afdt: [fmt(s), fmt(s + itv)] });
      } else if (d.sem !== 'SAB' && d.sem !== 'DOM' && !semJanta.has(e.codigo + '|' + d.num) && iniRelogio >= 240 && iniRelogio <= 720 && fim - ini + iniRelogio > 1320
        // se a pessoa já parou por volta das 19h (19:00 ou 19:30 fora de um período trabalhado), a janta já existe:
        // inserir 19:00/19:30 ali quebrava os pares do dia
        && d.bats.some((b, i) => i % 2 === 0 && d.bats[i + 1] && b.r <= 1140 && d.bats[i + 1].r >= 1170)) {
        const auto = d.bats.filter(b => b.origem === 'automática' || b.pre).map(b => fmt(b.t));
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
    const PEND = /Batida faltando|Dia inteiro sem batida|Batida inexistente|Feriado sem saída|Motorista com batida faltando|^Entrada faltando/;
    return itens.filter(it => {
      const d = sim[it.cod] && sim[it.cod].dias[it.dia]; if (!d) return true;
      if (PEND.test(it.tipo) && !it.escala && !it.afdt) {
        if (d.situacao === 'batida faltando') {
          // dia que era "sem batida" e passou a ter batidas do app em número ímpar (home office): dizer o que falta
          if (/Dia inteiro/.test(it.tipo) && d.bats.length) {
            it.tipo = 'Batida faltando (batidas do app)';
            it.acao = `Com as batidas do app o dia fica com ${d.bats.length}: ${d.depois}. Falta uma batida — qual? (Se o gestor lançou uma entrada que já existia, ela foi descartada.)`;
          }
          return true;
        }
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
