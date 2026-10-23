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
      .map(l => ({ pis: l.slice(0, 11), dia: +l.slice(11, 13), hora: l.slice(19, 21) + ':' + l.slice(21, 23), origem }));
  }

  // ───────────────────────── análise ─────────────────────────
  const CAT = {
    IMPORTAR: '1. Importar (arquivo)',
    VOCE: '2. Você corrige no Fortes',
    GESTOR: '3. Cobrar do gestor',
    INFO: '4. Conferido — sem ação'
  };

  function analisar({ espelho, inexistente = [], validacao = [], afdt = [], ignorar = [] }) {
    const itens = [];
    const add = (cat, cod, dia, tipo, acao, extra = {}) => {
      const e = espelho[cod] || {}; const d = (e.dias || {})[dia] || {};
      itens.push({ cat, cod, nome: e.nome || extra.nome || '', dia, sem: d.sem || '', espelho: d.txt || '', det: d.det || '',
        prev: d.prev || '', trab: d.trab || '', tipo, acao, gestor: extra.gestor || '', ...extra });
    };
    const ign = new Set(ignorar);
    const resp = {};
    for (const r of validacao) (resp[r.cod + '|' + r.dia] = resp[r.cod + '|' + r.dia] || []).push(r);
    const txtResp = (cod, dia) => (resp[cod + '|' + dia] || []).map(r => `${r.tipo.toLowerCase()}${r.hora ? ' ' + r.hora : ''}${r.obs ? ': ' + r.obs : ''}`).join(' | ');
    const pis2cod = {}; for (const [c, e] of Object.entries(espelho)) if (e.pis) pis2cod[e.pis] = c;
    const noAfdt = new Set(afdt.map(a => (pis2cod[a.pis] || a.pis) + '|' + a.dia + '|' + a.hora));
    const tratado = new Set();               // dias já classificados (evita duplicar)
    const marca = (c, d) => tratado.add(c + '|' + d);

    // turno noturno: batida de madrugada do dia D pertence ao turno iniciado em D-1
    const noturnoAnterior = (e, dia, h, extra = []) => {
      const ant = (e.dias[dia - 1] || {}).bat || [];
      const hoje = (e.dias[dia] || {}).bat || [];
      const dAnt = e.dias[dia - 1], psAnt = dAnt ? (e.prevSem[dAnt.sem] || []).map(hm) : [];
      const comecouNoite = (ant[0] !== undefined && ant[0] >= 1080) || (psAnt[0] !== undefined && psAnt[0] >= 1080) || (!ant.length && extra.some(b => b >= 1080));
      return h < 720 && comecouNoite && !hoje.some(b => b >= 720);
    };
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
      const noturnos = [], tarde = [];
      for (const d of trabalhados) {
        if (/FERIADO|LICEN|F[ÉE]RIAS|AFAST/.test(d.det)) continue;
        const ps = (e.prevSem[d.sem] || []).map(hm); if (ps.length < 2) continue;
        const reais = reaisDoDia(e, d); if (!reais.length) continue;
        const primeira = reais[0];
        // turno da noite = batida à noite (18h–24h) seguida de batida de madrugada (0h–4h); com jornada diurna cadastrada
        const noite = reais.find(t => t >= 1080), madrugada = reais.some(t => t <= 240 && noite !== undefined && reais.indexOf(t) > reais.indexOf(noite));
        if (ps[0] < 720 && noite !== undefined && madrugada) { d._ini = noite; noturnos.push(d); }
        else if (primeira >= ps[1] && primeira < 1080 && ps[0] < ps[1] - 120
          // se o gestor informou uma entrada de manhã (ainda não importada), o dia não foi deslocado: é só batida faltando
          && !(resp[cod + '|' + d.num] || []).some(x => x.hora && hm(x.hora) < ps[1])
          // 1ª batida no horário da saída ou da volta do almoço (±45 min) = entrada esquecida, não dia deslocado (caso FOR 01/09)
          // (vale só sem confirmação do gestor: se ele informou um horário da tarde perto da 1ª batida, o dia foi mesmo deslocado — caso FOR 04/09)
          && !(ps.length >= 4 && (Math.abs(primeira - ps[1]) <= 45 || Math.abs(primeira - ps[2]) <= 45)
               && !(resp[cod + '|' + d.num] || []).some(x => x.hora && hm(x.hora) >= ps[1] && Math.abs(hm(x.hora) - primeira) <= 60))) { d._ini = primeira; tarde.push(d); }   // entrou depois da 1a saída prevista
      }
      if (noturnos.length && noturnos.length >= Math.max(5, 0.7 * trabalhados.length)) {
        add(CAT.VOCE, cod, noturnos[0].num, 'Turno da noite o mês todo', `Entrou à noite em ${noturnos.length} de ${trabalhados.length} dias trabalhados, mas a jornada cadastrada é diurna. Trocar a jornada para noturna no Fortes Pessoal e reprocessar; depois desconsiderar batidas do gestor que sobrarem.`, {});
        for (const n of Object.keys(e.dias)) marca(cod, +n);
        ign.add(cod); continue;
      }
      // à tarde praticamente o mês todo = horário cadastrado errado → trocar a jornada, não criar escala dia a dia (caso FOR set/2026)
      if (tarde.length && tarde.length >= Math.max(5, 0.7 * trabalhados.length)) {
        add(CAT.VOCE, cod, tarde[0].num, 'Horário da tarde o mês todo', `Entrou à tarde em ${tarde.length} de ${trabalhados.length} dias trabalhados (ex.: ${fmt(tarde[0]._ini)}), mas a jornada cadastrada começa ${fmt(hm((e.prevSem[tarde[0].sem] || [])[0]))}. Trocar a jornada no Fortes Pessoal e reprocessar.`, {});
        for (const d of tarde) marca(cod, d.num);
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

    // 1) respostas do gestor
    for (const r of validacao) {
      const e = espelho[r.cod]; if (!e || ign.has(r.cod) || tratado.has(r.cod + "|" + r.dia)) continue;
      const d = e.dias[r.dia] || { bat: [], det: '' };
      const g = txtResp(r.cod, r.dia);
      const temTurno = d.bat.length >= 2;
      if (r.tipo === 'FOLGA') {
        if (temTurno) add(CAT.INFO, r.cod, r.dia, 'Folga informada, mas há turno batido', 'Gestor errou — vale a batida. Não lançar folga.', { gestor: g });
        else if (d.bat.length === 1) add(CAT.GESTOR, r.cod, r.dia, 'Folga informada com 1 batida original', 'Batida original sem saída. Foi folga (desconsiderar a batida) ou trabalhou (qual a saída)? Motorista: conferir tráfego.', { gestor: g });
        else if (/FOLGA/.test(d.det)) continue;
        else add(CAT.IMPORTAR, r.cod, r.dia, 'Folga', 'Escala do mês: F', { gestor: g, escala: { tipo: 'F' } });
        marca(r.cod, r.dia);
      } else if (r.tipo === 'FALTA') {
        if (temTurno) add(CAT.INFO, r.cod, r.dia, 'Falta informada, mas há turno batido', 'Gestor errou — não é falta.', { gestor: g });
        marca(r.cod, r.dia);                 // falta sem batida: o Fortes apura sozinho
      } else if (r.tipo === 'ATESTADO') {
        if (/LICEN|AFAST/.test(d.det)) { if (temTurno) add(CAT.VOCE, r.cod, r.dia, 'Atestado com turno batido', 'Conferir se o atestado foi após o expediente.', { gestor: g }); }
        else add(CAT.VOCE, r.cod, r.dia, 'Atestado não cadastrado', 'Cadastrar no Fortes Pessoal (conferir e-mail).', { gestor: g });
        marca(r.cod, r.dia);
      }
    }

    // 2) batidas informadas pelo gestor (lançamentos)
    for (const r of validacao.filter(x => x.tipo.startsWith('LANCAMENTO') && x.hora)) {
      const e = espelho[r.cod]; if (!e || ign.has(r.cod)) continue;
      const d = e.dias[r.dia] || { bat: [], det: '' };
      const h = hm(r.hora); const g = txtResp(r.cod, r.dia);
      if (/LICEN|F[ÉE]RIAS|AFAST/.test(d.det)) { add(CAT.VOCE, r.cod, r.dia, 'Batida informada em dia de afastamento', `Não inserir ${r.hora} (o dia é ${d.det.toLowerCase()}).`, { gestor: g, naoInserir: [h] }); marca(r.cod, r.dia); continue; }
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
      if (fechado && !/noite|noturn|hospital|doente|n[ãa]o trabalhou/.test(o)) { marca(r.cod, r.dia); continue; }  // texto só confirma o horário
      let acao = 'Ler a observação e decidir.', extra = { gestor: g };
      if (/curso/.test(o) || (!d.bat.length && /aprendiz/.test(o))) acao = 'Aprendiz: confirmar com o gestor se foi curso e justificar a falta.';
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
          add(CAT.VOCE, cod, dia, 'Batida em dia de férias', `Batida(s) ${b.map(fmt).join(', ')} em dia de férias. Conferir: desconsiderar a batida ou corrigir o período de férias.`, { gestor: g });
          marca(cod, dia); continue;
        }
        if (tratado.has(cod + '|' + dia)) continue;
        // batida duplicada (≤15 min): desconsiderar a que dá menos prejuízo (entrada: fica a mais cedo; saída: fica a mais tarde)
        const lancDia = new Set((resp[cod + '|' + dia] || []).filter(x => x.hora).map(x => hm(x.hora)));
        for (let i = 1; i < b.length; i++) {
          const dif = (b[i] - b[i - 1] + 1440) % 1440;
          if (dif <= 15) {
            let sai = (i - 1) % 2 === 0 ? b[i] : b[i - 1];
            if (lancDia.has(b[i])) sai = b[i]; else if (lancDia.has(b[i - 1])) sai = b[i - 1];
            const origem = lancDia.has(sai) ? 'informada pelo gestor (erro do gestor)' : 'relógio (erro do empregado)';
            add(CAT.VOCE, cod, dia, 'Batida duplicada', `Desconsiderar ${fmt(sai)} — ${origem}.`, { gestor: g, desc: [sai] });
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
          // batida isolada de manhã depois do turno da noite = saída REAL tardia (caso 05/09/2026)
          const da = e.dias[dia - 1] || {}, pa = cargaDoDia(e, da.sem || '');
          const doGestor = (resp[cod + '|' + dia] || []).concat(resp[cod + '|' + (dia - 1)] || []).filter(x => x.hora && hm(x.hora) < b[0] && hm(x.hora) < 720).map(x => x.hora);
          if (pa.ps.length >= 2) {
            const limite = Math.ceil((b[0] + 30) / 60) * 60;
            add(CAT.IMPORTAR, cod, dia - 1, 'Saída real depois do previsto (turno noturno)', `${fmt(b[0])} do dia ${dd(dia)} é a saída real do turno de ${dd(dia - 1)}. Escala do mês no dia ${dd(dia - 1)}: ${pa.ps.map(fmt).join(' / ')} com Limite ${fmt(limite)}${doGestor.length ? '; excluir a saída informada pelo gestor (' + doGestor.join(', ') + ')' : ''}. Marcar o intervalo depois.`, { gestor: g, escala: { tipo: 'X', bat: pa.ps, limite }, naoInserirDia: [[dia, doGestor.map(hm)], [dia - 1, doGestor.map(hm)]] });
          } else add(CAT.VOCE, cod, dia, 'Batida isolada após turno noturno', `Conferir se ${fmt(b[0])} é a saída real do turno de ${dd(dia - 1)}.`, { gestor: g });
          marca(cod, dia); continue;
        }
        if (b.length % 2 === 1 && !d.vazios.length && b.length >= 3) {
          // fica a combinação cujo intervalo (S1/E2) mais se parece com o intervalo da jornada; empate → maior trabalhado
          const psJ = (e.prevSem[d.sem] || []).map(hm), alvo = psJ.length >= 4 ? [psJ[1], psJ[2]] : null;
          const dist = (x, y) => Math.min(Math.abs(x - y), 1440 - Math.abs(x - y));
          let melhor = null, mt = -1, md = Infinity;
          for (let i = 0; i < b.length; i++) {
            const r = b.filter((_, j) => j !== i); let t = 0; for (let k = 0; k + 1 < r.length; k += 2) t += (r[k + 1] - r[k] + 1440) % 1440;
            const dv = alvo && r.length >= 4 ? dist(r[1], alvo[0]) + dist(r[2], alvo[1]) : 0;
            if (dv < md - 5 || (Math.abs(dv - md) <= 5 && t > mt)) { md = dv; mt = t; melhor = b[i]; }
          }
          add(CAT.VOCE, cod, dia, 'Batida a mais', `Desconsiderar ${fmt(melhor)} (a que dá menos prejuízo ao empregado; ver origem).`, { gestor: g, desc: [melhor] });
          marca(cod, dia); continue;
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
    return itens.sort((a, b) => a.cat.localeCompare(b.cat) || a.cod.localeCompare(b.cod) || a.dia - b.dia);
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

  const api = { lerEspelho, lerBatidaInexistente, lerValidacao, lerAFDT, analisar, arquivoEscala, CAT, hm, fmt, dur, intervalo };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Motor = api;
})(typeof window !== 'undefined' ? window : globalThis);
