import { WorkspaceEnv, bulkApprovals, editMemeText, listApprovals, listLibrary, setApprovalStatus, systemHealth } from "./workspace";

// Returns a Response when the path belongs to these features, otherwise null.
export async function routeWorkspace(request: Request, env: WorkspaceEnv, pathname: string, method: string): Promise<Response | null> {
  if (pathname === "/api/approvals" && method === "GET") return listApprovals(request, env);
  if (pathname === "/api/approvals/bulk" && method === "POST") return bulkApprovals(request, env);
  const one = /^\/api\/approvals\/(\d+)$/.exec(pathname);
  if (one && method === "PATCH") return setApprovalStatus(request, env, one[1]);
  const meme = /^\/api\/memes\/(\d+)$/.exec(pathname);
  if (meme && method === "PATCH") return editMemeText(request, env, meme[1]);
  if (pathname === "/api/library" && method === "GET") return listLibrary(request, env);
  if (pathname === "/api/system-health" && method === "GET") return systemHealth(request, env);
  return null;
}
