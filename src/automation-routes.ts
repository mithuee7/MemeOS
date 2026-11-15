import { AutomationEnv, automationStatus, runTickNow, setPauseRoute } from "./automation";
import { addSchedule, autoSchedule, cancelItem, getAccountSettings, listSchedule, rescheduleItem, saveAccountSettings, SchedulerEnv } from "./scheduler";

export async function routeAutomation(
  request: Request,
  env: AutomationEnv & SchedulerEnv,
  pathname: string,
  method: string,
): Promise<Response | null> {
  if (pathname === "/api/automation" && method === "GET") return automationStatus(request, env);
  if (pathname === "/api/automation/tick" && method === "POST") return runTickNow(request, env);
  if (pathname === "/api/automation/pause" && method === "PUT") return setPauseRoute(request, env);

  if (pathname === "/api/schedule" && method === "GET") return listSchedule(request, env);
  if (pathname === "/api/schedule" && method === "POST") return addSchedule(request, env);
  if (pathname === "/api/schedule/auto" && method === "POST") return autoSchedule(request, env);
  const item = /^\/api\/schedule\/(\d+)$/.exec(pathname);
  if (item && method === "PATCH") return rescheduleItem(request, env, item[1]);
  if (item && method === "DELETE") return cancelItem(request, env, item[1]);

  const settings = /^\/api\/accounts\/(\d+)\/settings$/.exec(pathname);
  if (settings && method === "GET") return getAccountSettings(request, env, settings[1]);
  if (settings && method === "PUT") return saveAccountSettings(request, env, settings[1]);
  return null;
}
