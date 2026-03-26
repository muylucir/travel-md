import AppLayout from "@/components/layout/AppLayout";
import S3EtlPage from "@/components/graph-etl/S3EtlPage";

export default function GraphEtlPage() {
  return (
    <AppLayout contentType="default">
      <S3EtlPage />
    </AppLayout>
  );
}
