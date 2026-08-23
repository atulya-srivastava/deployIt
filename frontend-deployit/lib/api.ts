const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:9000";

export async function getProjects() {
  const res = await fetch(`${API_BASE}/projects`, { cache: "no-store" });
  if (!res.ok) throw new Error("Failed to fetch projects");
  return res.json();
}

export async function deployProject(gitURL: string, name?: string) {
  const res = await fetch(`${API_BASE}/project`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ gitURL, name }),
  });
  if (!res.ok) throw new Error("Failed to deploy project");
  return res.json();
}

export function getLogsStreamUrl(projectId: string) {
  return `${API_BASE}/logs/stream/${projectId}`;
}

export async function getLogsHistory(projectId: string) {
  const res = await fetch(`${API_BASE}/logs/history/${projectId}`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error("Failed to fetch logs");
  return res.json();
}
