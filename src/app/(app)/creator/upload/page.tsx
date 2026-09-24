import { requireRole } from "@/lib/auth";
import { UploadForm } from "./upload-form";

export const metadata = { title: "Upload a product · Builder" };

export default async function UploadPage() {
  await requireRole("CREATOR");
  return <UploadForm />;
}
