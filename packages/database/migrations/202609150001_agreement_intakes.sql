CREATE TABLE IF NOT EXISTS agreement_intakes (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, workspace_id uuid NOT NULL,
 source_type text NOT NULL CHECK(source_type IN('DIRECT_DESCRIPTION','INFORMAL_ARTIFACT','FORMAL_DOCUMENT')),
 source_artifact_ids jsonb NOT NULL DEFAULT '[]'::jsonb, source_hash text NOT NULL,
 proposed_terms jsonb NOT NULL DEFAULT '[]'::jsonb, clarifications jsonb NOT NULL DEFAULT '[]'::jsonb,
 clarity_score integer NOT NULL CHECK(clarity_score BETWEEN 0 AND 100),
 status text NOT NULL CHECK(status IN('INGESTED','NEEDS_CLARIFICATION','READY_FOR_REVIEW','REVIEWED','CONVERTED')),
 created_by uuid NOT NULL, reviewed_by uuid NULL, reviewed_at timestamptz NULL,
 converted_agreement_id uuid NULL, created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT agreement_intake_review_consistency CHECK(
   (status IN('REVIEWED','CONVERTED') AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
   OR (status NOT IN('REVIEWED','CONVERTED') AND reviewed_by IS NULL AND reviewed_at IS NULL)
 ),
 CONSTRAINT agreement_intake_conversion_consistency CHECK(
   (status='CONVERTED' AND converted_agreement_id IS NOT NULL)
   OR (status<>'CONVERTED' AND converted_agreement_id IS NULL)
 ),
 CONSTRAINT agreement_intake_conversion_unique UNIQUE(converted_agreement_id));
CREATE INDEX IF NOT EXISTS agreement_intakes_workspace_status_idx ON agreement_intakes(workspace_id,status);
CREATE INDEX IF NOT EXISTS agreement_intakes_workspace_source_idx ON agreement_intakes(workspace_id,source_type);
ALTER TABLE agreement_intakes ENABLE ROW LEVEL SECURITY;
