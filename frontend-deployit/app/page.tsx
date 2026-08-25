"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import toast from "react-hot-toast";
import { getProjects, deployProject } from "@/lib/api";
import {
  Rocket,
  GitBranch,
  ExternalLink,
  Plus,
  Loader2,
  FolderGit2,
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

export default function DashboardPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [deploying, setDeploying] = useState(false);
  const [open, setOpen] = useState(false);
  const [gitURL, setGitURL] = useState("");
  const [projectName, setProjectName] = useState("");

  async function fetchProjects() {
    try {
      const data = await getProjects();
      toast.success("Projects loaded successfully");
      setProjects(data.data || []);
    } catch (err) {
      console.log("error to fetch proj=",err)
      toast.error("Error fetching the projects");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchProjects();
  }, []);

  function parseGitHubUrl(url: string) {
    const match = url.trim().match(/github\.com\/([^\/]+)\/([^\/\.\s]+)/);
    if (!match) return null;
    return { owner: match[1], repo: match[2] };
  }

  async function handleDeploy() {
    if (!gitURL.trim()) {
      toast.error("Please enter a Git repository URL");
      return;
    }

    // Validate URL format
    if (!/^https?:\/\/.+/.test(gitURL.trim())) {
      toast.error("Invalid URL format.");
      return;
    }

    // If it's a GitHub URL, check repository existence via GitHub API 
    const ghRepo = parseGitHubUrl(gitURL);
    if (ghRepo) {
      try {
        setDeploying(true)
        const res = await fetch(`https://api.github.com/repos/${ghRepo.owner}/${ghRepo.repo}`);
        if (res.status === 404) {
          toast.error("GitHub repo not found or is private");
          return;
        } else if (!res.ok) {
          toast.error(`GitHub API returned status ${res.status}`);
          return;
        }
      } catch (err) {
        console.error("GitHub verification error:", err);
      }
      finally{
        setDeploying(false)
      }
    }

    setDeploying(true); 
    try {
      const result = await deployProject(gitURL, projectName || undefined);
      setGitURL("");
      setProjectName("");
      setOpen(false);
      // Redirect to project page to see live build logs
      if (result?.data?.project?.id) {
        router.push(`/project/${result.data.project.id}`);
      } else {
        await fetchProjects();
      }
    } catch(err) {
      /* handle error */
      console.log("error while deploying =",err)
      toast.error("Error deploying project");
    } finally {
      setDeploying(false);
    }
  }

  function latestStatus(deployments: Deployment[]) {
    if (!deployments.length) return "NOT_STARTED";
    return deployments.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )[0].status;
  }

  return (
    <div className="mx-auto min-h-svh max-w-5xl p-6 md:p-10">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Rocket className="h-7 w-7 text-primary" />
          <h1 className="text-2xl font-bold tracking-tight">deploy1t</h1>
        </div>

        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger render={<Button />}>
            <Plus className="mr-2 h-4 w-4" />
            New Project
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Deploy a new project</DialogTitle>
              <DialogDescription>
                Paste a public Git repository URL to deploy.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="giturl">Git Repository URL</Label>
                <Input
                  id="giturl"
                  placeholder="https://github.com/user/repo"
                  value={gitURL}
                  onChange={(e) => setGitURL(e.target.value)}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="name">
                  Project Name{" "}
                  <span className="text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  id="name"
                  placeholder="my-awesome-app"
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                />
              </div>
            </div>
            <DialogFooter>
              <Button onClick={handleDeploy} disabled={!gitURL || deploying}>
                {deploying ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Deploying…
                  </>
                ) : (
                  <>
                    <Rocket className="mr-2 h-4 w-4" />
                    Deploy
                  </>
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <Separator className="my-6" />

      {/* Project Grid */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : projects.length === 0 ? (
        <Card className="flex flex-col items-center justify-center py-16">
          <FolderGit2 className="mb-4 h-12 w-12 text-muted-foreground" />
          <CardTitle className="mb-2">No projects yet</CardTitle>
          <CardDescription>
            Deploy your first project to get started.
          </CardDescription>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => {
            const status = latestStatus(project.deployments);
            return (
              <Link key={project.id} href={`/project/${project.id}`}>
                <Card className="h-full transition-colors hover:border-primary/40">
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between">
                      <CardTitle className="truncate text-base">
                        {project.name}
                      </CardTitle>
                      <Badge variant={STATUS_VARIANT[status] || "outline"}>
                        {status}
                      </Badge>
                    </div>
                    <CardDescription className="flex items-center gap-1.5 truncate text-xs">
                      <GitBranch className="h-3 w-3 shrink-0" />
                      {project.gitURL}
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>
                        {project.deployments.length} deployment
                        {project.deployments.length !== 1 ? "s" : ""}
                      </span>
                      <span className="flex items-center gap-1">
                        <ExternalLink className="h-3 w-3" />
                        {project.subDomain}
                      </span>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
