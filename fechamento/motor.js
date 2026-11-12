/* Motor de conferência do ponto — independente do app (pode ser integrado depois).
 * Regras aprendidas no fechamento de REC set/2026 (ver memória "regras-cruzamento-ponto").
 * Funciona no navegador (window.Motor) e no Node (module.exports) para testes.
 */
(function (root) {
  'use strict';

  // ───────────────────────── utilitários ─────────────────────────
  const RE_DIA = /^(\d{2})-(SEG|TER|QUA|QUI|SEX|SAB|DOM)$/;
  const RE_HORA = /^\d{2}:\d{2}$/;
  const SLOTS = ['E.1', 'S.1', 'E.2', 'S.2', 'E.3', 'S.3', 'E.4', 'S.4'];
  const HEADER_MAP = {
    'E.1': 'E.1', 'S.1': 'S.1', 'E.2': 'E.2', 'S.2': 'S.2', 'E.3': 'E.3', 'S.3': 'S.3', 'E.4': 'E.4', 'S.4': 'S.4',
    'H.Extra': 'hExtra', 'AT/SA': 'atSa', 'Abono': 'abono', 'Ad.Not': 'adNot',
    'Prev.': 'prev', 'Prev': 'prev', 'Trab.': 'trab', 'Trab': 'trab', 'Detalhe': 'detalhe'
  };
  const COLS_PADRAO = [
    { key: 'E.1', x: 80 }, { key: 'S.1', x: 106 }, { key: 'E.2', x: 131 }, { key: 'S.2', x: 157 },
    { key: 'E.3', x: 182 }, { key: 'S.3', x: 208 }, { key: 'E.4', x: 233 }, { key: 'S.4', x: 259 },
    { key: 'hExtra', x: 293 }, { key: 'atSa', x: 332 }, { key: 'abono', x: 363 },
    { key: 'adNot', x: 390 }, { key: 'prev', x: 416 }, { key: 'trab', x: 442 }, { key: 'detalhe', x: 511 }
  ];
  const hm = s => { const m = String(s || '').match(/^(\d{1,3}):(\d{2})/); return m ? (+m[1]) * 60 + (+m[2]) : null; };
  const fmt = v => { if (v === null || v === undefined) return ''; v = ((v % 1440) + 1440) % 1440; return String(Math.floor(v / 60)).padStart(2, '0') + ':' + String(v % 60).padStart(2, '0'); };
  const dur = v => (v < 0 ? '-' : '') + Math.floor(Math.abs(v) / 60) + 'h' + String(Math.abs(v) % 60).padStart(2, '0');
  const dd = n => String(n).padStart(2, '0');
  const semCodigo = c => String(c || '').replace(/^GBLOG_/, '');

  // Regra de intervalo do Breno: até 6h nenhum; >6h 30 min; >8h 1h.
  const intervalo = carga => carga > 480 ? 60 : carga > 360 ? 30 : 0;

  // ───────────────────────── leitura do espelho (pdf) ─────────────────────────
  // pages = [[{str,x,y,w}]] (coordenadas do pdf.js: y cresce para cima)
  function agruparLinhas(items) {
    const rows = {};
    for (const it of items) {
      const s = (it.str || '').trim(); if (!s) continue;
      const y = Math.round(it.y / 3) * 3;
      (rows[y] = rows[y] || []).push({ x: it.x, w: it.w || 0, s });
    }
    return Object.keys(rows).map(Number).sort((a, b) => b - a).map(y => rows[y].sort((a, b) => a.x - b.x));
  }
  function calibrar(linhas) {
    for (const l of linhas) {
      const t = l.map(c => c.s).join(' ');
      if (!/H\.Extra/.test(t) || !/Trab/.test(t)) continue;
      const cols = l.filter(c => HEADER_MAP[c.s]).map(c => ({ key: HEADER_MAP[c.s], x: c.x + c.w / 2 }));
      if (cols.length >= 10) return cols.sort((a, b) => a.x - b.x);
    }
    return null;
  }
  const colunaDe = (c, cols) => cols.reduce((b, k) => Math.abs(c.x + c.w / 2 - k.x) < Math.abs(c.x + c.w / 2 - b.x) ? k : b).key;

  function lerEspelho(pages) {
    const emps = {}; let cur = null, cols = null;
    for (const items of pages) {
      const linhas = agruparLinhas(items);
      cols = calibrar(linhas) || cols;
      const uso = cols || COLS_PADRAO;
      for (const l of linhas) {
        const t = l.map(c => c.s).join(' ');
        const me = t.match(/Empregado:\s*(\d+)\s*-\s*(.+?)\s*Per[ií]odo:\s*(\d{2})\/(\d{2})\/(\d{4})/);
        if (me) {
          cur = emps[me[1]] = emps[me[1]] || { codigo: me[1], nome: me[2].trim(), mes: +me[4], ano: +me[5], dias: {}, prevSem: {}, tot: {} };
          continue;
        }
        if (!cur) continue;
        const reTot = /(Trabalhadas|Adicionais Noturnos|Horas Extras\((?:50|70|75|100|Total)%?\)|Atrasos e SA)\s*:\s*(\d{1,4}:\d{2})/g;
        let mt; while ((mt = reTot.exec(t))) cur.tot[mt[1]] = hm(mt[2]);
        const mc = t.match(/Cargo:\s*(.+?)\s+Admiss/); if (mc && !cur.cargo) cur.cargo = mc[1].trim();
        const mp = t.match(/PIS:\s*([\d.]+)/); if (mp && !cur.pis) cur.pis = mp[1].replace(/\./g, '');
        const mr = t.match(/Rescis[ãa]o:\s*(\d{2}\/\d{2}\/\d{4})/); if (mr) cur.rescisao = mr[1];
        const md = l[0] && l[0].s.match(RE_DIA);
        if (md) {
          const d = { num: +md[1], sem: md[2], b: {}, vazios: [], det: [] };
          for (const c of l.slice(1)) {
            const ehValor = RE_HORA.test(c.s) || /^\d{1,3}:\d{2}(\(\d+%\))?$/.test(c.s) || /^-+$/.test(c.s);
            const col = ehValor ? colunaDe(c, uso) : 'detalhe';
            if (/^[ES]\.\d/.test(col)) { if (RE_HORA.test(c.s)) d.b[col] = c.s; else d.vazios.push(col); }
            else if (col === 'detalhe') d.det.push(c.s);
            else d[col] = c.s;
          }
          d.det = d.det.join(' ').toUpperCase();
          d.bat = SLOTS.filter(s => d.b[s]).map(s => hm(d.b[s]));
          d.txt = SLOTS.map(s => d.b[s] || (d.vazios.includes(s) ? '-----' : '')).join(' ').trim();
          cur.dias[d.num] = d;
          continue;
        }
        const mj = l[0] && l[0].s.match(/^(SEG|TER|QUA|QUI|SEX|SAB|DOM):$/);
        if (mj) cur.prevSem[mj[1]] = l.slice(1).filter(c => RE_HORA.test(c.s) && /^[ES]\.\d/.test(colunaDe(c, uso))).map(c => c.s);
      }
    }
    return emps;
  }

  // ───────────────────────── outras fontes ─────────────────────────
  // Relatório "Ponto para Controle Diário / Batida Inexistente" — linhas de texto.
  function lerBatidaInexistente(texto) {
    const out = []; let cod = null, ref = null;
    for (const l of texto.split(/\r?\n/)) {
      let m = l.match(/^(\d{6})\s+.+?\s(\d{2})\/(\d{2})\/\d{4}\s+\S{3}\s+(\d{2}\/\d{2})\/\d{4}\s+(\d{2}:\d{2})/);
      if (m) { cod = m[1]; ref = +m[2]; out.push({ cod, dia: ref, data: m[4], hora: m[5] }); continue; }
      m = l.match(/^(\d{2})\/\d{2}\/\d{4}\s+\S{3}\s+(\d{2}\/\d{2})\/\d{4}\s+(\d{2}:\d{2})/);
      if (m && cod) { ref = +m[1]; out.push({ cod, dia: ref, data: m[2], hora: m[3] }); continue; }
      m = l.match(/^(\d{2}\/\d{2})\/\d{4}\s+(\d{2}:\d{2})\s+-+/);
      if (m && cod) out.push({ cod, dia: ref, data: m[1], hora: m[2] });
    }
    return out;
  }
  // Validação do app (Excel): {aba: [[cabeçalho...], [linha...]]}
  function lerValidacao(abas) {
    const regs = [];
    for (const [aba, rows] of Object.entries(abas)) {
      const h = rows[0] || [];
      const ix = n => h.findIndex(x => String(x || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().startsWith(n));
      const iD = ix('data'), iC = ix('cod'), iN = ix('nome'), iH = ix('horario'), iO = ix('observ'), iG = ix('gestor'), iS = ix('status');
      for (const r of rows.slice(1)) {
        if (!r || !r[iD]) continue;
        const data = String(r[iD]); const hora = String(r[iH] || '');
        regs.push({
          tipo: aba.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase(), dia: +data.slice(0, 2),
          mes: +data.slice(3, 5) || null, ano: +data.slice(6, 10) || null,
          cod: semCodigo(r[iC]), nome: r[iN] || '', hora: RE_HORA.test(hora) ? hora : null,
          obs: r[iO] || '', gestor: r[iG] || '', status: r[iS] || ''
        });
      }
    }
    return regs;
  }
  // AFDT curto de importação (23 caracteres: PIS + DDMMAAAA + HHMM)
  function lerAFDT(texto, origem) {
    return texto.split(/\r?\n/).map(l => l.trim()).filter(l => /^\d{23}$/.test(l))
      .map(l => ({ pis: l.slice(0, 11), dia: +l.slice(11, 13), mes: +l.slice(13, 15), ano: +l.slice(15, 19), hora: l.slice(19, 21) + ':' + l.slice(21, 23), origem }));
  }
  // Só vale o que é do mês do espelho: resposta ou batida de outro mês era aplicada no mesmo "dia" do mês errado.
  function filtrarMes(lista, espelho) {
    const ref = Object.values(espelho || {})[0];
    if (!ref || !ref.mes) return lista;
    return lista.filter(x => !x.mes || (x.mes === ref.mes && (!x.ano || x.ano === ref.ano)));
  }
  const pis11 = s => String(s || '').replace(/\D/g, '').slice(-11).padStart(11, '0');

  // ───────────────────────── análise ─────────────────────────
  const CAT = {
    IMPORTAR: '1. Importar (arquivo)',
    VOCE: '2. Você corrige no Fortes',
    GESTOR: '3. Cobrar do gestor',
    INFO: '4. Conferido — sem ação'
  };

  function analisar({ espelho, inexistente = [], validacao = [], afdt = [], ignorar = [] }) {
    const itens = [];
    validacao = filtrarMes(validacao, espelho); afdt = filtrarMes(afdt, espelho);
    const add = (cat, cod, dia, tipo, acao, extra = {}) => {
      const e = espelho[cod] || {}; const d = (e.dias || {})[dia] || {};
      itens.push({ cat, cod, nome: e.nome || extra.nome || '', dia, sem: d.sem || '', espelho: d.txt || '', det: d.det || '',
        prev: d.prev || '', trab: d.trab || '', tipo, acao, gestor: extra.gestor || '', ...extra });
    };
    const ign = new Set(ignorar);
    // Lançamento do gestor que não veio no Excel (ex.: Excel exportado só com "não exportados") é reconstruído do AFDT do app:
    // é a mesma informação. Sem isso as regras de saída antecipada, dia deslocado e batida em afastamento ficavam caladas.
    const p2c = {}; for (const [c, e] of Object.entries(espelho)) if (e.pis) p2c[pis11(e.pis)] = c;
    const jaTem = new Set(validacao.filter(r => /^LANC/.test(r.tipo) && r.hora).map(r => r.cod + '|' + r.dia + '|' + r.hora));
    let reconstruidos = 0;
    for (const a of afdt) {
      if (a.origem === 'HO') continue;
      const c = p2c[pis11(a.pis)], k = c + '|' + a.dia + '|' + a.hora;
      if (!c || jaTem.has(k)) continue;
      jaTem.add(k); reconstruidos++;
      validacao = validacao.concat([{ tipo: 'LANCAMENTO', dia: a.dia, mes: a.mes, ano: a.ano, cod: c, nome: espelho[c].nome, hora: a.hora, obs: '', gestor: '', status: 'Confirmado', doAfdt: true }]);
    }
    const resp = {};
    for (const r of validacao) (resp[r.cod + '|' + r.dia] = resp[r.cod + '|' + r.dia] || []).push(r);
    const txtResp = (cod, dia) => (resp[cod + '|' + dia] || []).map(r => `${r.tipo.toLowerCase()}${r.hora ? ' ' + r.hora : ''}${r.obs ? ': ' + r.obs : ''}`).join(' | ');
    const pis2cod = {}; for (const [c, e] of Object.entries(espelho)) if (e.pis) pis2cod[pis11(e.pis)] = c;
    const noAfdt = new Set(afdt.map(a => (pis2cod[pis11(a.pis)] || a.pis) + '|' + a.dia + '|' + a.hora));
    const tratado = new Set();               // dias já classificados (evita duplicar)
    const marca = (c, d) => tratado.add(c + '|' + d);

    // turno noturno: batida de madrugada do dia D pertence ao turno iniciado em D-1
    const noturnoAnterior = (e, dia, h, extra = []) => {
      const ant = (e.dias[dia - 1] || {}).bat || [];
      const hoje = (e.dias[dia] || {}).bat || [];
      const dAnt = e.dias[dia - 1], psAnt = dAnt ? (e.prevSem[dAnt.sem] || []).map(hm) : [];
      const comecouNoite = (ant[0] !== undefined && ant[0] >= 1080) || (psAnt[0] !== undefined && psAnt[0] >= 1080) || (!ant.length && extra.some(b => b >= 1080));
      return h < 720 && comecouNoite && !hoje.some(b => b >= 720 && b < 1080);
    };
    const AFAST = /F[ÉE]RIAS|LICEN|AFAST/;
    const cargaDoDia = (e, sem) => {
      const ps = (e.prevSem[sem] || []).map(hm);
      let c = 0; for (let i = 0; i + 1 < ps.length; i += 2) c += (ps[i + 1] - ps[i] + 1440) % 1440;
      return { ps, c };
    };

    // 0) dias trabalhados fora do horário cadastrado (regra do Breno: muitos dias = troca de jornada; poucos = escala)
    const escalaDeslocada = (e, d, ini) => {
      const { c } = cargaDoDia(e, d.sem);
      if (!c) return null;
      const itv = intervalo(c), meio = Math.floor(c / 2);
      return itv ? [ini, ini + meio, ini + meio + itv, ini + c + itv] : [ini, ini + c];
    };
    const reaisDoDia = (e, d) => {                         // batidas sem as pré-assinaladas do intervalo
      const ps = (e.prevSem[d.sem] || []).map(hm), pre = new Set(ps.slice(1, -1));
      // inclui as entradas/saídas que o gestor informou (ainda não importadas no espelho cru)
      const lanc = (resp[e.codigo + '|' + d.num] || []).filter(x => x.hora && /^LANC/.test(x.tipo)).map(x => hm(x.hora));
      return [...new Set([...d.bat.filter(b => !pre.has(b)), ...lanc])].sort((x, y) => x - y);
    };
    for (const [cod, e] of Object.entries(espelho)) {
      if (ign.has(cod)) continue;
      const trabalhados = Object.values(e.dias).filter(d => d.bat.length);
      const noturnos = [], tarde = [], tardeTodos = [];
      for (const d of trabalhados) {
        if (/FERIADO|LICEN|F[ÉE]RIAS|AFAST/.test(d.det)) continue;
        const ps = (e.prevSem[d.sem] || []).map(hm); if (ps.length < 2) continue;
        const reais = reaisDoDia(e, d); if (!reais.length) continue;
        // batida antes das 05:00 no começo da linha, com turno batido à tarde/noite na véspera = saída do turno de ontem
        // (passou da meia-noite); a entrada de hoje é a batida seguinte
        const vesp = (e.dias[d.num - 1] || {}).bat || [];
        const sobraDeOntem = reais.length > 1 && reais[0] < 300 && vesp.some(t => t >= 720);
        const primeira = sobraDeOntem ? reais[1] : reais[0];
        // turno da noite = batida à noite (18h–24h) seguida de batida de madrugada (0h–4h); com jornada diurna cadastrada
        // (a ordem é a da linha do espelho — ordem do turno; "reais" está em ordem de relógio e a madrugada nunca vinha "depois" da noite)
        const iNoite = d.bat.findIndex(t => t >= 1080);
        const noite = iNoite >= 0 ? d.bat[iNoite] : undefined, madrugada = iNoite >= 0 && d.bat.slice(iNoite + 1).some(t => t <= 240);
        if (ps[0] < 720 && noite !== undefined && madrugada) { d._ini = noite; noturnos.push(d); }
        else if (primeira >= ps[1] && primeira < 1080 && ps[0] < ps[1] - 120
          // se o gestor informou uma entrada de manhã (ainda não importada), o dia não foi deslocado: é só batida faltando
          && !(resp[cod + '|' + d.num] || []).some(x => x.hora && hm(x.hora) < ps[1])
          // para a regra do "mês todo" contam também os dias em que a 1ª batida cai perto da saída/volta do almoço:
          // num dia isolado isso é entrada esquecida, mas quase todo dia é jornada cadastrada errada (caso REC set/2026:
          // jornada 07:00–16:20, entrando ~13:00 o mês inteiro — antes viravam 12 "batida faltando" para o gestor)
          && (tardeTodos.push(d), d._iniTarde = primeira, true)
          // 1ª batida no horário da saída ou da volta do almoço (±45 min) = entrada esquecida, não dia deslocado (José caso FOR 01/09)
          // (vale só sem confirmação do gestor: se ele informou um horário da tarde perto da 1ª batida, o dia foi mesmo deslocado — caso FOR 04/09)
          && !(ps.length >= 4 && (Math.abs(primeira - ps[1]) <= 45 || Math.abs(primeira - ps[2]) <= 45)
               && !(resp[cod + '|' + d.num] || []).some(x => x.hora && hm(x.hora) >= ps[1] && Math.abs(hm(x.hora) - primeira) <= 60))) { d._ini = primeira; tarde.push(d); }   // entrou depois da 1a saída prevista
      }
      if (noturnos.length && noturnos.length >= Math.max(5, 0.7 * trabalhados.length)) {
        add(CAT.VOCE, cod, noturnos[0].num, 'Turno da noite o mês todo', `Entrou à noite em ${noturnos.length} de ${trabalhados.length} dias trabalhados, mas a jornada cadastrada é diurna. Trocar a jornada para noturna no Fortes Pessoal e reprocessar. As batidas informadas pelo gestor para ele NÃO entram no AFDT (eram respostas a pendências da jornada errada): conferir o que sobrar depois da troca.`, { trocaJornada: 'noturno' });
        for (const n of Object.keys(e.dias)) marca(cod, +n);
        ign.add(cod); continue;
      }
      // à tarde praticamente o mês todo = horário cadastrado errado → trocar a jornada, não criar escala dia a dia (Ana caso FOR set/2026)
      if (tardeTodos.length && tardeTodos.length >= Math.max(5, 0.7 * trabalhados.length)) {
        add(CAT.VOCE, cod, tardeTodos[0].num, 'Horário da tarde o mês todo', `Entrou à tarde em ${tardeTodos.length} de ${trabalhados.length} dias trabalhados (ex.: ${fmt(tardeTodos[0]._iniTarde)}), mas a jornada cadastrada começa ${fmt(hm((e.prevSem[tardeTodos[0].sem] || [])[0]))}. Trocar a jornada no Fortes Pessoal e reprocessar; depois processar de novo na ferramenta.`, { trocaJornada: 'tarde' });
        for (const d of tardeTodos) marca(cod, d.num);
        tarde.length = 0;
      }
      for (const d of [...noturnos, ...tarde]) {
        const g = txtResp(cod, d.num), noite = noturnos.includes(d);
        let ini = d._ini;
        let reais = reaisDoDia(e, d).filter(t => !noite || t >= ini || t <= 360);
        // batida original prevalece: entrada informada pelo gestor até 1h antes de uma batida original → vale a original
        const doGestor = new Set((resp[cod + '|' + d.num] || []).filter(x => x.hora).map(x => hm(x.hora)));
        const descGestor = [];
        if (doGestor.has(reais[0]) && reais[1] !== undefined && !doGestor.has(reais[1]) && reais[1] - reais[0] <= 60) {
          descGestor.push(reais[0]); reais = reais.slice(1); ini = reais[0];
        }
        const tipo = noite ? 'Trabalhou à noite (jornada diurna)' : 'Dia deslocado (entrou à tarde)';
        const respTipos = (resp[cod + '|' + d.num] || []).map(r => r.tipo);
        // com uma batida só não dá para saber o dia; e se o gestor disse falta/folga, a resposta contradiz o ponto
        // entrada faltando no espelho e sem confirmação de que entrou à tarde (lançamento do gestor à tarde ou abono da manhã) → perguntar
        const confirmado = (resp[cod + '|' + d.num] || []).some(x => x.hora && hm(x.hora) >= ini - 60 && hm(x.hora) <= ini + 60) || /ABON|DECLARA/.test(d.det);
        if (!noite && d.vazios.includes('E.1') && !confirmado) { add(CAT.GESTOR, cod, d.num, 'Entrada faltando', `Primeira batida às ${fmt(ini)}. Esqueceu de bater a entrada (qual horário?) ou entrou à tarde?`, { gestor: g }); marca(cod, d.num); continue; }
        if (reais.length < 2) { add(CAT.GESTOR, cod, d.num, tipo, `Só há a batida ${fmt(ini)}. Qual foi o horário de entrada e de saída neste dia?`, { gestor: g }); marca(cod, d.num); continue; }
        if (respTipos.some(t => t === 'FALTA' || t === 'FOLGA')) { add(CAT.GESTOR, cod, d.num, tipo, `O gestor informou ${respTipos.join('/').toLowerCase()}, mas há batidas (${reais.map(fmt).join(', ')}). Confirmar com o gestor o horário real antes de criar escala.`, { gestor: g }); marca(cod, d.num); continue; }
        const { c } = cargaDoDia(e, d.sem);
        const fimReal = reais[reais.length - 1];
        // dia real de até 6h (regra de intervalo: até 6h não tem intervalo) = escala da carga prevista em 2 batidas;
        // as batidas que sobram no meio são desconsideradas. Acima de 6h, escala de 4 batidas com o intervalo da regra.
        const duas = reais.length < 4 && ((fimReal - ini + 1440) % 1440) <= 360;
        const bat = duas ? [ini, ini + c] : escalaDeslocada(e, d, ini);
        if (!bat || !c) continue;
        const sobra = [...descGestor, ...(duas ? reais.filter(t => t !== ini && t !== fimReal) : [])];
        const fimEsc = bat[bat.length - 1];
        const limite = fimEsc >= 1440 ? Math.ceil((fimEsc % 1440 + 40) / 60) * 60 : null;
        add(CAT.IMPORTAR, cod, d.num, tipo,
          `Escala do mês: ${bat.map(fmt).join(' / ')}${limite !== null ? ', Limite ' + fmt(limite) : ''} (carga ${dur(c)}${duas ? ' em 2 batidas, sem intervalo real no dia' : ''}, entrada ${fmt(ini)}${duas ? ', saída ' + fmt(fimReal) : ''}). Desconsiderar as pré-assinaladas do dia${sobra.length ? ' e a(s) batida(s) ' + sobra.map(fmt).join(', ') + ' (informada pelo gestor ou sobrando no par)' : ''}.${duas ? '' : ' Marcar o intervalo depois.'}`,
          { gestor: g, escala: { tipo: 'X', bat, limite }, desc: sobra, limpaPre: true });
        marca(cod, d.num);
      }
    }

    // 0b) batida do app (gestor ou home office) em dia de férias/licença/afastamento: é excluída do ponto
    const afdtDia = {};
    for (const a of afdt) { const c = p2c[pis11(a.pis)]; if (c && !ign.has(c)) (afdtDia[c + '|' + a.dia] = afdtDia[c + '|' + a.dia] || []).push(a); }
    for (const [k, as] of Object.entries(afdtDia)) {
      const [cod, ds] = k.split('|'), dia = +ds, d = (espelho[cod].dias || {})[dia];
      if (!d || !AFAST.test(d.det)) continue;
      const hs = [...new Set(as.map(a => a.hora))].sort();
      add(CAT.VOCE, cod, dia, 'Batida em dia de afastamento', `Fora do AFDT: ${hs.join(', ')} (${as.some(a => a.origem === 'HO') ? 'batida no app' : 'informada pelo gestor'}). O dia é ${d.det.toLowerCase()} — batida em férias/licença é excluída do ponto.`, { gestor: txtResp(cod, dia), naoInserir: hs.map(hm) });
      marca(cod, dia);
    }

    // 0c) home office: duas batidas no app a até 15 min uma da outra = duplicada (caso REC 15/10/2026: 12:00 e 12:10)
    for (const [k, as] of Object.entries(afdtDia)) {
      const [cod, ds] = k.split('|'), dia = +ds; if (tratado.has(k)) continue;
      const ho = [...new Set(as.filter(a => a.origem === 'HO').map(a => hm(a.hora)))].sort((x, y) => x - y);
      for (let i = 1; i < ho.length; i++) if (ho[i] - ho[i - 1] <= 15) {
        const sai = (i - 1) % 2 === 1 ? ho[i - 1] : ho[i];          // par na saída: fica a mais tarde; na entrada: fica a mais cedo
        add(CAT.VOCE, cod, dia, 'Batida duplicada (home office)', `Bateu ${fmt(ho[i - 1])} e ${fmt(ho[i])} no app. Fora do AFDT: ${fmt(sai)} (fica o maior trabalhado).`, { naoInserir: [sai] });
        break;
      }
    }

    // 1) respostas do gestor
    for (const r of validacao) {
      const e = espelho[r.cod]; if (!e || ign.has(r.cod) || tratado.has(r.cod + "|" + r.dia)) continue;
      const d = e.dias[r.dia] || { bat: [], det: '' };
      const g = txtResp(r.cod, r.dia);
      const temTurno = d.bat.length >= 2;
      if (r.tipo === 'FOLGA') {
        if (temTurno) add(CAT.INFO, r.cod, r.dia, 'Folga informada, mas há turno batido', 'Gestor errou — vale a batida. Não lançar folga.', { gestor: g });
        else if (d.bat.length === 1) add(CAT.GESTOR, r.cod, r.dia, 'Folga informada com 1 batida original', 'Batida original sem saída. Foi folga (desconsiderar a batida) ou trabalhou (qual a saída)? Motorista: conferir tráfego.', { gestor: g });
        else if (/FOLGA/.test(d.det) || AFAST.test(d.det)) continue;
        else add(CAT.IMPORTAR, r.cod, r.dia, 'Folga', 'Escala do mês: F', { gestor: g, escala: { tipo: 'F' } });
        marca(r.cod, r.dia);
      } else if (r.tipo === 'FALTA') {
        if (temTurno) add(CAT.INFO, r.cod, r.dia, 'Falta informada, mas há turno batido', 'Gestor errou — não é falta.', { gestor: g });
        marca(r.cod, r.dia);                 // falta sem batida: o Fortes apura sozinho
      } else if (r.tipo === 'ATESTADO') {
        if (/LICEN|AFAST/.test(d.det)) { if (temTurno) add(CAT.VOCE, r.cod, r.dia, 'Atestado com turno batido', 'Conferir se o atestado foi após o expediente.', { gestor: g }); }
        else add(CAT.VOCE, r.cod, r.dia, 'Atestado não cadastrado', 'Cadastrar no Fortes Pessoal (conferir e-mail).', { gestor: g });
        marca(r.cod, r.dia);
      } else if (r.tipo === 'CURSO') {
        if (!d.bat.length && /FALTA \[FOLHA\]|^FALTA$/.test(d.det)) add(CAT.VOCE, r.cod, r.dia, 'Aprendiz em curso', 'Lançar a justificativa no Fortes (falta abonada — aula de aprendizagem).', { gestor: g });
        else if (temTurno) add(CAT.INFO, r.cod, r.dia, 'Curso informado, mas há turno batido', 'Gestor errou — vale a batida.', { gestor: g });
        marca(r.cod, r.dia);
      }
    }

    // 2) batidas informadas pelo gestor (lançamentos)
    for (const r of validacao.filter(x => x.tipo.startsWith('LANCAMENTO') && x.hora)) {
      const e = espelho[r.cod]; if (!e || ign.has(r.cod)) continue;
      const d = e.dias[r.dia] || { bat: [], det: '' };
      const h = hm(r.hora); const g = txtResp(r.cod, r.dia);
      if (AFAST.test(d.det)) {
        // já apontado no 0b quando a batida está no AFDT; aqui só o lançamento que não está no AFDT
        if (!noAfdt.has(r.cod + '|' + r.dia + '|' + r.hora)) add(CAT.VOCE, r.cod, r.dia, 'Batida informada em dia de afastamento', `Não inserir ${r.hora} (o dia é ${d.det.toLowerCase()}).`, { gestor: g, naoInserir: [h] });
        marca(r.cod, r.dia); continue;
      }
      const psDia = (e.prevSem[d.sem] || []).map(hm);
      const lancsDia = (resp[r.cod + '|' + r.dia] || []).filter(x => x.hora && /^LANC/.test(x.tipo));
      // Saída depois da meia-noite de um turno que começou à tarde: o gestor informa a batida com a data do dia seguinte
      // (caso REC 02/10/2026 00:00 → turno de 01/10). Precisa de escala com Limite para o Fortes puxar a batida.
      if (h < 300 && !noturnoAnterior(e, r.dia, h) && !tratado.has(r.cod + '|' + (r.dia - 1))) {
        const da = e.dias[r.dia - 1];
        const psA = da ? (e.prevSem[da.sem] || []).map(hm) : [], preA = new Set(psA.slice(1, -1));
        const reaisA = da ? da.bat.filter(x => !preA.has(x)) : [];
        if (psA.length >= 2 && psA[0] < 1080 && reaisA.length % 2 === 1 && reaisA[reaisA.length - 1] >= 720 && !AFAST.test(da.det) && !/FERIADO/.test(da.det)) {
          const limite = Math.ceil((h + 30) / 60) * 60;
          add(CAT.IMPORTAR, r.cod, r.dia - 1, 'Saída depois da meia-noite', `${r.hora} (informada com data ${dd(r.dia)}) é a saída do turno de ${dd(r.dia - 1)}. Escala do mês no dia ${dd(r.dia - 1)}: ${psA.map(fmt).join(' / ')} com Limite ${fmt(limite)}, para o Fortes puxar a batida para o turno.`, { gestor: txtResp(r.cod, r.dia - 1) || g, escala: { tipo: 'X', bat: psA, limite } });
          marca(r.cod, r.dia - 1); continue;
        }
      }
      // Batida do gestor SOBRANDO: o relógio já fechou o dia, ou há mais respostas do que casas vazias no espelho.
      // A batida original prevalece: não entra no AFDT (caso/caso REC 01 e 02/10/2026).
      if (d.bat.length >= 2 && h >= 300 && !noturnoAnterior(e, r.dia, h) && !d.bat.some(b => Math.abs(b - h) <= 15) && !/FERIADO/.test(d.det)) {
        const fechado = d.bat.length % 2 === 0 && !d.vazios.length && !/AUS/.test(d.det);
        let sobra = fechado;
        if (!fechado && d.vazios.length && lancsDia.length > d.vazios.length && !lancsDia.some(x => hm(x.hora) < 300)) {
          // cada casa vazia fica com a resposta mais próxima do horário previsto dela; o que sobrar não entra
          const usados = new Set();
          for (const s of d.vazios) {
            const alvo = psDia[SLOTS.indexOf(s)]; if (alvo === undefined) continue;
            const livre = lancsDia.filter(x => !usados.has(x)).sort((x, y) => Math.abs(hm(x.hora) - alvo) - Math.abs(hm(y.hora) - alvo))[0];
            if (livre) usados.add(livre);
          }
          sobra = usados.size === d.vazios.length && !usados.has(r);
        }
        if (sobra) {
          add(CAT.VOCE, r.cod, r.dia, 'Batida do gestor sobrando', `Não importar ${r.hora} (informada pelo gestor): ${fechado ? 'o relógio já fechou o dia' : 'as casas vazias do dia já foram preenchidas por outra resposta'} — a batida original prevalece.`, { gestor: g, naoInserir: [h] });
          continue;
        }
      }
      const naEsp = d.bat.some(b => Math.abs(b - h) <= 5);
      const naoAfdt = r.status === 'Confirmado' && !noAfdt.has(r.cod + '|' + r.dia + '|' + r.hora) && !naEsp;
      if (naoAfdt && !tratado.has(r.cod + '|' + r.dia)) add(CAT.IMPORTAR, r.cod, r.dia, 'Batida informada fora do AFDT', `Incluir ${r.hora} no AFDT.`, { gestor: g, afdt: r.hora });
      if (r.status !== 'Confirmado') add(CAT.VOCE, r.cod, r.dia, 'Lançamento ainda Pendente', `Confirmar ${r.hora} na Validação.`, { gestor: g });
      // entrada informada bem depois do previsto e sem batidas antes = dia deslocado → escala
      if (tratado.has(r.cod + '|' + r.dia)) continue;          // dia já resolvido pela análise do espelho
      const { ps, c } = cargaDoDia(e, d.sem);
      const lanc = (resp[r.cod + '|' + r.dia] || []).filter(x => x.hora).map(x => hm(x.hora));
      if (ps.length > 1 && ps[0] < ps[1] && h === Math.min(...lanc) && h >= ps[1] && !d.bat.some(b => b < h - 5) && !noturnoAnterior(e, r.dia, h) && !/FERIADO/.test(d.det)) {
        const itv = intervalo(c), meio = Math.floor(c / 2);
        const bat = itv ? [h, h + meio, h + meio + itv, h + c + itv] : [h, h + c];
        add(CAT.IMPORTAR, r.cod, r.dia, 'Dia deslocado (entrada tarde)', `Escala do mês: ${bat.map(fmt).join(' / ')} (carga ${dur(c)}). Marcar intervalo depois.`, { gestor: g, escala: { tipo: 'X', bat } });
        marca(r.cod, r.dia);
        continue;
      }
      // saída informada pelo gestor ("horário final da jornada") bem antes da saída prevista → saída antecipada:
      // escala com a CARGA PREVISTA em só 2 batidas + desconsiderar pré-assinaladas/batidas depois da saída.
      const alvo = noturnoAnterior(e, r.dia, h, lanc.filter(x => x >= 1080)) ? r.dia - 1 : r.dia;
      const da = e.dias[alvo] || { bat: [], sem: d.sem };
      const pa = cargaDoDia(e, da.sem);
      if (pa.ps.length >= 2 && !/FERIADO|LICEN|F[ÉE]RIAS/.test(da.det || '')) {
        const ini = pa.ps[0], rel = t => (t < ini - 360 ? t + 1440 : t);      // linha do tempo do turno
        const fimPrev = rel(pa.ps[pa.ps.length - 1]) < rel(ini) ? rel(pa.ps[pa.ps.length - 1]) + 1440 : rel(pa.ps[pa.ps.length - 1]);
        const hr = rel(h);
        const real = (da.bat || []).map(rel).filter(t => t > hr + 5);
        const preAss = new Set(pa.ps.slice(1, -1).map(rel));
        const soPre = real.every(t => preAss.has(t));
        if (hr === Math.max(...lanc.map(rel)) && hr > rel(ini) && fimPrev - hr > 60 && soPre && real.length) {
          const bat = [ini, ini + pa.c];
          const limite = (ini + pa.c) % 1440 < ini ? Math.ceil(((ini + pa.c) % 1440 + 40) / 60) * 60 : null;
          const descs = (da.bat || []).filter(t => rel(t) > rel((da.bat || [])[0]) && rel(t) !== hr);
          add(CAT.IMPORTAR, r.cod, alvo, 'Saída antecipada informada', `Escala do mês: ${bat.map(fmt).join(' / ')} (carga ${dur(pa.c)} em 2 batidas${limite !== null ? ', Limite ' + fmt(limite) : ''}). Com escala de 2 batidas, ficam só a entrada e a saída ${r.hora}: desconsiderar ${[...(da.bat || []).filter(t => rel(t) > rel((da.bat || [])[0]) && rel(t) !== hr)].map(fmt).join(', ')}.`, { gestor: g, escala: { tipo: 'X', bat, limite }, desc: descs, limpaPre: true });
          marca(r.cod, alvo);
        }
      }
    }

    // 2b) respostas em texto livre (depois dos lançamentos, para não duplicar)
    for (const r of validacao.filter(x => x.tipo === 'OUTRO')) {
      const e = espelho[r.cod]; if (!e || ign.has(r.cod) || tratado.has(r.cod + '|' + r.dia)) continue;
      const d = e.dias[r.dia] || { bat: [], det: '', sem: '' };
      const g = txtResp(r.cod, r.dia), o = String(r.obs).toLowerCase();
      const fechado = d.bat.length >= 2 && d.bat.length % 2 === 0 && !/AUS/.test(d.det);
      if (/feriado/.test(o)) continue;
      const confirma = [['f[ée]rias', 'F[ÉE]RIAS'], ['folga', 'FOLGA'], ['licen|atestad', 'LICEN|ATEST|AFAST'], ['feriado', 'FERIADO']].some(([t, dz]) => new RegExp(t).test(o) && new RegExp(dz).test(d.det));
      if (confirma) { marca(r.cod, r.dia); continue; }   // texto do gestor só confirma o que o espelho já mostra
      // dia sem batida que o Fortes já mostra justificado (falta abonada, folga, acompanhamento…): nada a fazer
      if (!d.bat.length && d.det && !/FALTA \[FOLHA\]|^FALTA$|AUS[ÊE]NCIA/.test(d.det)) {
        add(CAT.INFO, r.cod, r.dia, 'Resposta só confirma o Fortes', `O Fortes já mostra "${d.det}". Nada a fazer.`, { gestor: g });
        marca(r.cod, r.dia); continue;
      }
      if (fechado && !/noite|noturn|hospital|doente|n[ãa]o trabalhou/.test(o)) { marca(r.cod, r.dia); continue; }  // texto só confirma o horário
      let acao = 'Ler a observação e decidir.', extra = { gestor: g };
      if (/curso/.test(o) || (!d.bat.length && /aprendiz/.test(o))) acao = 'Aprendiz em curso: lançar a justificativa no Fortes (falta abonada — aula de aprendizagem).';
      else if (/noite|noturn/.test(o)) acao = 'Mudou de turno: se for o mês todo, trocar a jornada (Fortes Pessoal); se poucos dias, escala.';
      else if (/tr[áa]fego|viagem|carreteiro/.test(o)) acao = 'Motorista de viagem: conferir horário na planilha do tráfego.';
      else if (/hospital|doente|n[ãa]o trabalhou/.test(o)) acao = 'Sem atestado = falta. Conferir e-mail de atestados.';
      else if (/[úu]ltima batida|largada/.test(o)) {
        const { ps, c } = cargaDoDia(e, d.sem);
        if (ps.length) {
          const bat = [ps[0], ps[0] + c];
          acao = `Saída antecipada: escala do mês ${bat.map(fmt).join(' / ')} (carga prevista em 2 batidas) e desconsiderar a pré-assinalada da tarde.`;
          extra.escala = { tipo: 'X', bat }; extra.limpaPre = true;
          add(CAT.IMPORTAR, r.cod, r.dia, 'Saída antecipada informada', acao, extra); marca(r.cod, r.dia); continue;
        }
      }
      add(CAT.VOCE, r.cod, r.dia, 'Resposta em texto livre', acao, extra);
      marca(r.cod, r.dia);
    }

    // 3) problemas do espelho
    for (const [cod, e] of Object.entries(espelho)) {
      if (ign.has(cod)) continue;
      for (const [k, d] of Object.entries(e.dias)) {
        const dia = +k, b = d.bat, g = txtResp(cod, dia), fer = /FERIADO/.test(d.det);
        if (/F[ÉE]RIAS/.test(d.det) && b.length && !tratado.has(cod + '|' + dia)) {
          add(CAT.VOCE, cod, dia, 'Batida em dia de férias', `Desconsiderar ${b.map(fmt).join(', ')}: batida em dia de férias é excluída do ponto.`, { gestor: g, desc: b.slice() });
          marca(cod, dia); continue;
        }
        if (tratado.has(cod + '|' + dia)) continue;
        // batida duplicada (≤15 min): desconsiderar a que dá menos prejuízo (entrada: fica a mais cedo; saída: fica a mais tarde)
        const lancDia = new Set((resp[cod + '|' + dia] || []).filter(x => x.hora).map(x => hm(x.hora)));
        const psJ = (e.prevSem[d.sem] || []).map(hm);
        const trabDe = r => { let t = 0; for (let k = 0; k + 1 < r.length; k += 2) t += (r[k + 1] - r[k] + 1440) % 1440; return t; };
        // batida a mais num dia ímpar: sai a que deixa o intervalo mais parecido com o da jornada; empate → maior trabalhado
        const aMais = arr => {
          const alvo = psJ.length >= 4 ? [psJ[1], psJ[2]] : null;
          const dist = (x, y) => Math.min(Math.abs(x - y), 1440 - Math.abs(x - y));
          let melhor = null, mt = -1, md = Infinity; const cands = [];
          for (let i = 0; i < arr.length; i++) {
            const r = arr.filter((_, j) => j !== i), t = trabDe(r);
            const dv = alvo && r.length >= 4 ? dist(r[1], alvo[0]) + dist(r[2], alvo[1]) : 0;
            cands.push({ sai: arr[i], t, dv });
            if (dv < md - 5 || (Math.abs(dv - md) <= 5 && t > mt)) { md = dv; mt = t; melhor = arr[i]; }
          }
          // "Menor prejuízo" = maior trabalhado — mas se isso cria 2h ou mais de extra e existe opção que fecha o dia perto do
          // previsto, a batida estranha é a outra (caso REC 02/10/2026: 07:35 12:06 14:13 17:43 22:00 → sai 22:00, não 17:43).
          const prevD = hm(d.prev) || 0; let aviso = '';
          if (prevD) {
            const alt = cands.filter(c => Math.abs(c.dv - md) <= 5 && Math.abs(c.t - prevD) <= 60).sort((x, y) => y.t - x.t)[0];
            if (alt && mt - alt.t >= 120) { aviso = ` Mantê-la deixaria o dia com ${dur(mt)} trabalhadas (${dur(mt - prevD)} de extra); sem ela o dia fecha em ${dur(alt.t)}.`; melhor = alt.sai; mt = alt.t; }
          }
          return { sai: melhor, trab: mt, aviso };
        };
        const preJ0 = new Set(psJ.slice(1, -1)), ehPre = x => preJ0.has(x) && !lancDia.has(x);
        for (let i = 1; i < b.length; i++) {
          const dif = (b[i] - b[i - 1] + 1440) % 1440;
          // Pré-assinalada colada na ENTRADA ou na SAÍDA real do dia não é duplicada (José caso 03/10 e caso 13/10/2026:
          // a saída real veio logo depois da volta pré-assinalada). Já uma batida real no MEIO do dia colada na pré-assinalada
          // é intervalo de poucos minutos (bateu só a ida ou só a volta): sai a real, para valer o intervalo pré-assinalado (casos FOR set/2026).
          const umaPre = ehPre(b[i]) !== ehPre(b[i - 1]), iReal = ehPre(b[i]) ? i - 1 : i;
          if (dif <= 15 && !(ehPre(b[i]) && ehPre(b[i - 1])) && !(umaPre && (iReal === 0 || iReal === b.length - 1))) {
            // candidatas: uma das duas batidas coladas (se uma veio do gestor, é ela). Se o dia ficar ímpar, sai mais uma.
            // Antes a escolha era pela posição (par/ímpar), o que podia deixar o dia com batida faltando (caso 19/09: 07:09 12:02 12:18 12:20).
            let cands = [i, i - 1];
            if (lancDia.has(b[i])) cands = [i]; else if (lancDia.has(b[i - 1])) cands = [i - 1]; else if (umaPre) cands = [iReal];
            let best = null;
            for (const c of cands) {
              const resto = b.filter((_, j) => j !== c); let descs = [b[c]], t, impar = false;
              // sem as pré-assinaladas (o Fortes refaz o intervalo sozinho depois que a duplicada sai)
              const preJ = new Set(psJ.slice(1, -1)), reaisR = resto.filter(x => !preJ.has(x) || lancDia.has(x));
              if (reaisR.length % 2 === 0) t = trabDe(resto.length % 2 ? reaisR : resto);
              // sobrou ímpar: só sai mais uma se há MAIS batidas do que a jornada prevê (batida a mais); senão é batida faltando
              else if (reaisR.length >= 3 && reaisR.length > psJ.length && !d.vazios.length) { const m = aMais(reaisR); descs.push(m.sai); t = m.trab; }
              else { t = -1 + (c === i ? 0.5 : 0); impar = true; }
              if (!best || t > best.t) best = { descs, t, impar };
            }
            const origem = x => lancDia.has(x) ? 'informada pelo gestor' : 'relógio';
            add(CAT.VOCE, cod, dia, 'Batida duplicada', `Desconsiderar ${best.descs.map(x => fmt(x) + ' (' + origem(x) + ')').join(' e ')}${best.impar ? '. Depois disso o dia ainda fica com batida faltando — cobrar o gestor.' : ' — fica o maior trabalhado, com o dia fechado.'}`, { gestor: g, desc: best.descs });
            marca(cod, dia); break;
          }
        }
        if (tratado.has(cod + '|' + dia)) continue;
        if (fer && b.length) {
          if (b.length % 2) add(CAT.GESTOR, cod, dia, 'Feriado sem saída', 'Qual o horário de saída?', { gestor: g });
          else if (b.length === 2) {
            const t = (b[1] - b[0] + 1440) % 1440, itv = intervalo(t);
            const ini = b[0], fim = b[0] + t; let s0 = 720;
            if (s0 <= ini || s0 + itv >= fim) s0 = Math.floor((ini + fim - itv) / 2);       // 12:00 se couber; senão no meio do dia
            if (itv) add(CAT.IMPORTAR, cod, dia, 'Feriado sem intervalo', `Trabalhou ${dur(t)} no feriado sem intervalo: AFDT ${fmt(s0)} e ${fmt(s0 + itv)}. Sem escala — a PREV do feriado fica zerada.`, { afdt: [fmt(s0), fmt(s0 + itv)] });
          }
          marca(cod, dia); continue;
        }
        const aus = /AUS[ÊE]NCIA/.test(d.det) || b.length % 2 === 1;
        const diaInteiro = !b.length && /FALTA \[FOLHA\]/.test(d.det);
        const ant = (e.dias[dia - 1] || {}).bat || [];
        if (b.length === 1 && b[0] < 720 && ant[0] !== undefined && ant[0] >= 1080 && !d.vazios.length) {   // só se o turno anterior COMEÇOU à noite
          // batida isolada de manhã depois do turno da noite = saída REAL tardia (caso caso 05/09/2026)
          const da = e.dias[dia - 1] || {}, pa = cargaDoDia(e, da.sem || '');
          const doGestor = (resp[cod + '|' + dia] || []).concat(resp[cod + '|' + (dia - 1)] || []).filter(x => x.hora && hm(x.hora) < b[0] && hm(x.hora) < 720).map(x => x.hora);
          if (pa.ps.length >= 2) {
            const limite = Math.ceil((b[0] + 30) / 60) * 60;
            add(CAT.IMPORTAR, cod, dia - 1, 'Saída real depois do previsto (turno noturno)', `${fmt(b[0])} do dia ${dd(dia)} é a saída real do turno de ${dd(dia - 1)}. Escala do mês no dia ${dd(dia - 1)}: ${pa.ps.map(fmt).join(' / ')} com Limite ${fmt(limite)}${doGestor.length ? '; excluir a saída informada pelo gestor (' + doGestor.join(', ') + ')' : ''}. Marcar o intervalo depois.`, { gestor: g, escala: { tipo: 'X', bat: pa.ps, limite }, naoInserirDia: [[dia, doGestor.map(hm)], [dia - 1, doGestor.map(hm)]] });
          } else add(CAT.VOCE, cod, dia, 'Batida isolada após turno noturno', `Conferir se ${fmt(b[0])} é a saída real do turno de ${dd(dia - 1)}.`, { gestor: g });
          marca(cod, dia); continue;
        }
        // Turno da noite em dia sem jornada (sábado): linha começando depois da meia-noite com número ímpar de batidas
        // é ENTRADA faltando, não batida a mais (caso REC 03/10/2026: 00:05 01:58 08:08).
        const noturnoEmp = Object.values(e.prevSem).some(v => v.length && hm(v[0]) >= 1080);
        if (b.length % 2 === 1 && b.length >= 3 && !d.vazios.length && b[0] < 360 && noturnoEmp && !psJ.length) {
          add(CAT.GESTOR, cod, dia, 'Entrada faltando (turno da noite)', `As batidas ${b.map(fmt).join(', ')} são da madrugada/manhã seguinte: turno iniciado no dia ${dd(dia)} à noite, sem a batida de entrada. Qual foi o horário de entrada?`, { gestor: g });
          marca(cod, dia); continue;
        }
        // (Dia de 2 batidas reais com o intervalo pré-assinalado no meio — ex.: sábado à noite 21:04 … 02:28 — fica como está:
        //  em set/2026 o Breno manteve esses dias sem escala; o intervalo pré-assinalado vale.)
        if (b.length % 2 === 1 && !d.vazios.length && b.length >= 3) {
          // fica a combinação cujo intervalo (S1/E2) mais se parece com o intervalo da jornada; empate → maior trabalhado
          const am = aMais(b), melhor = am.sai;
          add(CAT.VOCE, cod, dia, 'Batida a mais', am.aviso ? `Desconsiderar ${fmt(melhor)}.${am.aviso} Conferir a origem.` : `Desconsiderar ${fmt(melhor)} (a que dá menos prejuízo ao empregado; ver origem).`, { gestor: g, desc: [melhor] });
          marca(cod, dia); continue;
        }
        // Dia com 4 batidas e sem ausência, mas o Fortes apurou HE e atraso juntos: um par muito curto (até 1h30) longe do
        // intervalo da jornada é batida a mais (caso 09/09: 06:52 07:17 14:00 19:16 · caso 11/09: 05:45 06:39 12:20 17:01).
        // Sai a batida do meio do par curto — mantém a entrada/saída e o maior trabalhado; o Fortes volta a pré-assinalar o intervalo.
        if (b.length === 4 && !d.vazios.length && psJ.length >= 4 && psJ[0] < psJ[3] && (hm(d.hExtra) || 0) > 0 && (hm(d.atSa) || 0) > 0 && b[0] < b[1] && b[1] < b[2] && b[2] < b[3]) {
          let sai = null;
          if (b[1] - b[0] <= 90 && b[1] < psJ[1] - 120) sai = b[1];
          else if (b[3] - b[2] <= 90 && b[2] > psJ[2] + 120) sai = b[2];
          if (sai !== null) {
            add(CAT.VOCE, cod, dia, 'Batida a mais (trecho curto)', `Desconsiderar ${fmt(sai)} (${lancDia.has(sai) ? 'informada pelo gestor' : 'relógio'}): o Fortes apurou HE ${d.hExtra} e atraso ${d.atSa} no mesmo dia por causa dela. Conferir a origem antes.`, { gestor: g, desc: [sai] });
            marca(cod, dia); continue;
          }
        }
        if (aus) {
          const falta = d.vazios.join(', ') || 'batida';
          add(g ? CAT.VOCE : CAT.GESTOR, cod, dia, 'Batida faltando', g ? `Gestor respondeu mas o dia não fechou (${falta}).` : `Falta ${falta}. Qual o horário?`, { gestor: g });
          marca(cod, dia);
        } else if (diaInteiro && !g) {
          add(CAT.GESTOR, cod, dia, 'Dia inteiro sem batida', 'Folga, falta ou atestado?', {});
          marca(cod, dia);
        }
      }
    }

    // 4) relatório Batida Inexistente: o que ainda não foi classificado
    const porDia = {};
    for (const x of inexistente) (porDia[x.cod + '|' + x.dia] = porDia[x.cod + '|' + x.dia] || []).push(x.data + ' ' + x.hora);
    for (const [k, hs] of Object.entries(porDia)) {
      const [cod, dia] = k.split('|'); if (ign.has(cod) || tratado.has(k)) continue;
      const g = txtResp(cod, +dia);
      if ((resp[k] || []).some(r => r.tipo === 'FALTA')) continue;     // falta confirmada
      add(g ? CAT.VOCE : CAT.GESTOR, cod, +dia, 'Batida inexistente (Fortes)', `Previstas sem batida: ${hs.join(', ')}.`, { gestor: g });
    }
    itens.sort((a, b) => a.cat.localeCompare(b.cat) || a.cod.localeCompare(b.cod) || a.dia - b.dia);
    itens.reconstruidos = reconstruidos;
    return itens;
  }

  // ───────────────────────── geração de arquivos ─────────────────────────
  // Uma escala só por mês: X (trabalho) e F (folga) juntos; folgas entram na linha de trabalho do empregado quando ele tem só uma.
  function arquivoEscala(itens) {
    const linhas = {}, folgas = {};
    for (const it of itens.filter(i => i.escala)) {
      if (it.escala.tipo === 'F') { (folgas[it.cod] = folgas[it.cod] || new Set()).add(it.dia); continue; }
      const hs = it.escala.bat.map(fmt), lim = it.escala.limite ? fmt(it.escala.limite) : '';
      const k = it.cod + '|' + hs.join(',') + '|' + lim;
      (linhas[k] = linhas[k] || { cod: it.cod, hs, lim, dias: {} }).dias[it.escala.dia || it.dia] = 'X';
    }
    const porCod = {}; for (const l of Object.values(linhas)) (porCod[l.cod] = porCod[l.cod] || []).push(l);
    for (const [cod, ds] of Object.entries(folgas)) {
      if (porCod[cod] && porCod[cod].length === 1) ds.forEach(d => { if (!porCod[cod][0].dias[d]) porCod[cod][0].dias[d] = 'F'; });
      else { const l = { cod, hs: [], lim: '', dias: {} }; ds.forEach(d => l.dias[d] = 'F'); linhas[cod + '|F'] = l; }
    }
    return Object.values(linhas).sort((a, b) => a.cod.localeCompare(b.cod)).map(l => {
      const n = Math.max(...Object.keys(l.dias).map(Number));
      const hs = [...l.hs, ...Array(8 - l.hs.length).fill('')];
      return [l.cod, ...hs, l.lim, '', '', '', '', '', '', ...Array.from({ length: n }, (_, i) => l.dias[i + 1] || '')].join(';');
    }).join(String.fromCharCode(13, 10)) + String.fromCharCode(13, 10);
  }

  const api = { lerEspelho, lerBatidaInexistente, lerValidacao, lerAFDT, filtrarMes, pis11, analisar, arquivoEscala, CAT, hm, fmt, dur, intervalo };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Motor = api;
})(typeof window !== 'undefined' ? window : globalThis);
