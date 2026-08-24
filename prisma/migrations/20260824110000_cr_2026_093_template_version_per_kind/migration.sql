-- CR-2026-093 — template versions are unique per KIND, not globally. The vehicle
-- checklist and the photo-first pre-inspection version independently; a global
-- unique would force them to share one number line for no reason.
DROP INDEX "inspection_templates_version_key";
CREATE UNIQUE INDEX "inspection_templates_kind_version_key"
  ON "inspection_templates"("kind", "version");
