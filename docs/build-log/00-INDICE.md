# SENNA — Build Log Completo

> Registro de todas as decisoes, implementacoes e ideias do prototipo SENNA.
> Cada parte documenta uma fase do desenvolvimento para referencia futura
> quando formos planejar e implementar a versao final do sistema.

## Partes

1. [Parte 1 — Fundacao](01-fundacao.md) — Setup inicial, login, deploy, sidebar, UI basica (02/04)
2. [Parte 2 — Interface e UX](02-interface-ux.md) — Chat, cockpit, modos Home/Session, mensagens (02-03/04)
3. [Parte 3 — Voz e TTS](03-voz-tts.md) — Kokoro TTS, Voice Engine, walkie-talkie, cockpit de voz (03-04/04)
4. [Parte 4 — Inteligencia](04-inteligencia.md) — Multi-LLM router, streaming, memoria, budget (03/04)
5. [Parte 5 — Modulos Avancados](05-modulos-avancados.md) — Projeto, Sherlock, Radar, Descobertas, Skills, Self-Actions (05/04)
6. [Parte 6 — Infraestrutura](06-infraestrutura.md) — Docker, PWA, n8n, deploy, sessions, Google Drive (03-04/04)
7. [Parte 7 — Bugs e Fixes](07-bugs-fixes.md) — Todos os bugs encontrados e como foram resolvidos
8. [Parte 8 — Ideias e Visao Futura](08-visao-futura.md) — O que foi discutido mas nao implementado, direcao pro produto final

## Estatisticas

- **Total de commits:** 135
- **Periodo:** 02/04/2026 a 06/04/2026 (5 dias)
- **Arquivos principais:** script.js (~7400 linhas), voice-engine.js (~1300 linhas), server.js (~1035 linhas), style.css (~4600 linhas), index.html (~630 linhas)
- **Repositorio:** gruporomper/senna (GitHub privado)

## Como usar este log

Quando for planejar a versao final:
1. Leia o Indice para ter a visao geral
2. Aprofunde-se na parte relevante
3. Consulte a Parte 8 para ideias que ficaram pendentes
4. Use os numeros de commit para ver o codigo exato de cada mudanca (`git show <hash>`)
