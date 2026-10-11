import "server-only";
import type {
  ApproveTemplateInput,
  ApproveTemplateOutput,
  ChatInput,
  ChatOutput,
  CredentialSchema,
  DispatchInput,
  DispatchOutput,
  InstallInput,
  InstallOutput,
  RejectTemplateInput,
  RejectTemplateOutput,
  StorageInput,
  StorageOutput,
  TemplateRow,
  UninstallInput,
  UninstallOutput,
  UploadInput,
  UploadOutput,
} from "./contracts";

/**
 * One interface over the five workflows the platform calls, plus the REST
 * endpoints it needs. Publish Sync is absent on purpose: nobody calls it, it runs
 * on a schedule inside n8n.
 */
export interface N8nDriver {
  readonly name: "mock" | "live";

  upload(input: UploadInput): Promise<UploadOutput>;
  install(input: InstallInput): Promise<InstallOutput>;
  uninstall(input: UninstallInput): Promise<UninstallOutput>;
  dispatch(input: DispatchInput): Promise<DispatchOutput>;
  storage(input: StorageInput): Promise<StorageOutput>;
  chat(input: ChatInput): Promise<ChatOutput>;

  /** Publishes a reviewed template inside n8n itself — the platform cannot do this on its own. */
  approveTemplate(input: ApproveTemplateInput): Promise<ApproveTemplateOutput>;
  rejectTemplate(input: RejectTemplateInput): Promise<RejectTemplateOutput>;

  /** Drives the generated connection form instead of a raw JSON textarea. */
  credentialSchema(credentialType: string): Promise<CredentialSchema | null>;

  /** Pull of mp_templates, for the marketplace mirror. */
  listTemplates(): Promise<TemplateRow[]>;

  /**
   * Switches one user's copy off in n8n. ok=false means n8n refused or could not be
   * reached; the caller still records the installation as disabled.
   */
  deactivateInstance(instanceWorkflowId: string): Promise<{ ok: boolean }>;
}
