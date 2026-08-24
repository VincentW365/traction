-- CR-2026-098 — the pause ledger now also records WAITING_PARTS / diagnosis
-- intervals, so parts delays have a measurable start, end, and duration.
ALTER TYPE "PauseReason" ADD VALUE IF NOT EXISTS 'WAITING_PARTS';
ALTER TYPE "PauseReason" ADD VALUE IF NOT EXISTS 'FURTHER_DIAGNOSIS';
