'use client';

import { useCallback, useEffect, useState } from 'react';

type HealthRecord = {
  flowId: string;
  transactionId: string;
  state: string;
  status: 'HEALTHY' | 'ATTENTION' | 'CRITICAL';
  ageMs: number;
  openTaskCount: number;
  oldestOpenTaskAgeMs: number;
  recommendedAction: string;
};

type HealthResponse = {
  records: HealthRecord[];
  metrics: {
    totalFlows: number;
    healthyFlows: number;
    attentionFlows: number;
    criticalFlows: number;
    openHumanTasks: number;
    stalledFlows: number;
  };
};

const age = (milliseconds: number) => {
  const minutes = Math.floor(milliseconds / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
};

export default function FlowOperationsConsole() {
  const [data, setData] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyFlow, setBusyFlow] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const response = await fetch('/api/v1/flows?view=health', { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error(`FLOW_HEALTH_${response.status}`);
    setData(await response.json());
    setError(null);
  }, []);

  useEffect(() => {
    refresh().catch((cause) => setError(cause instanceof Error ? cause.message : 'FLOW_HEALTH_UNAVAILABLE'));
  }, [refresh]);

  const recover = async (record: HealthRecord) => {
    const reason = window.prompt(`Recovery reason for transaction ${record.transactionId}`);
    if (!reason?.trim()) return;
    setBusyFlow(record.flowId);
    try {
      const response = await fetch(`/api/v1/flows/${record.flowId}/resume`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'RECOVER', reason }),
      });
      if (!response.ok) throw new Error(`FLOW_RECOVERY_${response.status}`);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'FLOW_RECOVERY_FAILED');
    } finally {
      setBusyFlow(null);
    }
  };

  if (error && !data) return <section className="card"><h2>Flow operations unavailable</h2><p>{error}</p></section>;
  if (!data) return <section className="card"><h2>Loading flow health…</h2></section>;

  const metrics = [
    ['Total flows', data.metrics.totalFlows],
    ['Healthy', data.metrics.healthyFlows],
    ['Needs attention', data.metrics.attentionFlows],
    ['Critical', data.metrics.criticalFlows],
    ['Open human tasks', data.metrics.openHumanTasks],
    ['Stalled', data.metrics.stalledFlows],
  ];

  return (
    <>
      <section className="grid" aria-label="Flow health metrics">
        {metrics.map(([label, value]) => (
          <article className="card" key={label}>
            <span>{label}</span>
            <h2>{value}</h2>
          </article>
        ))}
      </section>

      {error ? <p role="alert">{error}</p> : null}

      <section className="card">
        <h2>Operational attention queue</h2>
        <p>Only orchestration recovery is available here. Evidence, certification, release and settlement state remain protected by their domain engines.</p>
        {data.records.length === 0 ? <p>No active flow records.</p> : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr><th align="left">Transaction</th><th align="left">State</th><th align="left">Health</th><th align="left">Age</th><th align="left">Tasks</th><th align="left">Action</th></tr>
              </thead>
              <tbody>
                {data.records.map((record) => (
                  <tr key={record.flowId}>
                    <td>{record.transactionId}</td>
                    <td>{record.state}</td>
                    <td>{record.status}</td>
                    <td>{age(record.ageMs)}</td>
                    <td>{record.openTaskCount}</td>
                    <td>
                      {record.recommendedAction === 'RECOVER_FAILED_FLOW' || record.recommendedAction === 'RETRY_FAILED_STEP' ? (
                        <button type="button" disabled={busyFlow === record.flowId} onClick={() => recover(record)}>
                          {busyFlow === record.flowId ? 'Recovering…' : 'Recover flow'}
                        </button>
                      ) : record.recommendedAction.replaceAll('_', ' ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
