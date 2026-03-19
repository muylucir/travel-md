import AppLayout from "@/components/layout/AppLayout";
import UploadWizard from "@/components/graph-upload/UploadWizard";

export default function GraphUploadPage() {
  return (
    <AppLayout contentType="wizard">
      <UploadWizard />
    </AppLayout>
  );
}
