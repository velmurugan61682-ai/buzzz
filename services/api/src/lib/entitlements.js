/**
 * Production Entitlements & Plan Limits Service.
 *
 * Enforces server-side plan boundaries and usage ceilings.
 */

export const PLAN_LIMITS = {
  free: {
    name: "Free",
    maxMembers: 2,
    maxAgents: 1,
    maxContacts: 100,
    maxWorkflowRunsMonthly: 50,
    maxAppointmentsMonthly: 30,
    features: ["crm", "inbox", "basic_scheduling"],
  },
  starter: {
    name: "Starter",
    maxMembers: 5,
    maxAgents: 3,
    maxContacts: 1000,
    maxWorkflowRunsMonthly: 500,
    maxAppointmentsMonthly: 200,
    features: ["crm", "inbox", "scheduling", "workflows", "agents", "gowhats"],
  },
  pro: {
    name: "Pro",
    maxMembers: 20,
    maxAgents: 10,
    maxContacts: 10000,
    maxWorkflowRunsMonthly: 5000,
    maxAppointmentsMonthly: 2000,
    features: ["crm", "inbox", "scheduling", "workflows", "agents", "gowhats", "google_cal", "copilot"],
  },
  enterprise: {
    name: "Enterprise",
    maxMembers: 999999,
    maxAgents: 999999,
    maxContacts: 999999,
    maxWorkflowRunsMonthly: 999999,
    maxAppointmentsMonthly: 999999,
    features: ["*"],
  },
};

export class EntitlementError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "EntitlementError";
    this.code = code;
    this.status = 402; // Payment Required
    this.details = details;
  }
}

export async function getWorkspacePlan(db, workspaceId) {
  const sub = await db.getSubscription(workspaceId);
  const planKey = (sub?.plan || "free").toLowerCase();
  return PLAN_LIMITS[planKey] || PLAN_LIMITS.free;
}

export async function assertEntitlement(db, workspaceId, feature) {
  const plan = await getWorkspacePlan(db, workspaceId);
  if (plan.features.includes("*") || plan.features.includes(feature)) {
    return true;
  }
  throw new EntitlementError(
    "feature_not_included",
    `Feature '${feature}' is not included in your current ${plan.name} plan. Please upgrade to access.`,
    { feature, plan: plan.name }
  );
}

export async function assertUsageLimit(db, workspaceId, metric) {
  const plan = await getWorkspacePlan(db, workspaceId);
  const currentUsage = await db.getUsage(workspaceId, metric);

  let limit = Infinity;
  if (metric === "workflow_runs") limit = plan.maxWorkflowRunsMonthly;
  if (metric === "appointments") limit = plan.maxAppointmentsMonthly;
  if (metric === "contacts") limit = plan.maxContacts;

  if (Number(currentUsage) >= limit) {
    throw new EntitlementError(
      "usage_limit_exceeded",
      `Monthly limit for '${metric}' (${limit}) has been reached on your ${plan.name} plan.`,
      { metric, current: currentUsage, limit, plan: plan.name }
    );
  }
  return true;
}
