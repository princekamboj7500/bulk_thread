import { useState } from "react";

export default function SyncPage() {
  const [status, setStatus] = useState<"idle" | "running" | "done">("idle");

  async function startSync() {
    setStatus("running");
    await fetch("/api/sync/start");

    // Poll every 5 sec
    const interval = setInterval(async () => {
      const res = await fetch("/api/sync/status");
      const data = await res.json();

      if (data.ready) {
        clearInterval(interval);
        setStatus("done");
      }
    }, 5000);
  }

  return (
    <div style={{ padding: 20 }}>
      <h1>SanMar Sync Dashboard</h1>

      <button onClick={startSync} disabled={status === "running"}>
        {status === "running" ? "Sync Running..." : "Run Sync"}
      </button>

      {status === "running" && <p> Downloading & processing SanMar data...</p>}
      {status === "done" && <p> Sync completed. Refresh to see results.</p>}
    </div>
  );
}
