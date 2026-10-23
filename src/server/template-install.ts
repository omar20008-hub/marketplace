import { randomUUID } from "node:crypto";

/**
 * What MP · Install Template did with a published template, as plain functions:
 * deciding which credentials are still missing, and turning the template's nodes
 * into one person's copy. No n8n calls here; the caller creates the credentials and
 * the workflow.
 */

export type CredentialRule = { authFlow: string; flowReady: boolean; registered: boolean };

export type CredentialPlan = {
  credentialType: string;
  credentialName: string;
  credentialData: string;
  role: "template" | "knowledge";
};

export type CredentialPlanResult =
  | { ready: true; plans: CredentialPlan[] }
  | { ready: false; missing: string[]; needsConsent: string[] };

const KNOWLEDGE_PLACEHOLDER = "__MP_KNOWLEDGE_KEY__";
const SCHEDULE_TYPES = ["n8n-nodes-base.scheduleTrigger", "n8n-nodes-base.cron", "n8n-nodes-base.interval"];

function isSecretObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Which credentials the person still has to supply. OAuth types need a consent flow
 * the platform does not run yet, so they are reported rather than planned.
 */
export function planCredentials({
  userId,
  templateId,
  requiredCredentials,
  rules,
  supplied,
  usesKnowledgeKey,
  knowledgeKey,
}: {
  userId: string;
  templateId: string;
  requiredCredentials: string;
  rules: Record<string, CredentialRule>;
  supplied: Record<string, unknown>;
  usesKnowledgeKey: boolean;
  knowledgeKey: string | null;
}): CredentialPlanResult {
  const types: string[] = [];
  for (const raw of requiredCredentials.split(",")) {
    const type = raw.trim();
    if (type !== "" && !types.includes(type)) types.push(type);
  }

  const plans: CredentialPlan[] = [];
  const missing: string[] = [];
  const needsConsent: string[] = [];

  for (const type of types) {
    const rule = rules[type];
    const flow = rule && rule.authFlow !== "" ? rule.authFlow : /oauth/i.test(type) ? "oauth" : "secret";
    if (flow === "oauth") {
      needsConsent.push(type);
      continue;
    }
    const data = supplied[type];
    if (!isSecretObject(data)) {
      missing.push(type);
      continue;
    }
    plans.push({
      credentialType: type,
      credentialName: `u_${userId}_${templateId}_${type}`,
      credentialData: JSON.stringify(data),
      role: "template",
    });
  }

  if (needsConsent.length > 0 || missing.length > 0) {
    return { ready: false, missing: [...missing, ...needsConsent], needsConsent };
  }

  if (usesKnowledgeKey && knowledgeKey) {
    plans.push({
      credentialType: "httpHeaderAuth",
      credentialName: `u_${userId}_${templateId}_knowledge`,
      credentialData: JSON.stringify({ name: "Authorization", value: `Bearer ${knowledgeKey}` }),
      role: "knowledge",
    });
  }

  return { ready: true, plans };
}

export type CreatedCredential = { id: string; name: string };

/**
 * One person's copy of a template. The node rewrite is the same as the n8n workflow:
 * placeholders filled in, webhook ids regenerated, credentials bound by node, the
 * schedule set, and the knowledge key moved out of the nodes into its credential.
 */
export function buildInstanceWorkflow({
  userId,
  templateId,
  installationId,
  platformUrl,
  schedule,
  nodes: templateNodes,
  connections,
  credentialNodeMap,
  credentials,
  knowledgeCredential,
}: {
  userId: string;
  templateId: string;
  installationId: string;
  platformUrl: string;
  schedule: string;
  nodes: Array<Record<string, unknown>>;
  connections: Record<string, unknown>;
  credentialNodeMap: string | null;
  credentials: Record<string, CreatedCredential>;
  knowledgeCredential: CreatedCredential | null;
}) {
  let nodesText = JSON.stringify(templateNodes).split("__MP_INSTALLATION_ID__").join(installationId);
  if (platformUrl) nodesText = nodesText.split("__MP_PLATFORM_URL__").join(platformUrl);
  const nodes = JSON.parse(nodesText) as Array<Record<string, unknown> & { name: string; type: string }>;

  let credNodeMap: Record<string, string[]> = {};
  try {
    credNodeMap = JSON.parse(credentialNodeMap ?? "{}") as Record<string, string[]>;
  } catch {
    credNodeMap = {};
  }
  if (Object.keys(credNodeMap).length === 0) {
    for (const node of templateNodes as Array<{ name: string; credentials?: Record<string, unknown> }>) {
      if (node.credentials) credNodeMap[node.name] = Object.keys(node.credentials);
    }
  }

  const trimmedSchedule = schedule.trim();

  for (const node of nodes) {
    delete node.credentials;
    delete node.webhookId;
    const isTrigger = /trigger$/i.test(node.type) || node.type === "n8n-nodes-base.webhook";
    if (isTrigger && !SCHEDULE_TYPES.includes(node.type) && node.type !== "n8n-nodes-base.executeWorkflowTrigger") {
      node.webhookId = randomUUID();
    }

    const keys = credNodeMap[node.name];
    if (keys) {
      const bound: Record<string, CreatedCredential> = {};
      for (const key of keys) if (credentials[key]) bound[key] = credentials[key];
      if (Object.keys(bound).length > 0) node.credentials = bound;
    }

    if (trimmedSchedule !== "" && node.type === "n8n-nodes-base.scheduleTrigger") {
      node.parameters = {
        ...((node.parameters as Record<string, unknown>) ?? {}),
        rule: { interval: [{ field: "cronExpression", expression: trimmedSchedule }] },
      };
    }

    const parameters = (node.parameters as Record<string, unknown>) ?? {};
    const headers = parameters.headerParameters as { parameters?: Array<{ value?: unknown }> } | undefined;
    const headerList = headers && Array.isArray(headers.parameters) ? headers.parameters : null;
    if (headerList && JSON.stringify(headerList).includes(KNOWLEDGE_PLACEHOLDER)) {
      if (!knowledgeCredential) {
        throw new Error("Template needs a knowledge key but none was provided for this installation.");
      }
      const rest = headerList.filter((header) => !String(header.value ?? "").includes(KNOWLEDGE_PLACEHOLDER));
      if (rest.length > 0) {
        parameters.headerParameters = { parameters: rest };
      } else {
        delete parameters.headerParameters;
        parameters.sendHeaders = false;
      }
      parameters.authentication = "genericCredentialType";
      parameters.genericAuthType = "httpHeaderAuth";
      node.parameters = parameters;
      node.credentials = { ...((node.credentials as Record<string, CreatedCredential>) ?? {}), httpHeaderAuth: knowledgeCredential };
    }
  }

  // Fail closed: the key must never end up inline anywhere else in the copy.
  if (JSON.stringify(nodes).includes(KNOWLEDGE_PLACEHOLDER)) {
    throw new Error("__MP_KNOWLEDGE_KEY__ is only supported in an HTTP header; found it elsewhere in the template.");
  }

  return {
    name: `u_${userId}_${templateId}`,
    nodes,
    connections,
    settings: {
      executionOrder: "v1",
      saveDataSuccessExecution: "none",
      saveDataErrorExecution: "all",
      executionTimeout: 300,
      timezone: "Asia/Riyadh",
      callerPolicy: "workflowsFromSameOwner",
    },
  };
}
