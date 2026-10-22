/* Backup do Fortes Ponto (.zip com .bt) — leitura em fluxo (fflate), só o mês e as tabelas necessárias.
 * Formato: texto latin-1; tabela "[NOME]", depois "[col:tipo;...]", depois registros com "|"; "@" = nulo.
 * BTP = batidas (ORIGEM 1 relógio, 2 manual no Fortes, 6 importada AFDT); BTA = pré-assinaladas;
 * DEF = folgas de escala; TDE = turnos de escala por dia.
 */
(function (root) {
  'use strict';
  const ORIGEM = { 1: 'relógio', 2: 'manual no Fortes', 6: 'importada (AFDT)' };
  const TABELAS = new Set(['EPG', 'BTP', 'BTA', 'DEF', 'TDE']);

  function novoLeitor(ym) {
    const r = { batidas: {}, pre: {}, folgas: new Set(), escalas: {}, empregados: {} };
    let tab = null, cab = null;
    const hora = s => (s || '').padEnd(14, '0').slice(8, 10) + ':' + (s || '').padEnd(14, '0').slice(10, 12);
    function linha(l) {
      if (l[0] === '[' && l[l.length - 1] === ']' && l.indexOf(':') < 0) { tab = l.slice(1, -1); cab = null; return; }
      if (!TABELAS.has(tab)) return;
      if (!cab) { cab = l.slice(1, -1).split(';').map(c => c.split(':')[0].toUpperCase()); return; }   // GBLOG grava os nomes em caixa mista
      const p = l.split('|'), v = {}; cab.forEach((c, i) => v[c] = p[i]);
      if (tab === 'EPG') { r.empregados[v.CODIGO] = { pis: v.PIS, nome: v.NOME }; return; }
      const data = v.DATAHORA || v.BTP_PREVISTA || v.DATA || '';
      if (!data.startsWith(ym)) return;
      const k = v.EPG_CODIGO + '|' + (+data.slice(6, 8));
      if (tab === 'BTP') (r.batidas[k] = r.batidas[k] || []).push({ hora: hora(data), origem: ORIGEM[v.ORIGEM] || 'outra', desconsiderada: v.STATUS === '3' });
      else if (tab === 'BTA') (r.pre[k] = r.pre[k] || []).push(hora(data));
      else if (tab === 'DEF') r.folgas.add(k);
      else if (tab === 'TDE') (r.escalas[k] = r.escalas[k] || []).push(hora(v.BTPINICIAL) + '-' + hora(v.BTPFINAL));
    }
    return { linha, resultado: r };
  }

  // Navegador: file = File do input; fflate = window.fflate
  function lerBackupPonto(fflate, file, { mes, ano }, progresso) {
    const ym = String(ano) + String(mes).padStart(2, '0');
    const { linha, resultado } = novoLeitor(ym);
    return new Promise((ok, erro) => {
      let resto = '', lido = 0;
      const dec = new TextDecoder('latin1');
      const unzip = new fflate.Unzip(stream => {
        if (!/\.bt$/i.test(stream.name)) return;
        stream.ondata = (err, dado, fim) => {
          if (err) return erro(err);
          lido += dado.length; if (progresso) progresso(lido);
          const txt = resto + dec.decode(dado, { stream: !fim });
          const ls = txt.split(/\r?\n/); resto = fim ? '' : ls.pop();
          for (const l of ls) if (l) linha(l);
          if (fim) ok(resultado);
        };
        stream.start();
      });
      unzip.register(fflate.UnzipInflate);
      const leitor = file.stream().getReader();
      (function bombear() {
        leitor.read().then(({ done, value }) => { if (done) { unzip.push(new Uint8Array(0), true); return; } unzip.push(value); bombear(); }).catch(erro);
      })();
    });
  }

  // Usa o backup para refinar os itens do motor (origem das batidas, folgas/escalas que já existem)
  function enriquecer(itens, bk) {
    if (!bk) return itens;
    return itens.filter(it => {
      const k = it.cod + '|' + it.dia;
      if (it.escala && it.escala.tipo === 'F' && bk.folgas.has(k)) return false;              // folga já está no Fortes
      if (it.escala && it.escala.tipo === 'X' && bk.escalas[k]) {
        const fmt = v => String(Math.floor(((v % 1440) + 1440) % 1440 / 60)).padStart(2, '0') + ':' + String(((v % 1440) + 1440) % 1440 % 60).padStart(2, '0');
        const sug = []; for (let i = 0; i + 1 < it.escala.bat.length; i += 2) sug.push(fmt(it.escala.bat[i]) + '-' + fmt(it.escala.bat[i + 1]));
        if (sug.join(' / ') === bk.escalas[k].join(' / ')) { it.cat = '4. Conferido — sem ação'; it.acao = `Escala já importada no Fortes (${sug.join(' / ')}).`; delete it.escala; return true; }
      }
      if (it.escala && it.escala.tipo === 'X' && bk.escalas[k]) it.acao += ` ⚠ Já existe escala neste dia no Fortes (${bk.escalas[k].join(' / ')}): conferir antes de importar.`;
      const bs = bk.batidas[k];
      if (bs && /duplicada|a mais|isolada|deslocado|noite/i.test(it.tipo)) it.acao += ` Origem no Fortes: ${bs.map(b => b.hora + ' ' + b.origem).join(', ')}.`;
      if (bk.pre[k] && /faltando|antecipada|duplicada/i.test(it.tipo)) it.acao += ` Pré-assinaladas: ${bk.pre[k].join(', ')}.`;
      return true;
    });
  }

  // Apoio de atestados (gerado pelo apoio_atestados.py): licenças do Fortes Pessoal + e-mails de atestado
  // Apoio de atestados (gerado pelo apoio_atestados.py): só os E-MAILS de atestado.
  // Não dá para garantir se o atestado foi cadastrado no Fortes Pessoal, então a ferramenta só avisa que o e-mail chegou.
  function aplicarApoio(itens, apoio) {
    if (!apoio) return itens;
    const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
    const mails = nome => { const p = norm(nome).split(/\s+/).slice(0, 2).join(' ');
      return (apoio.emails || []).filter(m => norm(m.assunto + ' ' + m.anexos.join(' ')).includes(p)); };
    for (const it of itens) {
      if (!/Atestado|Dia inteiro sem batida|Entrada faltando|hospital|doente|falta/i.test(it.tipo + ' ' + it.acao)) continue;
      const ms = mails(it.nome);
      if (ms.length) it.acao += ` 📧 Chegou e-mail de atestado: ${ms.map(m => m.data.slice(0, 5) + ' "' + m.assunto + '"').join('; ')} — abrir o anexo e conferir as datas.`;
    }
    return itens;
  }

  const api = { novoLeitor, lerBackupPonto, enriquecer, aplicarApoio, ORIGEM };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Backup = api;
})(typeof window !== 'undefined' ? window : globalThis);
