/* Planilha do Movimento 3 (tempo de espera) no padrão do arquivo de agosto/2026
 * (V:\Setorpessoal\Documentos Setor Pessoal\HORA EXTRA GBEX 2026\08 AGO\MOVIMENTO3_Tempo_Espera_REC_Agosto2026.xlsx).
 * Usa ExcelJS (precisa de estilos; o SheetJS gratuito não grava cores).
 */
(function (root) {
  'use strict';
  const MESES = ['JANEIRO', 'FEVEREIRO', 'MARÇO', 'ABRIL', 'MAIO', 'JUNHO', 'JULHO', 'AGOSTO', 'SETEMBRO', 'OUTUBRO', 'NOVEMBRO', 'DEZEMBRO'];
  const ABREV = ['JAN', 'FEV', 'MAR', 'ABR', 'MAI', 'JUN', 'JUL', 'AGO', 'SET', 'OUT', 'NOV', 'DEZ'];
  const hms = m => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:00`;
  const borda = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
  const preencher = cor => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + cor } });

  function cel(ws, ref, valor, { negrito = false, fundo = null, cor = '000000', alinhar = 'center', formato = null } = {}) {
    const c = ws.getCell(ref);
    c.value = valor; c.font = { bold: negrito, color: { argb: 'FF' + cor } };
    c.alignment = { horizontal: alinhar, vertical: 'middle', wrapText: true }; c.border = borda;
    if (fundo) c.fill = preencher(fundo);
    if (formato) c.numFmt = formato;
  }

  // lista: [{codigo, nome}] na ordem desejada; espera: {NOME: {carga, posto}} em minutos
  async function movimento3(ExcelJS, { filial, mes, ano, salario, lista, espera }) {
    const wb = new ExcelJS.Workbook();
    const tot = n => espera[n] || { carga: 0, posto: 0 };
    const abas = [['1. Posto Fiscal', `POSTO FISCAL — ${filial} — ${MESES[mes - 1]} ${ano}`, 'TOTAL POSTO FISCAL', 'posto'],
                  ['2. Carga Descarga', `CARGA/DESCARGA (limitado a 2h/dia) — ${filial} — ${MESES[mes - 1]} ${ano}`, 'TOTAL CARGA/DESCARGA', 'carga']];
    for (const [nome, titulo, rot, k] of abas) {
      const ws = wb.addWorksheet(nome);
      ws.columns = [{ width: 35 }, { width: 22 }, { width: 5 }];
      ws.mergeCells('A1:C1'); ws.mergeCells('A2:C2');
      cel(ws, 'A1', titulo, { negrito: true, fundo: '1F4E79', cor: 'FFFFFF' });
      cel(ws, 'A2', 'Guanabara Express Transporte de Cargas Ltda', { fundo: 'D6E4F0' });
      cel(ws, 'A3', 'NOME', { negrito: true, fundo: '2E75B6', cor: 'FFFFFF' });
      cel(ws, 'B3', rot, { negrito: true, fundo: '2E75B6', cor: 'FFFFFF' });
      let soma = 0;
      lista.forEach((p, i) => { const v = tot(p.nome)[k]; soma += v; cel(ws, 'A' + (4 + i), p.nome, { alinhar: 'left' }); cel(ws, 'B' + (4 + i), hms(v)); });
      const r = 4 + lista.length;
      cel(ws, 'A' + r, 'TOTAL', { negrito: true, fundo: 'DDEBF7', alinhar: 'left' }); cel(ws, 'B' + r, hms(soma), { negrito: true, fundo: 'DDEBF7' });
    }
    const ws = wb.addWorksheet('3. Resumo');
    ws.columns = [12, 30, 14, 5, 5, 18, 5, 16, 5, 14, 5, 14].map(w => ({ width: w }));
    ws.mergeCells('A1:L1'); cel(ws, 'A1', `TEMPO DE ESPERA - ${filial} - ${ABREV[mes - 1]}/${String(ano).slice(2)}`, { negrito: true });
    const cab = [['A3', null, 'MATRÍCULA'], ['B3', 'B3:E3', 'NOME'], ['F3', 'F3:G3', 'TOTAL TEMPO\nREMUNERADO'], ['H3', 'H3:I3', 'SALÁRIO BASE'], ['J3', 'J3:K3', 'SALÁRIO HORA'], ['L3', null, 'TOTAL 30%']];
    for (const [ref, rng, t] of cab) { if (rng) ws.mergeCells(rng); cel(ws, ref, t, { negrito: true, fundo: 'D9D9D9' }); }
    let tm = 0, tv = 0;
    lista.forEach((p, i) => {
      const r = 4 + i, m = tot(p.nome).carga + tot(p.nome).posto, v = Math.round(m / 60 * salario / 220 * 0.3 * 100) / 100;
      tm += m; tv += v;
      for (const rng of [`B${r}:E${r}`, `F${r}:G${r}`, `H${r}:I${r}`, `J${r}:K${r}`]) ws.mergeCells(rng);
      cel(ws, 'A' + r, +p.codigo || p.codigo, { negrito: true }); cel(ws, 'B' + r, p.nome, { negrito: true }); cel(ws, 'F' + r, hms(m));
      cel(ws, 'H' + r, salario, { formato: '"R$" #,##0.00' }); cel(ws, 'J' + r, Math.round(salario / 220 * 100) / 100, { formato: '"R$" #,##0.00' });
      cel(ws, 'L' + r, v, { formato: '"R$" #,##0.00' });
    });
    const r = 5 + lista.length;
    for (const rng of [`B${r}:E${r}`, `F${r}:G${r}`, `H${r}:I${r}`, `J${r}:K${r}`]) ws.mergeCells(rng);
    cel(ws, 'B' + r, 'TOTAL', { negrito: true }); cel(ws, 'F' + r, hms(tm), { negrito: true });
    cel(ws, 'H' + r, '-', { negrito: true }); cel(ws, 'J' + r, '-', { negrito: true });
    cel(ws, 'L' + r, Math.round(tv * 100) / 100, { negrito: true, formato: '"R$" #,##0.00' });
    return { buffer: await wb.xlsx.writeBuffer(), nome: `MOVIMENTO3_Tempo_Espera_${filial}_${MESES[mes - 1][0] + MESES[mes - 1].slice(1).toLowerCase()}${ano}.xlsx`, totalMin: tm, totalR$: tv };
  }

  const api = { movimento3 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Planilhas = api;
})(typeof window !== 'undefined' ? window : globalThis);
