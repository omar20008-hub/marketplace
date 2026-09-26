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
 * One interface over the five workflows the platform calls, plus the two REST
 * endpoints it needs. Publish Sync and Lifecycle Sweep are absent on purpose:
 * nobody calls them, they run on a schedule inside n8n.
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
}
