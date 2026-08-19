import { BootstrapConsole } from '../components/bootstrap-console';

/**
 * The bootstrap journey: register, sign in, found an organization, choose a workspace.
 *
 * Its own route rather than a section of `/onboarding/[mode]`, because those pages render `TrustConsole`, which
 * describes governed surfaces without calling any of them. Replacing one of its sections in place would leave a
 * page that is half description and half application. This route is the application.
 *
 * A client component with no server-side data fetch, deliberately: a server component has no authenticated
 * caller, so it has no tenant, so forced row-level security correctly returns nothing — the same reason the
 * landing page stopped presenting figures. Everything here is fetched by the browser under the caller's own
 * session cookie, which is the only context in which tenant data may be read.
 */
export default function StartPage() {
  return <BootstrapConsole />;
}
