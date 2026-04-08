# 19_Repo_Structure_Delivery_Standards.md

## Purpose

Define how implementation work should be organized so quality stays high and changes stay reviewable.

---

## 1. Recommended Repository Structure

```text
/apps
  /web
    /app
    /components
    /features
    /lib
    /hooks
  /api
    /src
      /modules
        /appointments
        /queue
        /scheduling
        /service-orders
        /parts
        /transport
        /notifications
        /reporting
        /config
        /audit
      /common
      /infrastructure
/packages
  /ui
  /types
  /config
  /eslint-config
  /tsconfig
/api
/db
/docs
/templates
```

---

## 2. Module Structure Rules

Each backend module should contain:
- controller / routes
- service / application logic
- domain rules
- DTOs / validation
- tests
- README or module notes

Each frontend feature should contain:
- page or route entry
- feature components
- state / query hooks
- local validation
- tests where practical

---

## 3. Branching and Change Discipline

### Recommended strategy
- protected `main`
- short-lived feature branches
- conventional commit style where possible
- no long-lived drifting branches

### PR / review rules
Every meaningful change should state:
- what changed
- why
- impacted modules
- schema changes
- rule changes
- tests added
- approval gate status

---

## 4. ADR Discipline

Use an ADR for:
- architecture changes
- schema shape changes
- business-rule changes
- integration contract changes
- library/tooling choices with long-term impact

Template:
- `templates/ADR_Template.md`

---

## 5. Environment Strategy

### Environments
- local
- test / preview
- staging
- production

### Local development
Use containerized local dependencies where possible:
- PostgreSQL
- Redis
- mail catcher / stub provider
- optional mock inventory / POS adapter

### Configuration rules
- strict env validation at boot
- no secrets in repo
- separate provider credentials by environment

---

## 6. CI/CD Expectations

At minimum the pipeline should run:
- install
- lint
- type check
- unit tests
- integration tests where possible
- build
- schema validation / migration checks
- preview deploys for UI and API if available

---

## 7. Logging and Error Standards

### Structured log fields
- timestamp
- level
- service/module
- request ID
- user ID if authenticated
- site ID if relevant
- entity type / ID if relevant
- rule key if relevant
- error code

### Error handling rules
- operational errors should be explicit and user-safe
- validation errors should be readable
- integration errors should be retryable where sensible
- domain errors should not be swallowed

---

## 8. Data Migration Rules

- every schema change must be versioned
- destructive changes require explicit review
- default values should be chosen carefully
- backfills should be scriptable and testable
- config seed data changes should be tracked

---

## 9. Test Coverage Priorities

Highest priority areas:
1. appointment timing rules
2. queue ranking
3. service-order transitions
4. parts blocking
5. transport eligibility
6. audit and override behavior
7. integration idempotency

---

## 10. Documentation Standards

When a feature ships, update:
- relevant rules
- API contract if changed
- schema outline if changed
- UI spec if flow changed
- tests
- ADR / change request if applicable

No silent architectural drift.

---

## 11. Code Smells to Reject

- domain logic in UI handlers
- duplicated enum definitions drifting across apps
- direct vendor calls inside domain services
- hidden magic config values
- large generic “utils” folders with business logic
- missing reason codes on overrides
- missing tests on queue policy changes
