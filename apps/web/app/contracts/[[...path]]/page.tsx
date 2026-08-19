import { AgreementConsole } from '../../components/agreement-console';

/**
 * RC1 Phase C — the agreement workspace.
 *
 * The old route rendered five descriptive cards and called no API. This route now
 * mounts the browser client that reaches the governed contract, role-assignment and
 * agreement-intelligence endpoints under the caller's active workspace.
 */
export default function ContractsPage() {
  return <AgreementConsole />;
}
