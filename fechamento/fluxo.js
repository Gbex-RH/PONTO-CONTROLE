/* Fluxo completo do fechamento — a MESMA sequência para a tela (index.html) e para os testes no Node.
 * Antes a sequência vivia só dentro do index.html e os testes tinham uma cópia: qualquer mudança podia deixar as duas diferentes.
 */
(function (root) {
  'use strict';
  const node = typeof module !== 'undefined' && module.exports;
  const M = node ? require('./motor.js') : root.Motor;
  const A = node ? require('./auditoria.js') : root.Auditoria;
  const T = node ? require('./motoristas.js') : root.Motoristas;
  const S = node ? require('./simulacao.js') : root.Simulacao;
  const B = node ? require('./backup.js') : root.Backup;
  const dd = n => String(n).padStart(2, '0');

  // dados = { espelho, validacao, afdt, inexistente, viagens, backup, apoio } · opts = { filial, ignorar, mesRef:{mes,ano} }
  function processar(dados, { filial = 'REC', ignorar = [], mesRef } = {}) {
    const espelho = dados.espelho, validacao = dados.validacao || [], afdt = dados.afdt || [], avisos = [];
    let lista = M.analisar({ espelho, inexistente: dados.inexistente || [], validacao, afdt, ignorar });
    const reconstruidos = lista.reconstruidos || 0;
    lista = lista.concat(A.auditar(espelho, { filial, ignorar }));
    let motor3 = null;
    if (dados.viagens) {
      motor3 = T.analisarMotoristas(dados.viagens, espelho, { ...(mesRef || {}), ignorar, afdt });
      const ja = new Set(lista.map(i => i.cod + '|' + i.dia + '|' + i.tipo));
      const novos = motor3.itens.filter(i => !ja.has(i.cod + '|' + i.dia + '|' + i.tipo));
      // "dia sem batida, mas com viagem" substitui a pergunta genérica "folga, falta ou atestado?"
      const comViagem = new Set(novos.filter(i => /com viagem/.test(i.tipo)).map(i => i.cod + '|' + i.dia));
      lista = lista.filter(i => !(comViagem.has(i.cod + '|' + i.dia) && /Dia inteiro sem batida/.test(i.tipo))).concat(novos);
    }
    lista = B.enriquecer(lista, dados.backup);
    // espelho simulado (1ª passada) → intervalos de sábado/domingo e janta pelas regras da TI → simulação final
    lista.forEach(i => i.ok = !/^4/.test(i.cat) || !!i.naoInserir);
    const comTrafego = new Set(lista.filter(i => i.trafego).map(i => i.cod + '|' + i.dia));
    const sim1 = S.simular({ espelho, itens: lista, afdt, ignorar });
    // (a janta 19:00/19:30 vale também para motorista em dia de viagem: em set/2026 o Breno manteve — caso 25/09, caso 30/09)
    lista = lista.concat(S.intervalosTI(sim1, { comTrafego }));
    lista = S.filtrarResolvidos(lista, S.simular({ espelho, itens: lista, afdt, ignorar }));
    // dia que continua com batida faltando DEPOIS de tudo aplicado e não tem nenhum item na lista (ex.: home office que bateu
    // 3 vezes no app e o gestor lançou de novo a entrada): precisa aparecer para cobrar o gestor
    {
      const simF = S.simular({ espelho, itens: lista.filter(i => i.ok !== false), afdt, ignorar });
      const comItem = new Set(lista.filter(i => /^[123]/.test(i.cat)).map(i => i.cod + '|' + i.dia));
      const troca = new Set(lista.filter(i => i.trocaJornada).map(i => i.cod));       // quem vai trocar de jornada é reprocessado depois
      for (const e of Object.values(simF)) for (const d of Object.values(e.dias)) {
        if (d.situacao !== 'batida faltando' || comItem.has(e.codigo + '|' + d.num) || !d.mudou || troca.has(e.codigo)) continue;
        const novas = d.bats.filter(b => b.origem !== 'espelho' && b.origem !== 'automática').map(b => M.fmt(b.t));
        lista.push({ cat: M.CAT.GESTOR, cod: e.codigo, nome: e.nome, dia: d.num, sem: d.sem, espelho: d.antes, det: d.det, gestor: '',
          tipo: 'Batida faltando (depois das batidas do app)', acao: `Com as batidas do app (${novas.join(', ')}) o dia fica com ${d.bats.length}: ${d.depois}. Falta uma batida — qual? (Resposta do gestor repetindo uma batida que já existia é descartada.)` });
      }
    }
    lista = B.aplicarApoio(lista, dados.apoio, mesRef);
    const ordem = Object.values(M.CAT);
    lista.sort((a, b) => ordem.indexOf(a.cat) - ordem.indexOf(b.cat) || a.cod.localeCompare(b.cod) || a.dia - b.dia);
    lista.forEach((it, i) => { it.id = i; it.ok = !/^4/.test(it.cat) || !!it.naoInserir; });

    // ── avisos sobre os arquivos de entrada
    const foraVal = validacao.length - M.filtrarMes(validacao, espelho).length, foraAfdt = afdt.length - M.filtrarMes(afdt, espelho).length;
    if (foraVal || foraAfdt) avisos.push(`Ignorados por serem de outro mês: ${foraVal} resposta(s) e ${foraAfdt} batida(s) do AFDT.`);
    if (reconstruidos) avisos.push(`${reconstruidos} lançamento(s) dos gestores não vieram no Excel e foram lidos do AFDT do app (exporte o Excel com "Exportado = Todos").`);
    // home office sem AFDT: empregado com o mês praticamente todo "FALTA [FOLHA]" e nenhuma batida no AFDT carregado
    const ign = new Set(ignorar), qtdAfdt = {}, semBatida = [];
    for (const a of afdt) qtdAfdt[M.pis11(a.pis)] = (qtdAfdt[M.pis11(a.pis)] || 0) + 1;
    for (const e of Object.values(espelho)) {
      if (ign.has(e.codigo)) continue;
      const dias = Object.values(e.dias), faltas = dias.filter(d => !d.bat.length && /FALTA \[FOLHA\]/.test(d.det)).length, trab = dias.filter(d => d.bat.length).length;
      if (faltas >= 10 && trab <= 2 && ((e.pis && qtdAfdt[M.pis11(e.pis)]) || 0) < faltas) semBatida.push(e.nome.split(' ').slice(0, 2).join(' '));
    }
    if (semBatida.length) avisos.push(`Quase o mês inteiro sem batida no espelho e sem batidas suficientes no AFDT carregado: ${semBatida.join(', ')}. Se são de home office, faltou carregar o AFDT Home Office (selecione os dois arquivos juntos).`);
    return { itens: lista, motor3, avisos };
  }

  // AFDT ÚNICO do mês: tudo o que está no espelho simulado e ainda não está no espelho do Fortes.
  // A data é a de calendário da batida: a do próprio AFDT do app (b.cal) ou, nas batidas geradas pela ferramenta, a ordem no turno.
  function linhasAFDT(sim, espelho, mesRef) {
    const linhas = new Set(), ult = new Date(mesRef.ano, mesRef.mes, 0).getDate();
    for (const e of Object.values(sim)) {
      const pis = (espelho[e.codigo] || {}).pis; if (!pis) continue;
      for (const d of Object.values(e.dias)) for (const b of d.bats) {
        if (b.origem === 'espelho' || b.origem === 'automática') continue;
        let dia = d.num + (b.cal !== undefined ? b.cal : (b.r >= 1440 ? 1 : 0)), mes = mesRef.mes, ano = mesRef.ano;
        if (dia > ult) { dia -= ult; mes++; if (mes > 12) { mes = 1; ano++; } }
        linhas.add(M.pis11(pis) + dd(dia) + dd(mes) + ano + M.fmt(b.t).replace(':', ''));
      }
    }
    return [...linhas];
  }

  const api = { processar, linhasAFDT };
  if (node) module.exports = api; else root.Fluxo = api;
})(typeof window !== 'undefined' ? window : globalThis);
