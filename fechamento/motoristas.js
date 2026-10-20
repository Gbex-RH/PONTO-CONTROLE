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

  function analisarMotoristas(viagens, espelho, { mes, ano, ignorar = [] } = {}) {
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
    const espera = {};                               // Movimento 3
    for (const x of Object.values(porDia)) {
      const e = porNome[x.motorista];
      const es = espera[x.motorista] = espera[x.motorista] || { nome: x.motorista, codigo: e ? e.codigo : '', carga: 0, posto: 0 };
      if (!e || ign.has(e.codigo)) continue;
      const dd = e.dias[x.dia] || { bat: [], det: '' };
      if (/LICEN|F[ÉE]RIAS|AFAST|ATESTADO/.test(dd.det)) continue;
      es.carga += Math.min(x.carga, 120); es.posto += x.posto;
      // Movimento 1/2: intervalo total do dia > 2h (o sistema já lança 2h) → AFDT 12:00 e 12:00 + total
      const total = Math.round(x.carga + x.posto + x.descanso);
      if (total > 120) {
        if (total > 24 * 60) { itens.push(item(e, dd, CAT.VOCE, 'Viagem com intervalo absurdo', `Total ${dur(total)} num dia: provável viagem de vários dias. Distribuir com o tráfego.`)); continue; }
        const saida = dd.bat.length ? Math.max(...dd.bat) : (x.ultimoFim ? dataDe(x.ultimoFim).min : null);
        const ent = dd.bat.length ? Math.min(...dd.bat) : (x.primeiroIni ? dataDe(x.primeiroIni).min : 480);
        let s = 720, r = 720 + total;
        if (saida !== null && r >= saida) { const jorn = saida - ent; s = ent + Math.floor((jorn - total) / 2); r = s + total; }
        itens.push(item(e, dd, CAT.IMPORTAR, 'Intervalo de viagem (tráfego)', `Carga/descarga ${dur(Math.round(x.carga))} + posto ${dur(Math.round(x.posto))} + descanso ${dur(Math.round(x.descanso))} = ${dur(total)}. AFDT: ${fmt(s)} e ${fmt(r)}. Marcar como intervalo.`, { afdt: [fmt(s), fmt(r)], trafego: true }));
      }
    }
    // sem batida original: sugerir o horário pela planilha
    for (const e of Object.values(espelho)) {
      if (!/MOT/i.test(e.cargo || '') || ign.has(e.codigo)) continue;
      for (const d of Object.values(e.dias)) {
        if (!(d.bat.length % 2) && !/AUS/.test(d.det)) continue;
        const x = porDia[norm(e.nome) + '|' + d.num];
        const dica = x ? `Tráfego: viagem de ${fmt(dataDe(x.primeiroIni).min)} a ${x.ultimoFim ? fmt(dataDe(x.ultimoFim).min) : '?'} (diferença de horário é normal: descarga/liberação).` : 'Tráfego: sem viagem neste dia — perguntar ao gestor.';
        itens.push(item(e, d, CAT.VOCE, 'Motorista com batida faltando', dica));
      }
    }
    for (const es of Object.values(espera)) { es.carga = Math.round(es.carga); es.posto = Math.round(es.posto); }
    return { itens, espera: Object.values(espera) };
  }
  const item = (e, d, cat, tipo, acao, extra = {}) => ({ cat, cod: e.codigo, nome: e.nome, dia: d.num, sem: d.sem, espelho: d.txt || '', det: d.det || '', tipo, acao, gestor: '', ...extra });

  const api = { lerViagens, analisarMotoristas };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Motoristas = api;
})(typeof window !== 'undefined' ? window : globalThis);
