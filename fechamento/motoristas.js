/* Motoristas — planilha de viagens do tráfego (.xlsb/.xlsx).
 * Skill "motoristas-viagens": Movimento 1 (intervalos), Movimento 2 (AFDT), Movimento 3 (tempo de espera).
 * Regra do Breno: batida original do relógio sempre prevalece; sem ela, usar a planilha (início/fim da viagem).
 */
(function (root) {
  'use strict';
  const M = typeof module !== 'undefined' && module.exports ? require('./motor.js') : root.Motor;
  const { fmt, dur, CAT } = M;
  const serial = v => (typeof v === 'number' ? v : null);
  const dataDe = v => { const d = new Date(Math.round((v - 25569) * 86400000)); return { dia: d.getUTCDate(), mes: d.getUTCMonth() + 1, min: d.getUTCHours() * 60 + d.getUTCMinutes() }; };
  const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();

  // rows = linhas da planilha (header na 1a linha), valores numéricos (serial do Excel) nas datas/tempos
  function lerViagens(rows) {
    const h = rows[0].map(norm);
    const ix = t => h.findIndex(x => x.includes(t));
    const iM = ix('MOTORISTA'), iI = ix('INICIO'), iF = ix('FINAL'), iR = ix('REINICIO');
    const iC = ix('CARGA/DESCARGA'), iP = ix('POSTO FISCAL'), iD = ix('DESCANSO');
    return rows.slice(1).filter(r => r && r[iM] && serial(r[iI])).map(r => ({
      motorista: norm(r[iM]), ini: serial(r[iI]), fim: serial(r[iF]), reinicio: serial(r[iR]),
      carga: (+r[iC] || 0) * 1440, posto: (+r[iP] || 0) * 1440, descanso: (+r[iD] || 0) * 1440
    }));
  }

  // afdt = batidas do AFDT do app (gestores): usadas como entrada/saída quando o relógio não tem a batida
  function analisarMotoristas(viagens, espelho, { mes, ano, ignorar = [], afdt = [] } = {}) {
    const porNome = {}; for (const e of Object.values(espelho)) porNome[norm(e.nome)] = e;
    const ign = new Set(ignorar), itens = [], porDia = {};
    for (const v of viagens) {
      const d = dataDe(v.ini); if (mes && d.mes !== mes) continue;
      const k = v.motorista + '|' + d.dia;
      const x = porDia[k] = porDia[k] || { motorista: v.motorista, dia: d.dia, carga: 0, posto: 0, descanso: 0, ultimoFim: null, primeiroIni: null };
      x.carga += v.carga; x.posto += v.posto; x.descanso += v.descanso;
      if (v.fim && (!x.ultimoFim || v.fim > x.ultimoFim)) x.ultimoFim = v.fim;
      if (!x.primeiroIni || v.ini < x.primeiroIni) x.primeiroIni = v.ini;
    }
    // batidas informadas pelo gestor (AFDT do app), por empregado/dia
    const p11 = M.pis11 || (s => String(s).slice(-11)), p2c = {}, lanc = {};
    for (const e of Object.values(espelho)) if (e.pis) p2c[p11(e.pis)] = e.codigo;
    for (const a of (M.filtrarMes ? M.filtrarMes(afdt, espelho) : afdt)) { const c = p2c[p11(a.pis)]; if (c && a.origem !== 'HO') (lanc[c + '|' + a.dia] = lanc[c + '|' + a.dia] || []).push(M.hm(a.hora)); }
    const diasViagem = new Set();
    const iniMin = x => dataDe(x.primeiroIni).min;
    // fim da viagem na linha do tempo do dia da viagem (pode terminar no dia seguinte)
    const fimMin = x => { if (!x.ultimoFim) return null; const f = dataDe(x.ultimoFim); return f.min + (f.dia !== x.dia ? 1440 : 0); };
    // batidas reais do dia na ordem do turno, sem as pré-assinaladas (cada vez que o relógio "volta", virou o dia)
    const reaisDe = (e, dd) => {
      const ps = (e.prevSem[dd.sem] || []).map(M.hm), pre = new Set(ps.slice(1, -1));
      let off = 0, ant = -1; const out = [];
      for (const t of (dd.bat || []).filter(t => !pre.has(t))) { if (t < ant) off++; ant = t; out.push(t + 1440 * off); }
      return out;
    };
    const espera = {};                               // Movimento 3
    for (const x of Object.values(porDia)) {
      const e = porNome[x.motorista];
      const es = espera[x.motorista] = espera[x.motorista] || { nome: x.motorista, codigo: e ? e.codigo : '', carga: 0, posto: 0 };
      if (!e || ign.has(e.codigo)) continue;
      const dd = e.dias[x.dia] || { bat: [], det: '', vazios: [] }, k = e.codigo + '|' + x.dia;
      if (/LICEN|F[ÉE]RIAS|AFAST|ATESTADO/.test(dd.det)) continue;
      diasViagem.add(k);
      es.carga += Math.min(x.carga, 120); es.posto += x.posto;
      // dia sem nenhuma batida e sem resposta do gestor, mas com viagem na planilha
      if (!(dd.bat || []).length && /FALTA/.test(dd.det) && !lanc[k]) {
        itens.push(item(e, dd, CAT.GESTOR, 'Dia sem batida, mas com viagem', `O Fortes mostra falta, mas a planilha do tráfego tem viagem de ${fmt(iniMin(x))} a ${fimMin(x) !== null ? fmt(fimMin(x)) : '?'}. Confirmar com o gestor; se trabalhou, lançar a entrada e a saída (com intervalo).`));
        continue;
      }
      // Movimento 1/2: intervalo total do dia > 2h (o sistema já lança 2h) → AFDT 12:00 e 12:00 + total
      const total = Math.round(x.carga + x.posto + x.descanso);
      if (total > 120) {
        if (total > 24 * 60) { itens.push(item(e, dd, CAT.VOCE, 'Viagem com intervalo absurdo', `Total ${dur(total)} num dia: provável viagem de vários dias. Distribuir com o tráfego.`)); continue; }
        // entrada e saída REAIS do dia: relógio (sem pré-assinaladas, na ordem do turno) + o que o gestor informou; por último a planilha.
        // Antes: menor/maior horário do espelho, contando pré-assinaladas e sem tratar saída depois da meia-noite
        // (caso 13/10/2026: entrada 06:07, saída 00:18 → intervalo saía 03:27–10:50, antes da entrada).
        const reais = reaisDe(e, dd), gest = lanc[k] || [], vaz = dd.vazios || [];
        const todos = reais.concat(gest.filter(t => !reais.some(r => Math.abs(r % 1440 - t) <= 15)));
        let ent = todos.length ? Math.min(...todos) : null, sai = todos.length > 1 ? Math.max(...todos) : null;
        if (vaz.includes('E.1') && !gest.some(t => t < (reais[0] === undefined ? 1440 : reais[0]))) ent = iniMin(x);
        if ((sai === null || (vaz.length && !vaz.includes('E.1') && !gest.length)) && fimMin(x) !== null) sai = fimMin(x);
        if (ent === null) ent = iniMin(x);
        if (sai !== null && sai < ent) sai += 1440;
        const txt = `Carga/descarga ${dur(Math.round(x.carga))} + posto ${dur(Math.round(x.posto))} + descanso ${dur(Math.round(x.descanso))} = ${dur(total)}`;
        if (sai === null) { itens.push(item(e, dd, CAT.VOCE, 'Intervalo de viagem sem saída definida', `${txt}. Falta a saída do dia para posicionar o intervalo.`)); continue; }
        const jorn = sai - ent, prev = M.hm(dd.prev) || 0;
        const aviso = gest.length && Math.min(...gest) - iniMin(x) > 60 && vaz.includes('E.1') ? ` Atenção: o gestor informou entrada ${fmt(Math.min(...gest))}, mas a viagem começou ${fmt(iniMin(x))}.` : '';
        // O intervalo de viagem entra INTEIRO, mesmo que o dia fique abaixo do previsto: é o correto para motorista de viagem
        // (a planilha do tráfego sustenta; o tempo de espera é pago à parte no Movimento 3). Só não cabe se for maior que a jornada do dia.
        if (jorn - total <= 0) {
          itens.push(item(e, dd, CAT.VOCE, 'Intervalo de viagem maior que o dia', `${txt}. Entrada ${fmt(ent)}, saída ${fmt(sai)} (${dur(jorn)}): o intervalo não cabe no dia. Conferir com o tráfego.${aviso}`, { trafego: true }));
          continue;
        }
        const abaixo = prev && jorn - total < prev - 10 ? ` O dia fica com ${dur(jorn - total)} trabalhadas (previsto ${dur(prev)}).` : '';
        let s = 720, r = 720 + total;
        if (s <= ent || r >= sai) { s = ent + Math.floor((jorn - total) / 2); r = s + total; }
        itens.push(item(e, dd, CAT.IMPORTAR, 'Intervalo de viagem (tráfego)', `${txt}. AFDT: ${fmt(s)} e ${fmt(r)}. Marcar como intervalo.${abaixo}${aviso}`, { afdt: [fmt(s), fmt(r)], trafego: true }));
      }
    }
    // batida faltando: sem resposta do gestor, vale a planilha (regra do Breno: batida original > gestor > planilha)
    for (const e of Object.values(espelho)) {
      if (!/MOT/i.test(e.cargo || '') || ign.has(e.codigo)) continue;
      for (const d of Object.values(e.dias)) {
        if (!(d.bat.length % 2) && !/AUS/.test(d.det)) continue;
        const k = e.codigo + '|' + d.num;
        if (lanc[k]) continue;                          // o gestor já respondeu: o fluxo normal trata o dia
        const x = porDia[norm(e.nome) + '|' + d.num];
        if (!x) { itens.push(item(e, d, CAT.VOCE, 'Motorista com batida faltando', 'Tráfego: sem viagem neste dia — perguntar ao gestor.')); continue; }
        const vaz = d.vazios || [], ps = e.prevSem[d.sem] || [], ultima = 'S.' + Math.max(1, ps.length / 2);
        if (vaz.length === 1 && vaz[0] === 'E.1') itens.push(item(e, d, CAT.IMPORTAR, 'Entrada pela planilha do tráfego', `Sem batida de entrada e sem resposta do gestor. Viagem iniciada às ${fmt(iniMin(x))} (planilha). AFDT ${fmt(iniMin(x))}.`, { afdt: [fmt(iniMin(x))], origemAfdt: 'tráfego' }));
        // saída pela planilha só quando a viagem terminou no mesmo dia e depois da última batida real (viagem de mais de um dia: perguntar)
        else if (vaz.length === 1 && vaz[0] === ultima && fimMin(x) !== null && fimMin(x) < 1440 && fimMin(x) > Math.max(0, ...reaisDe(e, d))) itens.push(item(e, d, CAT.IMPORTAR, 'Saída pela planilha do tráfego', `Sem batida de saída e sem resposta do gestor. Viagem encerrada às ${fmt(fimMin(x))} (planilha). AFDT ${fmt(fimMin(x))}.`, { afdt: [fmt(fimMin(x))], origemAfdt: 'tráfego' }));
        else itens.push(item(e, d, CAT.VOCE, 'Motorista com batida faltando', `Tráfego: viagem de ${fmt(iniMin(x))} a ${fimMin(x) !== null ? fmt(fimMin(x)) : '?'} (diferença de horário é normal: descarga/liberação).`));
      }
    }
    for (const es of Object.values(espera)) { es.carga = Math.round(es.carga); es.posto = Math.round(es.posto); }
    return { itens, espera: Object.values(espera), diasViagem };
  }

  const item = (e, d, cat, tipo, acao, extra = {}) => ({ cat, cod: e.codigo, nome: e.nome, dia: d.num, sem: d.sem, espelho: d.txt || '', det: d.det || '', tipo, acao, gestor: '', ...extra });

  const api = { lerViagens, analisarMotoristas };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Motoristas = api;
})(typeof window !== 'undefined' ? window : globalThis);
