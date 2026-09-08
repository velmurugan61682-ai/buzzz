/**
 * Production API Client for BUZZZ Web Application.
 *
 * Communicates with services/api over authenticated JSON endpoints.
 * Encapsulates credentials, tenant workspace headers, error handling, and retries.
 */

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ||
  (typeof window !== "undefined" && window.location.origin.includes("localhost")
    ? "http://localhost:5000/api/v1"
    : "/api/v1");

export class ApiError extends Error {
  constructor(message, status, code, field = null, fields = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.field = field;
    this.fields = fields;
  }
}

export async function apiRequest(endpoint, { method = "GET", body, headers = {}, workspaceId } = {}) {
  const reqHeaders = {
    "Content-Type": "application/json",
    ...headers,
  };

  if (workspaceId) {
    reqHeaders["x-workspace-id"] = workspaceId;
  }

  const opts = {
    method,
    headers: reqHeaders,
    credentials: "include",
  };

  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }

  const res = await fetch(`${API_BASE_URL}${endpoint}`, opts);

  if (res.status === 204) {
    return null;
  }

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new ApiError(
      data.message || `API request failed with status ${res.status}`,
      res.status,
      data.code,
      data.field || null,
      data.fields || null
    );
  }

  return normalizeResponse(data);
}

export function normalizeEntity(item) {
  if (!item || typeof item !== "object") return item;
  const id = item.id || (item._id ? String(item._id) : undefined);
  return {
    ...item,
    ...(id ? { id } : {}),
    tags: Array.isArray(item.tags) ? item.tags : [],
  };
}

export function normalizeResponse(data) {
  if (Array.isArray(data)) {
    return data.map(normalizeEntity);
  }
  if (data && typeof data === "object") {
    return normalizeEntity(data);
  }
  return data;
}

export const api = {
  // CRM
  getContacts: (wsId, params = {}) => apiRequest(`/contacts?${new URLSearchParams(params)}`, { workspaceId: wsId }),
  createContact: (wsId, payload) => apiRequest("/contacts", { method: "POST", body: payload, workspaceId: wsId }),
  updateContact: (wsId, id, payload) => apiRequest(`/contacts/${id}`, { method: "PATCH", body: payload, workspaceId: wsId }),

  getCompanies: (wsId) => apiRequest("/companies", { workspaceId: wsId }),
  createCompany: (wsId, payload) => apiRequest("/companies", { method: "POST", body: payload, workspaceId: wsId }),

  getDeals: (wsId) => apiRequest("/deals", { workspaceId: wsId }),
  createDeal: (wsId, payload) => apiRequest("/deals", { method: "POST", body: payload, workspaceId: wsId }),

  getTasks: (wsId) => apiRequest("/tasks", { workspaceId: wsId }),
  createTask: (wsId, payload) => apiRequest("/tasks", { method: "POST", body: payload, workspaceId: wsId }),

  // Inbox
  getConversations: (wsId) => apiRequest("/conversations", { workspaceId: wsId }),
  getMessages: (wsId, convId) => apiRequest(`/conversations/${convId}/messages`, { workspaceId: wsId }),
  sendMessage: (wsId, convId, payload) => apiRequest(`/conversations/${convId}/messages`, { method: "POST", body: payload, workspaceId: wsId }),

  // Appointments
  getAppointments: (wsId) => apiRequest("/appointments", { workspaceId: wsId }),
  createAppointment: (wsId, payload) => apiRequest("/appointments", { method: "POST", body: payload, workspaceId: wsId }),

  // Agents
  getAgents: (wsId) => apiRequest("/agents", { workspaceId: wsId }),
  createAgent: (wsId, payload) => apiRequest("/agents", { method: "POST", body: payload, workspaceId: wsId }),
  updateAgent: (wsId, id, payload) => apiRequest(`/agents/${id}`, { method: "PATCH", body: payload, workspaceId: wsId }),

  // Workflows
  getWorkflows: (wsId) => apiRequest("/workflows", { workspaceId: wsId }),
  createWorkflow: (wsId, payload) => apiRequest("/workflows", { method: "POST", body: payload, workspaceId: wsId }),
};
