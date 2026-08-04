/**
 * Self-reference exemption for REOS validators.
 *
 * A validator that scans for a vocabulary — marker words, forbidden primitives,
 * secret-shaped literals — necessarily contains that vocabulary itself, and so
 * do the tests that exercise it. Such a file declares the token below in a
 * comment, and the affected rules skip it.
 *
 * The token is deliberately a single greppable string so every exemption in the
 * repository can be audited with one search. It exempts only rules that would
 * match the vocabulary as *data*; it never exempts a file from the custody,
 * unconditional-release or audit-mutation rules, which match real call sites.
 */
export const RULE_VOCABULARY_TOKEN = 'reos:rule-vocabulary';

export function declaresRuleVocabulary(text: string): boolean {
  return text.includes(RULE_VOCABULARY_TOKEN);
}
