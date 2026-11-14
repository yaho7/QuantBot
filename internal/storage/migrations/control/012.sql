ALTER TABLE agent_sessions ADD COLUMN previous_digest TEXT;
ALTER TABLE agent_sessions ADD COLUMN previous_expires_at INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX agent_sessions_previous_digest ON agent_sessions(previous_digest) WHERE previous_digest IS NOT NULL;

-- Bind executing commands to the credential that authorized the boot, independent of session rotation.
UPDATE commands
SET accepted_by = (SELECT token_id FROM agent_sessions WHERE digest = commands.accepted_by)
WHERE accepted_by IS NOT NULL;
