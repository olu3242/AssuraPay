import type { SqlClient } from './postgres-client';
import { AGREEMENT_INTAKE_RELATION, isAgreementIntakeCollection } from './agreement-intake-repository';

export const AGREEMENT_INTAKE_COLLECTIONS: readonly string[] = Object.freeze([
  AGREEMENT_INTAKE_RELATION.collection,
]);

export const AGREEMENT_INTAKE_TABLES: readonly string[] = Object.freeze([
  AGREEMENT_INTAKE_RELATION.table,
]);

export async function listAgreementIntakes<T>(sql: SqlClient, collection: string): Promise<T[] | undefined> {
  if (!isAgreementIntakeCollection(collection)) return undefined;
  return (await AGREEMENT_INTAKE_RELATION.list(sql)) as T[];
}

export async function appendAgreementIntake(
  sql: SqlClient,
  collection: string,
  record: Record<string, unknown>,
  tenantId: string,
): Promise<boolean> {
  if (!isAgreementIntakeCollection(collection)) return false;
  await AGREEMENT_INTAKE_RELATION.insert(sql, record, tenantId);
  return true;
}

export async function replaceAgreementIntake(
  sql: SqlClient,
  collection: string,
  record: Record<string, unknown>,
): Promise<number | undefined> {
  if (!isAgreementIntakeCollection(collection)) return undefined;
  return await AGREEMENT_INTAKE_RELATION.update(sql, record);
}
