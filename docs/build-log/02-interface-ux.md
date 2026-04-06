# Parte 2 — Interface e UX (02-03/04/2026)

## 2.1 Recording Bar (Barra de Gravacao)
**Commits:** `0359744` → `6b47567`
**O que:** Barra que aparece durante gravacao de voz com botoes de controle.
**Problemas resolvidos:**
- Barra nao aparecia — estava dentro do input-wrapper, movida para fora (`93d17fb`)
- Botoes transbordavam — reduzidos de tamanho + overflow hidden (`6b47567`)
- Padding errado — ajustado para caber no container (`8339404`)
- Transcricao ao vivo — bolha flutuante com texto em tempo real (`ff45f73`)

## 2.2 Welcome Screen e Capacete
**Commits:** `4773182` → `8687aa6`
**O que:** Tela de boas-vindas com capacete Senna animado + particulas.
**Evolucao:**
1. Capacete grande centralizado antes da primeira mensagem
2. Mini mode: capacete encolhe 50% quando chat comeca (`fe82f8d`)
3. Aumentado para 70% — 50% ficou pequeno demais (`00ae0c6`)
4. Particulas continuam no mini mode (`8687aa6`)
**Removidos:** Status "PRONTO" do header (`9835812`), orb amarelo indicador (`9f8c269`)

## 2.3 Cockpit (Painel de Controle)
**Commits:** `fd90176` → `631931b`
**O que:** Painel acima das faixas coloridas mostrando contexto da conversa.
**Evolucao:**
1. Versao simples: titulo e objetivo (`fd90176`)
2. Capacete 120px centralizado com particulas, campos na esquerda (`575026f`)
3. Cockpit Estrategico: auto-captura de insights, painel organizacional (`250102d`)
4. Cockpit Hierarquico: Objetivo → Projeto → Etapa → Tarefa → Ideia (`631931b`)
**Problemas:**
- Icone de cadeado duplicado — ambos SVGs apareciam (`2cfd2c4`)
- Particulas nao iniciavam quando cockpit ficava visivel (`2dab8eb`)
- Cockpit/dashboard vazava para modo sessao (`1946fd0`)
**Decisao:** Botao do Cockpit movido para abaixo do Box na sidebar (`7866db9`)

## 2.4 Modos Home vs Session (`001a6f7`)
**O que:** Separacao completa entre modo HOME (Box) e modo SESSION.
**Como funciona:**
- `setAppMode('home')` — mostra dashboard, chat perpetuo, widgets
- `setAppMode('session')` — mostra chat focado com contexto de sessao
**Funcao unica:** `setAppMode()` controla tudo — classes CSS, visibilidade de elementos, estado
**Sidebar:**
- Botao "Box" (antes era "Inicio") com icone gauge (`20be79e`)
- Botao "Sessao" para novo chat focado
**Sessao lazy:** Sessao so e criada quando primeira mensagem e enviada (`6ad14ff`)

## 2.5 Mensagens e Chat
**Commits:** `b0cca37` → `e81d52b`
**Layout:**
- Mensagens centralizadas com max-width como Grok/ChatGPT (`b0cca37`)
- Renomeado indicador de versao para tema F1 telemetria (`94fc27a`)
- Mensagens posicionadas perto do input, melhor contraste (`83aa063`)
- Scroll fixado — removido justify-content que impedia scroll pra cima (`8eb053d`)
**Botoes de acao nas mensagens:**
- Copiar, retry, branch, ler em voz alta (`01ccdf6`)
- Sempre visiveis, nao so no hover (`7e54505`)
- Editar e copiar para mensagens do usuario (`e54b3a4`)
- Visibilidade corrigida (`0b2e962`)
**Chat Perpetuo (Box):**
- Modo padrao — chat sem sessao, estilo continuo (`b2a0541`)
- Efeito Star Wars fade nas mensagens (`b4cb803`)
- Estilos unificados entre Box e Session (`588a4ab`, `f628276`)
- Largura max 800px centralizada (`b128b89`, `e81d52b`)

## 2.6 Faixas Coloridas (Stripes)
**O que:** Barra horizontal com as cores do capacete de Senna (verde, amarelo, vermelho).
**Posicao:** Movida para borda superior da area principal (`8f89775`)
**Decisao:** Sempre visivel na home screen (`262a3de`)

## 2.7 Dashboard Home (`16215ae`)
**O que:** Dashboard estilo JARVIS com widgets, capacete centralizado, botoes de acao rapida.
**Componentes:** Widgets de status, acoes rapidas, saudacao inteligente.
**Pre-chat session:** Capacete grande centralizado antes da primeira mensagem na sessao (`3e0ffbc`)
**Particulas:** Canvas de particulas adicionado ao hero pre-chat da sessao (`3f33d3d`)

## 2.8 Quick Actions
**Commits:** `5b4990e`, `80b2419`
**O que:** Chips de acao rapida na home (resumo, email, ideia, etc).
**Problema:** Estavam bloqueados por um `return` prematuro no `renderQuickActions()` + `display:none` no HTML.
**Fix:** Removido o early return e o display:none (`80b2419`).

## 2.9 Model Badge (`573d20b`)
**O que:** Indicador de qual IA foi usada para cada resposta.
**Evolucao:**
1. Primeiro: texto inline abaixo da mensagem (ex: "GPT-4O | Custo: 0.003")
2. Final: icone discreto na barra de acoes da mensagem com tooltip mostrando modelo, provider, complexidade e custo
**Decisao de Marlon:** "Nao precisa de uma linha inteira, faz um botaozinho como os outros com tooltip."

## 2.10 Modais de Sistema (`80b2419`)
**Ajuda (`openHelpModal`):**
- 4 secoes: Comandos (12), Prefixos de Modelo (6), Modos (5), Funcionalidades (8)
- Dicas rapidas e footer com versao
**Configuracoes (`openSettingsModal`):**
- Provider/modelo padrao, idioma, volume TTS, auto-speak, walkie-talkie, limite de custo diario
- Salva em `localStorage('senna_settings')`
- Botao "Limpar dados locais" com confirmacao
- Aplica configuracoes de voz imediatamente ao salvar

---

**Commits desta fase:** ~50 commits
**Periodo:** 02/04 a 05/04/2026
