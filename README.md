# Bert's Service Operations Platform Documentation Pack

This package defines the **unified service platform** for Bert's Auto Parts Service Centre.

It combines:
1. **Customer Number Sequencing & Scheduling**
2. **Complete Service Center Scheduling & Logistics** (parts readiness, transfer workflows, customer transport)

The design principle is simple:

> **One core scheduling brain, multiple operational modules, one shared source of truth.**

## What is inside

| file | purpose |
| --- | --- |
| Project.md | Master product requirements document and executive blueprint. |
| claude.md | Hard directives, architecture guardrails, delivery protocol, and approval gates for Claude. |
| docs/00_Assumptions_Open_Questions.md | Explicit assumptions, dependencies, and unanswered business decisions. |
| docs/01_Business_Blueprint.md | Operating model, service journey, and future-state process narrative. |
| docs/02_Process_Flows.md | Mermaid process flow diagrams for service, queue, parts, and transport. |
| docs/03_Business_Rules.md | Formal rule catalogue with rule / example / exception / system response format. |
| docs/04_Service_Catalogue.md | Service types, durations, skills, bay types, and eligibility rules. |
| docs/05_User_Roles_Permissions.md | Role definitions, responsibilities, and permissions matrix. |
| docs/06_Modules_Scope.md | Module decomposition, boundaries, dependencies, and out-of-scope items. |
| docs/07_Phased_Delivery_Plan.md | Phase-by-phase delivery sequence, scope, exit gates, and rollout plan. |
| docs/08_Scheduling_Engine_Spec.md | Core queue/scheduling brain, scoring model, pseudocode, and decision table. |
| docs/09_Data_Model.md | Shared domain model, entity relationships, status lifecycles, and data integrity rules. |
| docs/10_Architecture_Tech_Stack.md | Recommended architecture, repo model, stack, deployment, and observability. |
| docs/11_API_Contracts_Integrations.md | API surface, events, webhooks, and integration-layer design. |
| docs/12_UI_UX_Spec.md | Primary screens, user experience rules, and workflow-first interface guidance. |
| docs/13_KPI_Reporting.md | KPI dictionary, dashboards, reporting cadence, and data capture requirements. |
| docs/14_Testing_Acceptance_Criteria.md | Scenario-based tests, non-functional requirements, and definition of done. |
| docs/15_Security_Governance.md | RBAC, audit, business-rule governance, backup, and operational controls. |
| docs/16_Risk_Register.md | Top risks, probability/impact, and mitigation plan. |
| docs/17_Discovery_Workshops_Question_Bank.md | Workshop structure and stakeholder interview guides. |
| docs/18_Backlog_Epics_User_Stories.md | Delivery-ready epics and user stories aligned to phases. |
| docs/19_Repo_Structure_Delivery_Standards.md | Monorepo layout, coding standards, branching, ADR, and CI/CD rules. |
| docs/20_Sources_and_Rationale.md | Official-reference notes for stack and architectural rationale. |
| docs/21_Approval_Gates.md | Decisions that must be surfaced for explicit review before implementation. |
| api/openapi-outline.yaml | Machine-readable API outline for Claude to extend into full contracts. |
| db/schema_outline.sql | Starter SQL blueprint aligned to the shared domain model. |
| data/*.csv | Importable tables for services, rules, permissions, KPIs, queue decisions, and backlog. |
| templates/*.md | ADR, change request, Claude output, and review request templates. |

## Recommended reading order

1. `Project.md`
2. `claude.md`
3. `docs/00_Assumptions_Open_Questions.md`
4. `docs/01_Business_Blueprint.md`
5. `docs/03_Business_Rules.md`
6. `docs/08_Scheduling_Engine_Spec.md`
7. `docs/09_Data_Model.md`
8. `docs/10_Architecture_Tech_Stack.md`
9. `docs/14_Testing_Acceptance_Criteria.md`

## How to use this pack with Claude

- Start each Claude session by attaching or pasting `claude.md` and `Project.md`.
- If Claude proposes a change to business rules, schema, queue logic, integrations, or architecture, require it to use the templates in `templates/`.
- Paste Claude's output back here for review against the approval gates in `docs/21_Approval_Gates.md`.

## Document status

Prepared on `2026-03-30` as the **baseline product and technical blueprint** for phased execution.
