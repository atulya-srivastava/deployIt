"use client";

import { useEffect, useRef, useState, use, useCallback } from "react";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { getProjects, getLogsStreamUrl, getLogsHistory } from "@/lib/api";
import {
  ArrowLeft,
  CheckCircle2,
  Circle,
  Cloud,
  ExternalLink,
  GitBranch,
  Hammer,
  Loader2,
  Package,
  Rocket,
  Terminal,
  Upload,
} from "lucide-react";

type Deployment = {
  id: string;
  status: string;
  createdAt: string;
};

type Project = {
  id: string;
  name: string;
  gitURL: string;
  subDomain: string;
  customDomain: string | null;
  deployments: Deployment[];
  createdAt: string;
};

type LogEntry = { log: string; timestamp?: string };

const TIMELINE_STEPS = [
  { key: "queued", label: "Deployment queued", desc: "Server accepted your repo URL", icon: Rocket },
  { key: "container", label: "Container starting", desc: "AWS ECS Fargate provisioning", icon: Cloud },
  { key: "building", label: "Building project", desc: "Running npm install & build", icon: Hammer },
  { key: "uploading", label: "Uploading to S3", desc: "Pushing build output to CDN", icon: Upload },
  { key: "deployed", label: "Deployed", desc: "Your site is live!", icon: Package },
];

function getTimelineStep(status: string, logs: string[], buildComplete: boolean): number {
  if (buildComplete || status === "READY") return 4;
  const joined = logs.join(" ").toLowerCase();
  if (joined.includes("upload") || joined.includes("starting to upload")) return 3;
  if (joined.includes("build") || joined.includes("npm") || joined.includes("install") || logs.length > 2) return 2;
  if (logs.length > 0) return 1;
  if (status === "IN_PROGRESS" || status === "QUEUED") return 0;
  return -1;
}

function DeployTimeline({ status, logs, buildComplete }: { status: string; logs: string[]; buildComplete: boolean }) {
  const currentStep = getTimelineStep(status, logs, buildComplete);

  return (
    <div className="flex items-start gap-2">
      {TIMELINE_STEPS.map((step, i) => {
        const Icon = step.icon;
        const done = i < currentStep || (i === currentStep && buildComplete);
        const active = i === currentStep && !buildComplete;
        const pending = i > currentStep;

        return (
          <div key={step.key} className="flex flex-1 flex-col items-center text-center gap-1.5">
            <div
              className={cn(
                "flex h-9 w-9 items-center justify-center rounded-full border-2 transition-all",
                done && "border-green-500 bg-green-50 text-green-600",
                active && "border-primary bg-primary/10 text-primary animate-pulse",
                pending && "border-muted text-muted-foreground"
              )}
            >
              {done ? (
                <CheckCircle2 className="h-4 w-4" />
              ) : active ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Circle className="h-4 w-4" />
              )}
            </div>
            <div>
              <p className={cn("text-xs font-medium", pending && "text-muted-foreground")}>
                {step.label}
              </p>
              <p className="text-[10px] text-muted-foreground">{step.desc}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

const STATUS_VARIANT: Record<
  string,
  "default" | "secondary" | "destructive" | "outline"
> = {
  READY: "default",
  IN_PROGRESS: "secondary",
  QUEUED: "outline",
  NOT_STARTED: "outline",
  FAIL: "destructive",
};

export default function ProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [project, setProject] = useState<Project | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [buildComplete, setBuildComplete] = useState(false);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  // Fetch project data
  const fetchProject = useCallback(async () => {
    try {
      const data = await getProjects();
      const found = (data.data as Project[])?.find((p) => p.id === id);
      if (found) {
        setProject(found);
        // Check if latest deployment is READY
        const latest = found.deployments.sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        )[0];
        if (latest?.status === "READY") {
          setBuildComplete(true);
        }
      }
    } catch {
      /* silently fail */
    }
  }, [id]);

  useEffect(() => {
    fetchProject();
  }, [fetchProject]);

  // Poll project status every 5s while build is in progress
  useEffect(() => {
    if (buildComplete) return;
    const interval = setInterval(fetchProject, 5000);
    return () => clearInterval(interval);
  }, [buildComplete, fetchProject]);

  // Load historical logs + start SSE stream
  useEffect(() => {
    if (!project) return;
    const slug = project.subDomain;

    // Historical logs
    getLogsHistory(slug)
      .then((data) => {
        if (data.data && data.data.length > 0) {
          const entries = data.data.map((e: LogEntry) =>
            typeof e.log === "string" ? e.log : JSON.stringify(e)
          );
          setLogs(entries);
        }
      })
      .catch(() => {});

    // SSE stream — EventSource auto-reconnects on error, don't close it
    const es = new EventSource(getLogsStreamUrl(slug));
    eventSourceRef.current = es;
    setStreaming(true);

    es.onmessage = (event) => {
      let text = event.data;
      try {
        const parsed = JSON.parse(text);
        text = parsed.log || text;
      } catch {
        /* raw text */
      }
      setLogs((prev) => [...prev, text]);

      // Detect build completion
      if (
        typeof text === "string" &&
        (text.includes("Done") || text.includes("Build Complete"))
      ) {
        setBuildComplete(true);
        fetchProject(); // Refresh project to get READY status
      }
    };

    es.onerror = () => {
      // Don't close — EventSource auto-reconnects.
      // Only mark streaming as false temporarily.
      setStreaming(false);
    };

    es.onopen = () => {
      setStreaming(true);
    };

    return () => {
      es.close();
      setStreaming(false);
    };
  }, [project?.subDomain, fetchProject]);

  // Auto-scroll logs
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  if (!project) {
    return (
      <div className="flex min-h-svh items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const latestDeployment = [...project.deployments].sort(
    (a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  )[0];

  const status = latestDeployment?.status || "NOT_STARTED";
  const previewUrl = `http://${project.subDomain}.localhost:8000`;

  return (
    <div className="mx-auto min-h-svh max-w-5xl p-6 md:p-10">
      {/* Nav */}
      <div className="flex items-center gap-3">
        <Link
          href="/"
          className={cn(buttonVariants({ variant: "ghost", size: "icon" }))}
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <Rocket className="h-5 w-5 text-primary" />
        <h1 className="text-lg font-bold tracking-tight">DeployIt</h1>
      </div>

      <Separator className="my-6" />

      {/* Build Complete Banner */}
      {buildComplete && (
        <div className="mb-6 flex items-center gap-3 rounded-lg border border-green-200 bg-green-50 p-4 text-green-800">
          <CheckCircle2 className="h-5 w-5 shrink-0" />
          <div>
            <p className="text-sm font-semibold">Deployment successful!</p>
            <a
              href={previewUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm underline underline-offset-4"
            >
              {project.subDomain}.localhost:8000
            </a>
          </div>
        </div>
      )}

      {/* Project Info */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Project</CardDescription>
            <CardTitle className="text-lg">{project.name}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <GitBranch className="h-3 w-3" />
              {project.gitURL}
            </span>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Status</CardDescription>
          </CardHeader>
          <CardContent className="flex items-center gap-2">
            <Badge variant={STATUS_VARIANT[status] || "outline"}>
              {status}
            </Badge>
            {status === "IN_PROGRESS" && (
              <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Preview URL</CardDescription>
          </CardHeader>
          <CardContent>
            {status === "READY" ? (
              <a
                href={previewUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 text-sm text-primary underline underline-offset-4"
              >
                <ExternalLink className="h-3 w-3" />
                {project.subDomain}.localhost:8000
              </a>
            ) : (
              <span className="text-sm text-muted-foreground">
                Available after deploy
              </span>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Deployment Progress Timeline */}
      {status !== "NOT_STARTED" && (
        <Card className="mt-6">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Deployment Progress</CardTitle>
          </CardHeader>
          <CardContent>
            <DeployTimeline status={status} logs={logs} buildComplete={buildComplete} />
          </CardContent>
        </Card>
      )}

      {/* Deployments */}
      <div className="mt-6">
        <h2 className="mb-3 text-sm font-semibold">
          Deployments ({project.deployments.length})
        </h2>
        <div className="flex flex-wrap gap-2">
          {[...project.deployments]
            .sort(
              (a, b) =>
                new Date(b.createdAt).getTime() -
                new Date(a.createdAt).getTime()
            )
            .map((d) => (
              <Badge
                key={d.id}
                variant={STATUS_VARIANT[d.status] || "outline"}
                className="font-mono text-xs"
              >
                {d.id.slice(0, 8)}… — {d.status}
              </Badge>
            ))}
        </div>
      </div>

      <Separator className="my-6" />

      {/* Build Logs */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Terminal className="h-4 w-4" />
              <CardTitle className="text-sm">Build Logs</CardTitle>
            </div>
            {streaming && (
              <Badge variant="secondary" className="text-xs">
                <span className="mr-1.5 h-1.5 w-1.5 rounded-full bg-green-500 inline-block animate-pulse" />
                Live
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <ScrollArea className="h-80 rounded-md border bg-muted/30 p-4">
            {logs.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
                {status === "IN_PROGRESS" ? (
                  <>
                    <Loader2 className="h-6 w-6 animate-spin" />
                    <p className="text-xs text-center">
                      Waiting for build container to start…
                      <br />
                      <span className="text-[10px]">
                        This can take 30–60s while AWS provisions your
                        container.
                      </span>
                    </p>
                  </>
                ) : (
                  <p className="text-xs">
                    No logs yet. Deploy a project to see build output.
                  </p>
                )}
              </div>
            ) : (
              <pre className="font-mono text-xs leading-relaxed whitespace-pre-wrap">
                {logs.map((line, i) => (
                  <div key={i} className="py-px hover:bg-muted/50">
                    <span className="mr-3 inline-block w-6 text-right text-muted-foreground/50 select-none">
                      {i + 1}
                    </span>
                    {line}
                  </div>
                ))}
              </pre>
            )}
            <div ref={logsEndRef} />
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}
