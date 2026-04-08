# 15_Security_Governance.md

## Purpose

Define the control framework for the platform.

This project handles:
- customer data
- vehicle data
- operational assignments
- payments references
- privileged overrides
- configuration changes

So governance must be part of the design, not a final hardening step.

---

## 1. Core Control Principles

1. Least privilege access
2. Role-based permissions
3. Site-aware access scope
4. Audited privileged actions
5. Configurable business rules with history
6. Reliable backup and restore
7. Secure integration credentials
8. Explicit operational overrides with reason codes

---

## 2. RBAC Rules

### Minimum RBAC expectations
- customers only see their own records
- front desk sees operational customer flows, not system governance
- technicians see assigned work, not global configuration
- parts staff see parts workflows, not queue override
- managers can override operations
- admins control users, roles, and global configuration

### Sensitive permissions
Require extra care for:
- queue override
- business-rule edits
- user/role changes
- parts substitution approval
- payment exception
- transport exception
- data exports

---

## 3. Audit Requirements

### Actions that must create AuditLog entries
- manual queue reorder
- rule config change
- service duration change
- operating hours change
- technician reassignment after work start
- parts substitution approval
- user created / deactivated / re-role
- payment close exception
- manual record correction

### Audit record should contain
- actor
- timestamp
- action
- entity type
- entity ID
- before snapshot or key fields
- after snapshot or key fields
- reason code
- free-text note when relevant

---

## 4. Status History Requirements

Audit log is not enough.
Operational lifecycle transitions must also write to `StatusHistory`.

Why:
- audit is actor-centric
- status history is lifecycle-centric

Both are needed.

---

## 5. Configuration Governance

Manager/admin-editable configurations should include:
- grace period
- early arrival threshold
- fairness threshold
- quick-service threshold
- operating hours
- service durations
- technician availability template
- notification templates
- transport thresholds

### Governance rules
- changes must be versioned
- effective dates should be possible
- site-level overrides should be possible if business allows
- config changes should never be invisible

---

## 6. Data Protection Rules

- avoid exposing full PII on public screens
- validate phone/email formats
- protect secrets in environment / secret manager
- encrypt at rest and in transit where platform/infrastructure supports it
- restrict export capability
- keep clear retention or anonymization paths for privacy requests

---

## 7. Integration Security

For external systems:
- use least-privilege credentials
- rotate secrets
- verify webhooks where supported
- use idempotency keys on outbound actions
- store provider reference IDs
- protect against duplicate callbacks
- never let provider failure corrupt domain truth

---

## 8. Backup and Recovery

Before production pilot, define:
- DB backup frequency
- point-in-time recovery if available
- restore test procedure
- configuration backup
- incident contact / response path

A backup plan that is never tested is not a real backup plan.

---

## 9. Operational Safeguards

- feature flags for risky or late-phase features
- maintenance mode or degraded-mode handling
- health endpoints
- dead-letter handling for integration failures
- queue recomputation error logging
- message delivery retry strategy

---

## 10. Governance Anti-Patterns to Avoid

- managers making invisible queue edits
- hard-coded business rules in source code only
- no versioning on configuration
- customer-facing status pages leaking PII
- direct third-party API calls from random UI code
- destructive deletes of operational history

---

## 11. Minimum Production Readiness Checklist

Before pilot go-live:
- RBAC tested
- audit logs searchable
- backups configured
- critical alerts wired
- environment secrets separated by env
- config management defined
- integration retry policy defined
- manual fallback procedure documented
