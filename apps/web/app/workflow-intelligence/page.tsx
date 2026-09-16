import FlowOperationsConsole from '../components/FlowOperationsConsole';
export default function WorkflowIntelligencePage() {
  return (
    <main>
      <h1>Workflow command center</h1>
      <p>Workspace flow health, pending tasks and governed recovery.</p>
      <FlowOperationsConsole />
    </main>
  );
}
