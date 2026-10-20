/**
 * What MP · Upload & Provision did with a creator's workflow file, as plain functions.
 *
 * The file is checked against the node whitelist, its credentials are classified by
 * whether they can be kept durably, its inputs are worked out from how the workflow
 * reads its trigger, and the copy that would be stored is written: credentials
 * removed from the nodes, storage nodes moved onto the storage workflow, and the
 * responders turned into pass-throughs. Nothing here creates anything in n8n.
 */

export type NodeVerdict = "allow" | "review" | "deny" | "transform";

export type CredentialRule = {
  durability: string;
  registered: boolean;
  authFlow: string;
  flowReady: boolean;
  note: string;
};

export type UploadInput = {
  file: unknown;
  title: string;
  description: string;
  actionType: "read" | "write";
  creatorId: string;
  templateId: string;
  nodeRules: Record<string, NodeVerdict>;
  credRules: Record<string, CredentialRule>;
  storageWorkflowId: string;
};

type Connection = { node: string; type: string; index: number };
type Connections = Record<string, { main?: Array<Array<Connection> | null> }>;
type Node = {
  id?: string;
  name: string;
  type: string;
  typeVersion?: number;
  position?: [number, number];
  parameters?: Record<string, unknown>;
  credentials?: Record<string, unknown>;
  webhookId?: string;
};

export type UploadVerdict = {
  ok: boolean;
  errors: string[];
  notes: string[];
  flaggedNodes: string[];
  externalHosts: string[];
  requiredCredentials: string[];
  credentialNodeMap: Record<string, string[]>;
  credentialDurability: "durable" | "blocked";
  blockedCredentials: string[];
  durability: Array<{ type: string; durable: boolean; flow: string; reason: string }>;
  inputSchema: Array<{ name: string; type: string; required?: boolean; system?: boolean }>;
  invocationMode: string;
  inferenceStatus: "confident" | "needs_confirmation";
  nodeCount: number;
  contentHash: string;
  workflowObject: { name: string; nodes: Node[]; connections: Connections };
};

const SCHEDULE_TYPES = ["n8n-nodes-base.scheduleTrigger", "n8n-nodes-base.cron", "n8n-nodes-base.interval"];
const ON_DEMAND_TYPES = [
  "n8n-nodes-base.webhook",
  "n8n-nodes-base.formTrigger",
  "@n8n/n8n-nodes-langchain.chatTrigger",
  "n8n-nodes-base.manualTrigger",
  "n8n-nodes-base.executeWorkflowTrigger",
];
const RESPONDER_TYPES = ["n8n-nodes-base.respondToWebhook", "n8n-nodes-base.form", "@n8n/n8n-nodes-langchain.chat"];
const STORAGE_TYPES = ["n8n-nodes-base.googleDrive", "n8n-nodes-base.awsS3", "n8n-nodes-base.s3"];
const EWT = "n8n-nodes-base.executeWorkflowTrigger";
const IGNORED_FIELDS = ["submittedAt", "formMode", "action", "webhookUrl", "executionMode"];
const DANGEROUS_CODE = ["require(", "process.", "child_process", "$env", "eval(", "Function("];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isTrigger = (type: string) => /trigger$/i.test(type) || SCHEDULE_TYPES.includes(type) || type === "n8n-nodes-base.webhook";

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => strings(v, out));
  return out;
}

function namedPrefix(name: string): string {
  return `\\$\\(\\s*['"]${escapeRe(name)}['"]\\s*\\)\\.(?:item|first\\(\\)|last\\(\\)|all\\(\\)\\[\\d+\\])\\.json`;
}

function mapStrings(value: unknown, fn: (text: string) => string): unknown {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)]));
  }
  return value;
}

function parsePath(path: string): string[] {
  const segments: string[] = [];
  const re = /\.([A-Za-z_$][\w$]*)|\[\s*['"]([^'"]+)['"]\s*\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path)) !== null) segments.push(m[1] ?? m[2]);
  return segments;
}

/** FNV-1a over the stored workflow, so an unchanged file is recognised as one. */
function hashOf(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function renameTarget(connections: Connections, from: string, to: string) {
  for (const source of Object.values(connections)) {
    for (const branch of source.main ?? []) {
      for (const edge of branch ?? []) if (edge.node === from) edge.node = to;
    }
  }
}

function durabilityOf(
  type: string,
  rule: CredentialRule | undefined,
): { durable: boolean; flow: string; reason: string } {
  if (!rule) return { durable: false, flow: "unknown", reason: "نوع حساب غير معتمد في المنصة بعد" };
  const flow = rule.authFlow !== "" ? rule.authFlow : /oauth/i.test(type) ? "oauth" : "secret";
  if (flow === "oauth") {
    if (rule.registered && rule.flowReady) return { durable: true, flow, reason: "تطبيق المنصة مسجّل وتدفق الموافقة جاهز" };
    if (rule.registered) return { durable: false, flow, reason: "التطبيق مسجّل لكن تدفق موافقة المستخدم غير جاهز" };
    return { durable: false, flow, reason: rule.note || "يحتاج تسجيل تطبيق المنصة لدى المزوّد" };
  }
  if (rule.durability === "durable") return { durable: true, flow, reason: rule.note || "مفتاح ثابت" };
  return { durable: false, flow, reason: rule.note || "غير مستدام" };
}

export function validateUpload(input: UploadInput): UploadVerdict {
  const errors: string[] = [];
  const notes: string[] = [];
  const flagged: string[] = [];
  const hosts: string[] = [];
  let lowConfidence = false;

  const raw = (input.file ?? null) as { nodes?: Node[]; connections?: Connections } | null;
  if (!raw || typeof raw !== "object") errors.push("الملف ليس JSON صالحاً");
  const sourceNodes = raw && Array.isArray(raw.nodes) ? raw.nodes : [];
  if (sourceNodes.length === 0) errors.push("الملف لا يحتوي على عقد (nodes)");

  let nodes: Node[] = structuredClone(sourceNodes);
  const connections: Connections = structuredClone(raw?.connections ?? {});

  const credNodeMap: Record<string, string[]> = {};
  const creds: string[] = [];
  for (const node of nodes) {
    const verdict = input.nodeRules[node.type];
    if (verdict === "deny") errors.push(`عقدة ممنوعة: ${node.type}`);
    else if (verdict === "review") flagged.push(node.type);

    const isStorage = STORAGE_TYPES.includes(node.type);
    if (node.credentials) {
      if (!isStorage) {
        const keys = Object.keys(node.credentials);
        credNodeMap[node.name] = keys;
        creds.push(...keys);
      }
      delete node.credentials;
    }
    delete node.webhookId;

    for (const text of strings(node.parameters ?? {})) {
      const host = text.match(/https?:\/\/([^/?#\s"'{}]+)/i);
      if (host) hosts.push(host[1]);
      if (/(^|[^\w.])(localhost|127\.0\.0\.1|0\.0\.0\.0|169\.254\.|10\.\d+\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(text)) {
        flagged.push("host:internal");
      }
      if (/YOUR_[A-Z0-9_]*KEY|YOUR_API_KEY|<\s*insert|replace[_-]?me|xxx-xxx-xxx|sk-YOUR|INSERT_YOUR/i.test(text)) {
        flagged.push("placeholder-secret");
        lowConfidence = true;
      }
    }
    const code = (node.parameters as { jsCode?: unknown } | undefined)?.jsCode;
    if (typeof code === "string") {
      for (const word of DANGEROUS_CODE) if (code.includes(word)) flagged.push(`code:${word}`);
    }
  }

  const triggers = nodes.filter((n) => isTrigger(n.type));
  const onDemand = triggers.filter((n) => ON_DEMAND_TYPES.includes(n.type));
  const scheduled = triggers.filter((n) => SCHEDULE_TYPES.includes(n.type));
  const events = triggers.filter(
    (n) => !ON_DEMAND_TYPES.includes(n.type) && !SCHEDULE_TYPES.includes(n.type) && n.type !== "n8n-nodes-base.errorTrigger",
  );

  if (nodes.length > 0 && triggers.length === 0) errors.push("القالب لا يحتوي على مشغّل");
  if (onDemand.length > 1) {
    errors.push(`القالب يحتوي أكثر من مشغّل استدعاء واحد: ${onDemand.map((n) => n.name).join(", ")}`);
  }

  const modes: string[] = [];
  if (onDemand.length > 0) modes.push("on_demand");
  if (scheduled.length > 0) modes.push("scheduled");
  if (events.length > 0) modes.push("event");

  let inputSchema: UploadVerdict["inputSchema"] = [];
  if (onDemand.length === 1) {
    const trigger = onDemand[0];
    const params = (trigger.parameters ?? {}) as Record<string, unknown>;
    const explicit = trigger.type === EWT && params.inputSource === "workflowInputs";

    const children: string[] = [];
    for (const branch of connections[trigger.name]?.main ?? []) {
      for (const edge of branch ?? []) if (!children.includes(edge.node)) children.push(edge.node);
    }

    const named = (name: string) => new RegExp(`${namedPrefix(name)}((?:\\.[A-Za-z_$][\\w$]*|\\[\\s*['"][^'"]+['"]\\s*\\])+)`, "g");
    const direct = /\$json((?:\.[A-Za-z_$][\w$]*|\[\s*['"][^'"]+['"]\s*\])+)/g;
    const inputRef = /\$input\.(?:item|first\(\)|last\(\))\.json((?:\.[A-Za-z_$][\w$]*|\[\s*['"][^'"]+['"]\s*\])+)/g;
    const dynamic = /Object\.(?:keys|entries|values)\(\s*\$json|JSON\.stringify\(\s*\$json\s*\)|\$json\[\s*[^'"\s\]]|\$input\.all\(\)/;

    const refs: string[][] = [];
    for (const node of nodes) {
      if (node.name === trigger.name) continue;
      const isChild = children.includes(node.name);
      for (const text of strings(node.parameters ?? {})) {
        for (const m of text.matchAll(named(trigger.name))) refs.push(parsePath(m[1]));
        if (isChild) {
          for (const m of text.matchAll(direct)) refs.push(parsePath(m[1]));
          for (const m of text.matchAll(inputRef)) refs.push(parsePath(m[1]));
          if (dynamic.test(text)) lowConfidence = true;
        }
      }
    }

    const fields = new Map<string, { name: string; type: string; required?: boolean; system?: boolean }>();
    const addField = (name: string | undefined, type: string, extra: Record<string, unknown> = {}) => {
      if (name && !fields.has(name)) fields.set(name, { name, type, ...extra });
    };

    if (trigger.type === "n8n-nodes-base.formTrigger") {
      const values = ((params.formFields as { values?: Array<Record<string, unknown>> } | undefined)?.values ?? []);
      for (const v of values) {
        const name = (v.fieldName ?? v.fieldLabel) as string | undefined;
        addField(name, v.fieldType === "number" ? "number" : "string", { required: v.requiredField === true });
      }
    } else if (trigger.type === "@n8n/n8n-nodes-langchain.chatTrigger") {
      addField("chatInput", "string", { required: true });
      addField("sessionId", "string", { system: true });
    } else if (trigger.type === EWT && explicit) {
      const values = (params.workflowInputs as { values?: Array<{ name: string; type?: string }> } | undefined)?.values ?? [];
      for (const v of values) {
        const extra = v.name === "sessionId" ? { system: true } : v.name === "chatInput" ? { required: true } : {};
        addField(v.name, v.type ?? "string", extra);
      }
    }

    if (!explicit) {
      for (const segments of refs) {
        if (segments.length === 0) {
          lowConfidence = true;
          continue;
        }
        let name = segments[0];
        if (trigger.type === "n8n-nodes-base.webhook") {
          if (name === "body" || name === "query") {
            if (segments.length < 2) {
              lowConfidence = true;
              continue;
            }
            name = segments[1];
          } else if (name === "headers" || name === "params") {
            notes.push(`القالب يقرأ ${name} من الطلب ولا مقابل لها عند الاستخدام`);
            lowConfidence = true;
            continue;
          }
        }
        if (IGNORED_FIELDS.includes(name)) continue;
        addField(name, "string");
      }
    }

    if (trigger.type === "n8n-nodes-base.webhook") {
      const body = new RegExp(`(${namedPrefix(trigger.name)})(?:\\.(?:body|query)|\\[\\s*['"](?:body|query)['"]\\s*\\])`, "g");
      const directBody = /(\$json|\$input\.(?:item|first\(\)|last\(\))\.json)(?:\.(?:body|query)|\[\s*['"](?:body|query)['"]\s*\])/g;
      for (const node of nodes) {
        if (node.name === trigger.name) continue;
        const isChild = children.includes(node.name);
        node.parameters = mapStrings(node.parameters ?? {}, (text) => {
          const out = text.replace(body, "$1");
          return isChild ? out.replace(directBody, "$1") : out;
        }) as Record<string, unknown>;
      }
    }

    inputSchema = [...fields.values()];
    if (!explicit) {
      const index = nodes.findIndex((n) => n.name === trigger.name);
      nodes[index] = {
        id: trigger.id,
        name: trigger.name,
        type: EWT,
        typeVersion: 1.1,
        position: trigger.position ?? [0, 0],
        parameters: inputSchema.length > 0
          ? {
              inputSource: "workflowInputs",
              workflowInputs: {
                values: inputSchema.map((f) => ({
                  name: f.name,
                  type: f.type === "number" || f.type === "boolean" ? f.type : "string",
                })),
              },
            }
          : { inputSource: "passthrough" },
      };
      if (trigger.type !== EWT) notes.push(`استُبدل المشغّل ${trigger.name} (${trigger.type}) بمشغّل استدعاء من المحادثة`);
    }
  }

  nodes = nodes.map((node) => {
    if (!RESPONDER_TYPES.includes(node.type)) return node;
    notes.push(`حُوّلت عقدة الرد ${node.name} إلى عقدة تمرير`);
    return { id: node.id, name: node.name, type: "n8n-nodes-base.noOp", typeVersion: 1, position: node.position ?? [0, 0], parameters: {} };
  });

  const added: Node[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (!STORAGE_TYPES.includes(node.type)) continue;
    const params = (node.parameters ?? {}) as Record<string, unknown>;
    const isDrive = node.type === "n8n-nodes-base.googleDrive";
    const resource = (params.resource as string) ?? "file";
    const operation = (params.operation as string) ?? "upload";
    if (!params.operation) lowConfidence = true;

    let op: "put" | "get" | "delete" | "list" | null = null;
    if (resource === "file" && operation === "upload") op = "put";
    else if (resource === "file" && operation === "download") op = "get";
    else if (resource === "file" && (operation === (isDrive ? "deleteFile" : "delete"))) op = "delete";
    else if (resource === "file" && operation === "getAll") op = "list";
    else if (isDrive && resource === "fileFolder" && operation === "search") op = "list";

    if (!op) {
      errors.push(`عملية تخزين غير قابلة للتحويل في العقدة ${node.name} (${resource}/${operation})`);
      continue;
    }

    const pos: [number, number] = node.position ?? [0, 0];
    const storage = (name: string, at: [number, number], operationName: string, path: string, content: string, mime: string): Node => ({
      id: `mp-st-${Math.random().toString(36).slice(2, 10)}`,
      name,
      type: "n8n-nodes-base.executeWorkflow",
      typeVersion: 1.3,
      position: at,
      parameters: {
        source: "database",
        workflowId: { __rl: true, mode: "id", value: input.storageWorkflowId },
        mode: "each",
        options: { waitForSubWorkflow: true },
        workflowInputs: {
          mappingMode: "defineBelow",
          value: { installationId: "__MP_INSTALLATION_ID__", operation: operationName, path, content, mimeType: mime },
          matchingColumns: [],
          attemptToConvertTypes: false,
          convertFieldsToString: true,
        },
      },
    });

    const binaryProp = (params.binaryPropertyName as string) || "data";
    const pathOf = (value: unknown, fallback: string) => {
      const text = typeof value === "string" ? value : "";
      return text === "" ? fallback : text;
    };

    if (op === "put") {
      const encodeName = `${node.name} (encode)`;
      const encode = `const prop = ${JSON.stringify(binaryProp)};
const bin = $input.item.binary && $input.item.binary[prop];
let content = ""; let mime = "application/octet-stream"; let fname = "";
if (bin) { const buf = await this.helpers.getBinaryDataBuffer($itemIndex, prop); content = buf.toString("base64"); mime = bin.mimeType || mime; fname = bin.fileName || ""; }
return { json: Object.assign({}, $input.item.json, { __mpContent: content, __mpMime: mime, __mpFileName: fname }) };`;
      renameTarget(connections, node.name, encodeName);
      connections[encodeName] = { main: [[{ node: node.name, type: "main", index: 0 }]] };
      nodes[i] = storage(node.name, pos, "put", pathOf(isDrive ? params.name : params.fileName, "={{ $json.__mpFileName }}"), "={{ $json.__mpContent }}", "={{ $json.__mpMime }}");
      added.push({
        id: `mp-cd-${Math.random().toString(36).slice(2, 10)}`,
        name: encodeName,
        type: "n8n-nodes-base.code",
        typeVersion: 2,
        position: [pos[0] - 220, pos[1] + 160],
        parameters: { mode: "runOnceForEachItem", language: "javaScript", jsCode: encode },
      });
    } else if (op === "get") {
      const storageName = `${node.name} (storage)`;
      if (isDrive) {
        lowConfidence = true;
        notes.push(`العقدة ${node.name} تشير لملف بمعرّف Drive، ويجب التأكد من المسار`);
      }
      const decode = `const r = $input.item.json;
if (!r.ok) { return { json: r }; }
const fname = String(r.path || "file").split("/").pop();
const data = await this.helpers.prepareBinaryData(Buffer.from(String(r.content || ""), "base64"), fname, r.mimeType || undefined);
return { json: { ok: true, path: r.path, size: r.size, mimeType: r.mimeType }, binary: { ${JSON.stringify(binaryProp)}: data } };`;
      renameTarget(connections, node.name, storageName);
      connections[storageName] = { main: [[{ node: node.name, type: "main", index: 0 }]] };
      added.push(storage(storageName, [pos[0] - 220, pos[1] + 160], "get", pathOf(isDrive ? params.fileId : params.fileKey, ""), "", ""));
      nodes[i] = {
        id: node.id,
        name: node.name,
        type: "n8n-nodes-base.code",
        typeVersion: 2,
        position: pos,
        parameters: { mode: "runOnceForEachItem", language: "javaScript", jsCode: decode },
      };
    } else {
      const path = op === "delete" ? pathOf(isDrive ? params.fileId : params.fileKey, "") : "";
      if (op === "delete" && isDrive) lowConfidence = true;
      nodes[i] = storage(node.name, pos, op, path, "", "");
    }
    flagged.push(`storage:${op}`);
    notes.push(`حُوّلت العقدة ${node.name} إلى طبقة التخزين (${op})`);
  }
  nodes = [...nodes, ...added];

  const uniqueCreds = [...new Set(creds)];
  const durability = uniqueCreds.map((type) => ({ type, ...durabilityOf(type, input.credRules[type]) }));
  const blocked = durability.filter((d) => !d.durable).map((d) => d.type);

  const cleaned = {
    name: `[TPL] ${input.title} (${input.templateId})`,
    nodes,
    connections,
    settings: {
      executionOrder: "v1",
      saveDataSuccessExecution: "none",
      saveDataErrorExecution: "all",
      executionTimeout: 300,
      timezone: "Asia/Riyadh",
      callerPolicy: "workflowsFromSameOwner",
      availableInMCP: true,
    },
  };

  return {
    ok: errors.length === 0,
    errors,
    notes: [...new Set(notes)],
    flaggedNodes: [...new Set(flagged)],
    externalHosts: [...new Set(hosts)],
    requiredCredentials: uniqueCreds,
    credentialNodeMap: credNodeMap,
    credentialDurability: blocked.length === 0 ? "durable" : "blocked",
    blockedCredentials: blocked,
    durability,
    inputSchema,
    invocationMode: modes.join(","),
    inferenceStatus: lowConfidence ? "needs_confirmation" : "confident",
    nodeCount: nodes.length,
    contentHash: hashOf(JSON.stringify({ n: nodes, c: connections })),
    workflowObject: cleaned,
  };
}
