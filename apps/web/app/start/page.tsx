import { Rc1BdConsole } from '../components/rc1-bd-console';

/**
 * RC1 browser entry point.
 *
 * Phase A proved the application could be entered. Phases B-D keep that same entry
 * point and strengthen it so a session cannot be created from an email address alone,
 * then use the resulting authenticated workspace as the launch point for agreement and
 * performance lifecycle certification.
 */
export default function StartPage() {
  return <Rc1BdConsole />;
}
