import { notFound } from 'next/navigation';
import {
  PERSONA_WORKSPACES,
  type PersonaWorkspaceId,
} from '../../../lib/persona-workspaces';
import {
  PersonaWorkspaceConsole,
  PersonaWorkspaceSwitcher,
} from '../../components/persona-workspace-console';

/**
 * One persona workspace.
 *
 * `data-persona` on the shell is what selects the accent; the stylesheet holds the colour and the component
 * tree only ever asks for `--ap-accent`, so a ninth workspace is a token and a table entry rather than a
 * condition in every component.
 *
 * Statically generated for the eight known workspaces and 404 for anything else, so a typed URL fails as a
 * missing page rather than rendering an empty shell. That is presentation only: the page refuses an unknown
 * *name*, while what a known one actually shows comes from the caller's own permissions, and the routes behind
 * each module enforce their own requirements regardless of how this page was reached.
 */
export function generateStaticParams() {
  return PERSONA_WORKSPACES.map((entry) => ({ persona: entry.id }));
}

export default function PersonaWorkspacePage({ params }: { params: { persona: string } }) {
  const workspace = PERSONA_WORKSPACES.find((entry) => entry.id === params.persona);
  if (!workspace) notFound();

  return (
    <main className="shell" data-persona={workspace.id}>
      <PersonaWorkspaceSwitcher current={workspace.id as PersonaWorkspaceId} />
      <p className="eyebrow">{workspace.title}</p>
      <h1>{workspace.purpose}</h1>
      <PersonaWorkspaceConsole workspace={workspace} />
    </main>
  );
}
