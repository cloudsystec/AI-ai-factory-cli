# Escopo Completo — SaaS de Agendamento via WhatsApp + IA

## 1. Visão do Produto

Criar uma plataforma SaaS multi-tenant e white-label, inicialmente focada em barbearias, onde empresas possam contratar o sistema para automatizar atendimento, agendamento e lembretes via WhatsApp com apoio de IA.

O cliente final não paga assinatura. Quem paga é a empresa contratante.

---

# 2. Modelo de Negócio

## Cliente pagante

A **empresa** será o cliente principal da plataforma.

Exemplos:

- barbearia;
- salão;
- estética;
- clínica;
- consultório;
- petshop futuramente.

## Cobrança

Modelo recomendado:

```txt
Plano base da empresa
+
valor por prestador ativo/mês

```

Exemplo:

```txt
R$ X por prestador ativo / mês

```

## Prestador ativo

É o profissional que:

- possui agenda;
- recebe agendamentos;
- aparece para o cliente;
- consome uma licença.

Usuários administrativos, como recepcionista ou gerente, não precisam consumir licença.

---

# 3. Estrutura Multi-Tenant

## Hierarquia

```txt
Plataforma
 └── Empresa / Tenant
      ├── Plano
      ├── White-label
      ├── WhatsApp
      ├── Serviços
      ├── Prestadores
      ├── Clientes
      ├── Agendamentos
      └── Configurações de IA

```

## Empresa

A empresa concentra:

- assinatura;
- cobrança;
- marca;
- configurações;
- usuários;
- prestadores;
- WhatsApp;
- agenda.

## Prestadores

Cada empresa pode ter um ou vários prestadores.

Cada prestador terá:

- nome;
- serviços que realiza;
- horários disponíveis;
- agenda própria;
- conexão opcional com Google Calendar.

---

# 4. White-label

Cada empresa poderá configurar:

- nome da empresa;
- logo;
- cores;
- mensagens padrão;
- tom de atendimento da IA;
- informações comerciais;
- regras de atendimento.

No MVP, o white-label será simples, sem necessidade de domínio próprio.

---

# 5. Stack Técnica

## Backend

- .NET latest;
- [ASP.NET](http://ASP.NET) Core;
- arquitetura modular;
- APIs REST;
- workers para tarefas assíncronas;
- TDD desde o início.

## Frontend

- React latest;
- painel administrativo web;
- componentes reutilizáveis;
- testes automatizados.

## Banco de dados

- Futuramente SQL Server;
- na AWS, preferencialmente Amazon RDS for SQL Server.

## Importante para o início

No início, **não haverá banco de dados real**.

A aplicação será construída com:

- mocks;
- repositórios em memória;
- contratos bem definidos;
- testes automatizados;
- domínio desacoplado da infraestrutura.

Isso permite modelar, validar regras e testar fluxos antes de fechar a estrutura definitiva do banco.

---

# 6. Infraestrutura AWS

## MVP inicial

A infra poderá ser preparada para AWS, mas sem obrigatoriedade de persistência real no início.

Componentes previstos:

- AWS ECS Fargate ou Elastic Beanstalk para API;
- S3 para arquivos e logos;
- CloudWatch para logs;
- Secrets Manager para credenciais;
- RDS SQL Server futuramente;
- SQS futuramente para filas;
- Redis futuramente para cache.

---

# 7. WhatsApp

## Integração escolhida

Será utilizado **WhatsApp GOWA**.

## Responsabilidades

O sistema deverá:

- receber mensagens via webhook;
- interpretar mensagens;
- responder clientes;
- enviar confirmação de agendamento;
- enviar lembretes;
- enviar mensagens de cancelamento;
- enviar mensagens de reagendamento.

---

# 8. IA de Atendimento

## Objetivo

A IA será a recepcionista virtual da empresa.

Ela deverá:

- entender a intenção do cliente;
- identificar serviço desejado;
- identificar prestador desejado;
- sugerir horários disponíveis;
- confirmar agendamento;
- cancelar agendamento;
- remarcar agendamento;
- responder dúvidas básicas.

## Exemplo

Cliente:

```txt
Quero cortar cabelo amanhã com o João

```

Sistema:

```txt
Entende serviço: corte de cabelo
Entende prestador: João
Consulta agenda do João
Sugere horários
Confirma agendamento

```

---

# 9. Google Calendar

## Objetivo

Utilizar a agenda do Google Calendar do prestador.

## Funções previstas

- conectar conta Google;
- ler disponibilidade;
- criar evento no calendário;
- atualizar evento;
- cancelar evento;
- evitar conflito de horários.

## MVP

No início, essa integração também pode ser mockada.

Ou seja:

- simular agenda Google;
- testar regra de disponibilidade;
- testar criação de agendamento;
- deixar contrato pronto para integração real depois.

---

# 10. Módulos do Sistema

## Módulo 1 — Autenticação

Funcionalidades:

- login;
- logout;
- recuperação de senha futuramente;
- usuários por empresa;
- perfis de acesso.

Perfis:

- admin da plataforma;
- admin da empresa;
- gerente;
- recepcionista;
- prestador.

---

## Módulo 2 — Empresa / Tenant

Funcionalidades:

- cadastro da empresa;
- edição dos dados;
- configuração da marca;
- configuração do WhatsApp;
- configuração de horários gerais;
- configuração da IA.

---

## Módulo 3 — Planos e Assinatura

Funcionalidades:

- plano contratado;
- quantidade de prestadores permitidos;
- prestadores ativos;
- bloqueio ao exceder limite;
- upgrade futuramente;
- cobrança recorrente futuramente.

No MVP inicial, billing pode ser mockado.

---

## Módulo 4 — Prestadores

Funcionalidades:

- cadastrar prestador;
- editar prestador;
- ativar/inativar;
- vincular serviços;
- configurar agenda;
- configurar disponibilidade;
- conectar Google Calendar futuramente.

Regras:

- prestador ativo consome licença;
- prestador inativo não recebe agendamento;
- prestador só pode executar serviços vinculados.

---

## Módulo 5 — Serviços

Funcionalidades:

- cadastrar serviço;
- editar serviço;
- definir duração;
- definir preço;
- vincular serviço a prestadores;
- ativar/inativar serviço.

Exemplos:

- corte;
- barba;
- sobrancelha;
- combo cabelo + barba.

---

## Módulo 6 — Agenda

Funcionalidades:

- consultar horários disponíveis;
- criar agendamento;
- cancelar agendamento;
- remarcar agendamento;
- bloquear horários;
- definir pausas;
- controlar status.

Status sugeridos:

- pendente;
- confirmado;
- cancelado;
- concluído;
- no-show.

---

## Módulo 7 — Clientes

Funcionalidades:

- cadastro automático pelo WhatsApp;
- identificação por telefone;
- histórico de agendamentos;
- histórico de conversas;
- observações internas futuramente.

---

## Módulo 8 — Conversas WhatsApp

Funcionalidades:

- receber mensagem;
- salvar histórico em memória no início;
- identificar cliente;
- identificar empresa;
- processar intenção;
- responder via GOWA;
- manter contexto da conversa.

No MVP inicial, GOWA pode ser mockado com contratos.

---

## Módulo 9 — Lembretes

Funcionalidades:

- lembrete antes do horário;
- confirmação automática;
- aviso de cancelamento;
- aviso de remarcação.

Exemplo:

```txt
Olá João, passando para lembrar do seu horário amanhã às 14h com Pedro.

```

No início, o envio pode ser simulado em testes.

---

## Módulo 10 — Painel Administrativo

A empresa poderá acessar um painel para:

- ver agendamentos;
- gerenciar prestadores;
- gerenciar serviços;
- configurar WhatsApp;
- configurar IA;
- configurar white-label;
- ver plano contratado.

---

## Módulo 11 — Admin da Plataforma

Painel interno para vocês gerenciarem:

- empresas;
- planos;
- prestadores ativos;
- uso da IA;
- mensagens enviadas;
- status das integrações;
- logs de erro.

---

# 11. Arquitetura Recomendada

## Estrutura de solução .NET

```txt
/src
 ├── Api
 ├── Application
 ├── Domain
 ├── Infrastructure
 ├── Workers
 └── Shared

/tests
 ├── UnitTests
 ├── ApplicationTests
 ├── IntegrationTests
 └── ContractTests

```

## Domain

Contém:

- entidades;
- regras de negócio;
- validações;
- eventos de domínio.

Não depende de banco, API, AWS ou GOWA.

## Application

Contém:

- casos de uso;
- comandos;
- queries;
- orquestração;
- interfaces de serviços externos.

## Infrastructure

Contém implementações reais futuras:

- SQL Server;
- GOWA;
- Google Calendar;
- OpenAI;
- AWS.

No início, boa parte será substituída por mocks.

## Api

Contém:

- controllers;
- autenticação;
- webhooks;
- endpoints do painel.

## Workers

Contém:

- processamento de mensagens;
- lembretes;
- filas;
- tarefas agendadas.

---

# 12. Estratégia TDD

O projeto deve nascer testável.

## Regra principal

Antes de implementar regra importante, criar teste.

## Tipos de teste

### Testes de domínio

Validam regras puras.

Exemplos:

- não permitir agendamento fora do horário;
- não permitir conflito na agenda;
- não permitir prestador inativo;
- não permitir serviço inativo;
- validar limite de prestadores ativos.

### Testes de aplicação

Validam casos de uso.

Exemplos:

- criar agendamento;
- cancelar agendamento;
- remarcar agendamento;
- cadastrar prestador;
- processar mensagem do WhatsApp.

### Testes de contrato

Validam interfaces externas.

Exemplos:

- contrato do GOWA;
- contrato do Google Calendar;
- contrato da IA.

### Testes de integração

Entram depois, quando banco e APIs reais forem implementados.

---

# 13. Desenvolvimento Inicial com Mocks

## Objetivo

Ganhar velocidade sem travar em banco, infraestrutura ou APIs externas.

## Serão mockados inicialmente:

- banco de dados;
- WhatsApp GOWA;
- Google Calendar;
- IA;
- billing;
- envio de lembretes.

## Implementações iniciais

- InMemoryCompanyRepository;
- InMemoryProviderRepository;
- InMemoryAppointmentRepository;
- FakeWhatsAppGateway;
- FakeCalendarProvider;
- FakeAiAssistant;
- FakeBillingProvider.

---

# 14. Contratos Técnicos Importantes

## WhatsApp

```txt
IWhatsAppGateway
- SendMessage()
- ReceiveWebhook()

```

## Agenda externa

```txt
ICalendarProvider
- GetAvailability()
- CreateEvent()
- UpdateEvent()
- CancelEvent()

```

## IA

```txt
IAssistantService
- InterpretMessage()
- GenerateResponse()

```

## Billing

```txt
IBillingProvider
- GetSubscription()
- ValidateProviderLimit()
- ChangePlan()

```

## Repositórios

```txt
ICompanyRepository
IProviderRepository
IServiceRepository
IAppointmentRepository
ICustomerRepository

```

---

# 15. Fluxo Principal de Agendamento

```txt
Cliente envia mensagem no WhatsApp
 ↓
GOWA chama webhook
 ↓
API recebe mensagem
 ↓
Mensagem é enviada para processamento
 ↓
IA interpreta intenção
 ↓
Sistema identifica empresa
 ↓
Sistema identifica cliente
 ↓
Sistema identifica serviço
 ↓
Sistema identifica prestador
 ↓
Sistema consulta disponibilidade
 ↓
Sistema sugere horário
 ↓
Cliente confirma
 ↓
Sistema cria agendamento
 ↓
Sistema cria evento no Google Calendar
 ↓
Sistema envia confirmação via WhatsApp
 ↓
Sistema agenda lembrete

```

---

# 16. Fluxos MVP

## Agendar

Cliente pede horário e sistema agenda.

## Cancelar

Cliente pede cancelamento e sistema cancela.

## Remarcar

Cliente pede novo horário e sistema atualiza.

## Consultar serviços

Cliente pergunta serviços e sistema responde.

## Consultar horários

Cliente pergunta disponibilidade e sistema sugere opções.

---

# 17. Regras de Negócio Essenciais

## Empresa

- empresa precisa estar ativa;
- empresa precisa ter plano válido;
- empresa pode ter limite de prestadores.

## Prestador

- precisa estar ativo;
- precisa ter agenda configurada;
- precisa executar o serviço solicitado.

## Serviço

- precisa estar ativo;
- precisa pertencer à empresa;
- precisa ter duração definida.

## Agendamento

- não pode conflitar com outro;
- precisa respeitar horário do prestador;
- precisa respeitar duração do serviço;
- precisa ter cliente identificado;
- precisa ter status válido.

## WhatsApp

- mensagem precisa ser vinculada a uma empresa;
- cliente é identificado pelo telefone;
- contexto da conversa deve ser mantido.

---

# 18. MVP Recomendado

## Entram no MVP

- cadastro de empresa;
- cadastro de prestadores;
- cadastro de serviços;
- configuração básica de horários;
- agenda por prestador;
- fluxo de agendamento via WhatsApp mockado;
- IA mockada ou básica;
- Google Calendar mockado;
- lembretes mockados;
- painel React;
- backend .NET;
- testes automatizados desde o início.

## Não entram no MVP inicial

- banco SQL Server real;
- billing real;
- dashboard avançado;
- app mobile;
- múltiplos WhatsApps;
- multi-unidade;
- CRM completo;
- financeiro completo;
- BI avançado.

---

# 19. Roadmap

## Fase 1 — Domínio e TDD

- modelar entidades;
- criar contratos;
- criar testes;
- implementar regras em memória;
- validar fluxo completo sem banco.

## Fase 2 — Painel React

- telas de empresa;
- prestadores;
- serviços;
- agenda;
- configurações.

## Fase 3 — WhatsApp GOWA real

- configurar webhooks;
- enviar mensagens reais;
- processar respostas.

## Fase 4 — Google Calendar real

- OAuth;
- leitura de agenda;
- criação de eventos;
- cancelamentos.

## Fase 5 — SQL Server

- implementar persistência;
- migrations;
- repositórios reais;
- testes de integração.

## Fase 6 — Billing

- planos;
- cobrança;
- limite de prestadores;
- inadimplência.

## Fase 7 — Produção AWS

- deploy;
- logs;
- monitoramento;
- segurança;
- escalabilidade.

---

# 20. Objetivo do MVP Técnico

O MVP não deve provar apenas tela.

Ele deve provar:

```txt
Empresa configura prestadores e serviços
Cliente chama no WhatsApp
IA entende intenção
Sistema consulta agenda
Sistema cria agendamento
Cliente recebe confirmação
Prestador tem evento na agenda
Cliente recebe lembrete

```

Mesmo que inicialmente tudo isso funcione com mocks.

---

# 21. Diretriz Principal

A prioridade do projeto será:

```txt
Testabilidade primeiro.
Banco depois.
Infra depois.
Integrações reais depois.

```

Isso reduz retrabalho e permite evoluir o produto com segurança.