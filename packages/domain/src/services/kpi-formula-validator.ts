import type { KpiFormulaValidationError } from '@assurapay/shared';

const allowedFunctions = new Set(['COUNT', 'SUM', 'AVERAGE', 'MINIMUM', 'MAXIMUM', 'PERCENTAGE', 'RATIO', 'DURATION', 'WEIGHTED_SCORE']);
const allowedIdentifiers = new Set(['numerator', 'denominator', 'value', 'duration', 'weight', 'sample_size']);
const forbidden = /\b(SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|EXEC|UNION|FROM|WHERE|SCRIPT|FUNCTION|EVAL)\b|[;`{}\[\]]|(?:__proto__|prototype|constructor)|\.(?!\d)/i;

export function validateKpiFormula(expression: string): { valid: boolean; errors: KpiFormulaValidationError[] } {
  const errors: KpiFormulaValidationError[] = [];
  if (!expression.trim()) errors.push({ code: 'EMPTY_EXPRESSION', field: 'formulaExpression', message: 'Formula expression is required', position: 0 });
  const forbiddenMatch = expression.match(forbidden);
  if (forbiddenMatch) errors.push({ code: 'FORBIDDEN_SYNTAX', field: 'formulaExpression', message: 'Formula contains SQL or code-injection syntax', position: forbiddenMatch.index });

  let depth = 0;
  for (let position = 0; position < expression.length; position += 1) {
    if (expression[position] === '(') depth += 1;
    if (expression[position] === ')') depth -= 1;
    if (depth < 0) { errors.push({ code: 'UNBALANCED_PARENTHESES', field: 'formulaExpression', message: 'Formula parentheses are unbalanced', position }); break; }
  }
  if (depth !== 0) errors.push({ code: 'UNBALANCED_PARENTHESES', field: 'formulaExpression', message: 'Formula parentheses are unbalanced' });

  const tokenPattern = /([A-Za-z_][A-Za-z0-9_]*)\s*(\()?/g;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(expression)) !== null) {
    const name = match[1];
    if (match[2] && !allowedFunctions.has(name.toUpperCase())) errors.push({ code: 'UNKNOWN_FUNCTION', field: 'formulaExpression', message: `Unknown function: ${name}`, position: match.index });
    if (!match[2] && !allowedIdentifiers.has(name) && !allowedFunctions.has(name.toUpperCase())) errors.push({ code: 'UNKNOWN_IDENTIFIER', field: 'formulaExpression', message: `Unknown identifier: ${name}`, position: match.index });
  }
  if (/\/\s*0(?:\.0+)?(?:\D|$)/.test(expression)) errors.push({ code: 'DIVIDE_BY_ZERO', field: 'formulaExpression', message: 'Formula contains a constant divide by zero' });
  if (/\bRATIO\s*\([^,)]*\)/i.test(expression)) errors.push({ code: 'RATIO_ARGUMENTS', field: 'formulaExpression', message: 'RATIO requires a numerator and denominator' });
  return { valid: errors.length === 0, errors };
}
