import { describe, expect, it } from 'vitest';
import {
  REQUIRED_STORE_TABLES,
  REQUIRED_TRUST_MIGRATIONS,
  REQUIRED_TRUST_TABLES,
} from './migrations';

describe('Agentic OS persistence is a production readiness dependency', () => {
  it('requires both persona persistence migrations', () => {
    expect(REQUIRED_TRUST_MIGRATIONS).toContain('202609070001_agentic_persona_profiles_relational');
    expect(REQUIRED_TRUST_MIGRATIONS).toContain('202609070002_agentic_persona_profiles_direct');
  });

  it('requires the dedicated persona profile table before reporting the store ready', () => {
    expect(REQUIRED_TRUST_TABLES).toContain('persona_agent_profiles');
    expect(REQUIRED_STORE_TABLES).toContain('persona_agent_profiles');
  });
});
