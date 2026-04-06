# Parte 1 — Fundacao (02/04/2026)

## 1.1 Commit Inicial (`c95d3f7`)
**O que:** Criacao do projeto SENNA v2.0 como plataforma de chat AI.
**Por que:** Marlon queria um assistente AI personalizado para o Grupo Romper, com interface propria em vez de depender de ChatGPT/Claude.
**Arquivos:** script.js, server.js, index.html, style.css — stack vanilla JS + Node.js puro (sem frameworks).
**Decisao importante:** Nao usar React/Vue/Next — manter tudo em vanilla JS para velocidade de prototipacao e controle total. O server.js e um HTTP server puro sem Express.

## 1.2 Deploy na VPS (`a9e3086`)
**O que:** Script de deploy automatizado para VPS.
**Decisao:** Deploy via SSH direto, sem CI/CD complexo nesta fase.

## 1.3 Login e Autenticacao (`32f0354` → `edad9bd`)
**O que:** Pagina de login com autenticacao Google e email via Supabase Auth.
**Decisoes:**
- Usar Supabase como backend (auth + database) — sem construir backend proprio
- Login com Google OAuth como primario
- Restricao de dominio: apenas emails `@romper.global` podem acessar (`2e279e7`)
- Feedback visual nos erros de login
**Problemas encontrados:**
- Conflito de variavel global `supabase` entre o CDN do Supabase e o codigo local (`d4c6c82`) — renomeado para `supabaseClient`
- Supabase CDN mudou API — fixado na versao v2.45.0 (`0077a37`)
**Icone/Branding:**
- Capacete Senna como icone principal (`e4d6d17`, `ae26cb9`)
- Aumentado para 120px na tela de login (`491c782`)

## 1.4 Sidebar (`faaa2f1`)
**O que:** Sidebar colapsavel com icones grandes e labels.
**Decisao:** Sidebar mostra icones com texto abaixo quando colapsada, nao apenas icones pequenos.
**Fix:** Esconder botao toggle no modo colapsado, manter so o icone do capacete (`7e842f9`)

## 1.5 Anexos e Input Bar (`f4e037f` → `2d0fa45`)
**O que:** Sistema de anexos com camera e arquivo.
**Evolucao:**
1. Primeiro: botao camera separado + attach menu
2. Depois: dois botoes separados (camera + clip)
3. Final: botao unico alternando icone camera/clip com menu popup
**Decisao:** Input bar sem max-width, ocupando largura total (`608094f`)

## 1.6 Deploy Automatico (`779c70d`)
**O que:** Endpoint `/api/deploy` como webhook do GitHub.
**Como funciona:** GitHub envia POST no push → server executa `git pull` + restart.
**Seguranca:** Verificacao de assinatura HMAC adicionada depois (`8297990`)

## 1.7 SENNA Proativo (`f1c12de`)
**O que:** SENNA pergunta pelo objetivo do usuario ao abrir um novo chat, age como consultor.
**Ideia central:** Nao esperar o usuario saber o que quer — SENNA deve guiar, perguntar, sugerir.
**Decisao de Marlon:** "O SENNA tem que ser proativo como um consultor. Primeiro ele pergunta, entende o contexto, depois age."

## 1.8 Perfil Adaptativo (`80a1db6`)
**O que:** Deteccao automatica de criancas, idosos e pessoas com baixa escolaridade.
**Como:** Analise do padrao de digitacao, vocabulario e velocidade.
**Resposta:** SENNA adapta linguagem, tamanho de fonte e complexidade das respostas.

## 1.9 System Prompt (`1f8c027`)
**O que:** Prompt estruturado com protocolo de analise.
**Decisao:** SENNA analisa a mensagem em 4 passos antes de responder (entender, contexto, planejar, executar).
**Genero:** SENNA e masculino (`edb54ef`).

---

**Commits desta fase:** c95d3f7 → b05c4b2 (16 commits)
**Periodo:** 02/04/2026 20h → 03/04/2026 02h
