# AI Factory Agents

Regras gerais:
- Nunca alterar arquivos fora do workspace da tarefa.
- Sempre criar testes quando possível.
- Sempre rodar lint/testes antes de finalizar.
- Sempre gerar resumo final.
- Não fazer deploy sem aprovação humana.

**Entrega principal:** incremento de **sistema utilizável** (código em `src/` ou equivalente, mais testes automatizados quando couber). Documentação e relatórios são **evidência e rastreabilidade**, não substituem comportamento verificável no produto.

Evitar micros/tasks cujo **único** resultado seja texto em `docs/` sem mudança observável no app, API, persistência ou contrato executável (exceto se o orquestrador ou backlog declarar explicitamente uma exceção pontual, com critério de encerramento objetivo).

Fluxo:
1. Entender tarefa.
2. Planejar.
3. Implementar.
4. Testar.
5. Corrigir.
6. Entregar relatório.

## Evidências obrigatórias

Cada agente deve gravar **relatórios e artefatos de task** nos caminhos abaixo. O valor de negócio vem do **software testável** entregue; os ficheiros listados comprovam o processo e o resultado.

O orquestrador indica no prompt o **diretório do projeto** (por exemplo `workspaces/barber-scheduler/`). Todos os artefatos da task ficam **dentro desse diretório**, nos caminhos relativos abaixo.

Para cada task, usar estes caminhos (relativos à raiz do projeto em `workspaces/<PROJETO>/`):

- docs/tasks/TASK-ID.md
- reports/tasks/TASK-ID-planner.md
- reports/tasks/TASK-ID-dev.md
- reports/tasks/TASK-ID-qa.md
- reports/tasks/TASK-ID-qa-verdict.json
- reports/tasks/TASK-ID-reviewer.md
- evidence/tests/TASK-ID-test-output.txt

O Dev Agent deve:
- listar arquivos alterados (código e testes)
- informar comandos executados
- **compilar o projeto com sucesso** (`npm run build --prefix workspaces/<projeto>` ou equivalente) **antes** de encerrar a entrega
- documentar build na secção **## Compilação** de `reports/tasks/TASK-ID-dev.md` (comando, exit code, resumo)
- informar se conseguiu rodar testes

Não há passo separado de build no orquestrador: a compilação é critério de saída do Dev (abordagem soft). Erros de compilação não devem ser deixados para o QA.

## Testes e QA

**Tasks intermediárias:** o orquestrador **não** executa `npm test` nem QA Agent — só Dev, push e PR.

**Task de fechamento (`isMicroCloser`):** após Dev, o orquestrador:
1. Corre **Micro QA Refresh** (atualiza `acceptance` / `testStrategy` no micro)
2. Executa `npm test` sobre o código integrado na branch `tech-lead`
3. Chama o QA Agent com critérios do **micro**

Veredito do micro: `reports/scopes/<MICRO-ID>-qa-verdict.json`  
Relatório QA do micro: `reports/scopes/<MICRO-ID>-qa.md`

### QA por task (legado / referência)

Para tasks antigas ou prompts explícitos por task:
- `reports/tasks/TASK-ID-qa-verdict.json`
- `reports/tasks/TASK-ID-qa.md`

O QA Agent deve:
- ler `evidence/tests/TASK-ID-test-output.txt` quando existir (gerado na task de fechamento)
- gravar veredito JSON — na closer, usar path do **micro** (ver acima)
- se `verdict` for `fail`, o Dev corrige e o ciclo **testes → QA** repete (limite: `MAX_QA_FAILURE_RETRIES`, predefinição 3)

Nunca declarar testes como aprovados sem evidência.
Se o terminal for recusado, registar isso claramente.

O arquivo bruto de evidência pode ser apagado após o QA.
O relatório QA deve preservar o resultado relevante.
